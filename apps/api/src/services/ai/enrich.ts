import { dbForUser } from "@inbox-copilot/db";
import { aiEnrichJobId, aiEnrichQueue, type AiEnrichJob } from "../../lib/queues.js";
import type { AiEnrichResult } from "@inbox-copilot/shared";
import { AiCapExceededError, AiDisabledError, NotFoundError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { isAbortError } from "../../lib/retry.js";
import { classifyMessage } from "./classify.js";
import { summarizeThread } from "./summarize.js";
import { loadAiSettings } from "./usage.js";
import { MESSAGE_PROMPT_SELECT, type MessageForPrompt } from "./content.js";

/**
 * The `ai.enrich` pipeline (§5): classify a new message, summarize its thread when
 * the thread is worth summarizing, and denormalize the result onto `Thread` for the
 * list view.
 *
 * One message per job. That keeps a failure small (one message, not a mailbox), lets
 * the job id dedupe repeated enqueues of the same message, and means the daily cap is
 * enforced at the granularity it is expressed in — calls.
 */


export interface EnrichInput {
  userId: string;
  mailAccountId: string;
  messageId: string;
}

export interface EnrichHooks {
  signal?: AbortSignal;
}

interface LoadedMessage {
  message: MessageForPrompt;
  threadId: string;
  mailboxAddress: string;
}

/**
 * Loads the message through the tenancy client.
 *
 * This is also the ownership check for everything downstream: `AiClassification` and
 * `AiSummary` are reached through relations, and the tenancy extension cannot narrow
 * an `upsert`'s unique `where` (see packages/db/src/tenancy.ts) — so the guarantee
 * that we are writing AI rows for our own user comes from this read succeeding.
 * Nothing in this file writes for a message it did not load here.
 */
async function loadMessage(input: EnrichInput): Promise<LoadedMessage> {
  const row = await dbForUser(input.userId).message.findFirst({
    where: { id: input.messageId, mailAccountId: input.mailAccountId },
    select: {
      ...MESSAGE_PROMPT_SELECT,
      threadId: true,
      mailAccount: { select: { emailAddress: true } },
    },
  });

  if (!row) throw new NotFoundError("Message not found");

  const { threadId, mailAccount, ...message } = row;
  return {
    message: message as MessageForPrompt,
    threadId,
    mailboxAddress: mailAccount.emailAddress,
  };
}

/**
 * Whether this message is the newest in its thread.
 *
 * The denormalized `Thread.category`/`priority` describe the thread's current state,
 * so only the newest message may set them. Without this check, enriching a backfill
 * in arrival order would let a three-month-old message overwrite the classification
 * of the reply that came yesterday.
 */
async function isNewestInThread(
  userId: string,
  threadId: string,
  messageId: string,
): Promise<boolean> {
  const newest = await dbForUser(userId).message.findFirst({
    where: { threadId },
    orderBy: { sentAt: "desc" },
    select: { id: true },
  });
  return newest?.id === messageId;
}

/** Thread messages, oldest first, for the summarizer. */
async function loadThreadMessages(
  userId: string,
  threadId: string,
): Promise<MessageForPrompt[]> {
  const rows = await dbForUser(userId).message.findMany({
    where: { threadId },
    orderBy: { sentAt: "asc" },
    select: MESSAGE_PROMPT_SELECT,
  });
  return rows as MessageForPrompt[];
}

/**
 * Enriches one message.
 *
 * Cap and disabled-AI are *outcomes*, not errors: they are reported in `skipped` and
 * the job completes. Failing the job instead would put it through five BullMQ
 * attempts against a cap that cannot clear before tomorrow, and each attempt would
 * re-read the row to discover the same thing.
 */
export async function runEnrich(
  input: EnrichInput,
  hooks: EnrichHooks = {},
): Promise<AiEnrichResult> {
  const log = logger.child({
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    messageId: input.messageId,
  });

  const result: AiEnrichResult = {
    messageId: input.messageId,
    classified: false,
    summarized: false,
    skipped: [],
  };

  const settings = await loadAiSettings(input.userId);
  if (!settings.aiEnabled) {
    log.debug("ai disabled for user; nothing enriched");
    result.skipped.push("disabled");
    return result;
  }

  const { message, threadId, mailboxAddress } = await loadMessage(input);

  try {
    if (settings.autoCategorize) {
      const classified = await classifyMessage({
        userId: input.userId,
        mailAccountId: input.mailAccountId,
        mailboxAddress,
        message,
        settings,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      });

      result.classified = true;
      if (classified.fromCache) result.skipped.push("classify-cache");

      /*
       * Denormalized onto the thread only when this is its newest message (§5: fast
       * list queries). `threatLevel` is not touched — phase 9 owns it, and a default
       * of UNKNOWN is the honest value until the deterministic layers exist.
       */
      if (await isNewestInThread(input.userId, threadId, message.id)) {
        await dbForUser(input.userId).thread.update({
          where: { id: threadId },
          data: {
            category: classified.classification.category,
            priority: classified.classification.priority,
            priorityScore: classified.classification.priorityScore,
            needsReply: classified.classification.needsReply,
            language: classified.classification.language,
          },
        });
      }
    } else {
      result.skipped.push("categorize-off");
    }

    if (settings.autoSummarize) {
      const messages = await loadThreadMessages(input.userId, threadId);
      const summarized = await summarizeThread({
        userId: input.userId,
        threadId,
        mailboxAddress,
        messages,
        settings,
        ...(hooks.signal ? { signal: hooks.signal } : {}),
      });

      if (summarized.summary !== null) {
        result.summarized = true;
        if (summarized.fromCache) result.skipped.push("summary-cache");
      } else if (summarized.skipped !== undefined) {
        result.skipped.push(summarized.skipped);
      }
    } else {
      result.skipped.push("summarize-off");
    }
  } catch (error) {
    if (error instanceof AiCapExceededError) {
      // Whatever was done before the cap hit stands; the rest is left undone. Phase
      // 5's Batch API backfill is what sweeps up messages skipped this way.
      log.warn({ ...(error.details as object) }, "enrich stopped at the daily cap");
      result.skipped.push("cap");
      return result;
    }
    if (error instanceof AiDisabledError) {
      result.skipped.push("disabled");
      return result;
    }
    if (isAbortError(error)) {
      log.warn("enrich cancelled");
    }
    throw error;
  }

  log.info(
    { classified: result.classified, summarized: result.summarized, skipped: result.skipped },
    "message enriched",
  );
  return result;
}

/**
 * Queues enrichment for the given messages.
 *
 * Called by the sync engine *after* the thread transaction commits — a job that
 * starts before the rows exist would read nothing and fail, and enqueueing inside
 * the transaction would publish work that a rollback then invalidates — and by the
 * sweep, for messages that have no classification yet.
 *
 * The job id is the message id, which dedupes *pending* work: a resync, or a user
 * mashing a button, collapses onto the job already queued instead of paying for a
 * second classification. It must not dedupe work that has already finished, though.
 * BullMQ keeps completed and failed jobs for a while, and an id it still holds is an
 * id it silently refuses to re-add — which would make the cap sweep a no-op for
 * exactly the ten minutes after a capped run, the moment it is most needed. So a
 * finished job's id is cleared first, and only pending ones are left alone.
 *
 * Returns the number of jobs actually added. Failures are logged, never thrown: a
 * backfill that has correctly stored a page of mail must not be failed because Redis
 * hiccuped on the follow-up work — the messages are on disk, and the sweep will find
 * anything that has no classification.
 */
export async function enqueueEnrichment(input: {
  userId: string;
  mailAccountId: string;
  messageIds: readonly string[];
}): Promise<number> {
  if (input.messageIds.length === 0) return 0;

  const log = logger.child({ userId: input.userId, mailAccountId: input.mailAccountId });
  const queue = aiEnrichQueue();

  try {
    const jobs: { name: string; data: AiEnrichJob; opts: { jobId: string } }[] = [];
    let pending = 0;

    for (const messageId of input.messageIds) {
      const jobId = aiEnrichJobId(messageId);
      const existing = await queue.getJob(jobId);

      if (existing) {
        const state = await existing.getState();
        if (state === "waiting" || state === "active" || state === "delayed") {
          // Already going to happen; adding it again would be a no-op anyway.
          pending += 1;
          continue;
        }
        // Completed or failed: the id is stale and is holding the slot.
        try {
          await existing.remove();
        } catch (error) {
          // A job that cannot be removed (locked by a worker mid-transition) is one
          // whose work is happening regardless.
          log.debug({ err: error, jobId }, "could not clear a finished enrich job");
          pending += 1;
          continue;
        }
      }

      jobs.push({
        name: "enrich",
        data: {
          messageId,
          mailAccountId: input.mailAccountId,
          userId: input.userId,
        } satisfies AiEnrichJob,
        opts: { jobId },
      });
    }

    if (jobs.length > 0) await queue.addBulk(jobs);

    if (pending > 0) {
      log.debug({ queued: jobs.length, pending }, "some enrichment was already queued");
    }
    return jobs.length;
  } catch (error) {
    log.error(
      { err: error, messages: input.messageIds.length },
      "failed to queue ai enrichment",
    );
    return 0;
  }
}
