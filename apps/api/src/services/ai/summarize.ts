import { dbForUser, type Prisma } from "@inbox-copilot/db";
import { aiSummarySchema, type AiSummaryOutput } from "@inbox-copilot/shared";
import { logger } from "../../lib/logger.js";
import { MutexTimeoutError, withMutex } from "../../lib/mutex.js";
import { callStructured } from "./client.js";
import { cachedSummary, threadContentHash } from "./cache.js";
import { needsSummary, threadForPrompt, type MessageForPrompt } from "./content.js";
import { untrustedThreadBlock } from "./prompts.js";
import type { AiSettings } from "./usage.js";

/**
 * Thread summarization (§5). Sonnet, because the output is read by a person.
 *
 * Only runs for threads worth summarizing — three or more messages, or a body over
 * 1500 characters. A two-line exchange does not need a headline and a key-points
 * list; generating one would cost money to tell the user what they can already see.
 *
 * Summarization is also serialized per thread state. The content-hash cache stops a
 * *repeat*, but it cannot stop a *race*: two messages of one thread enrich at the same
 * time, both look for a summary that neither has written yet, and both pay for one.
 * Measured on a real mailbox before this lock: 48 Sonnet calls for 47 rows.
 */

/**
 * Lock lifetime, comfortably over the AI client's 60s request timeout plus the write.
 * A lock that expires mid-call is worse than no lock: the waiter proceeds believing
 * it is alone, which is exactly the duplicate call this exists to prevent.
 */
const LOCK_TTL_MS = 90_000;

/**
 * How long a second message will wait for the first to finish. Longer than the TTL
 * would be pointless; much shorter would give up while the answer is being written.
 */
const LOCK_WAIT_MS = 75_000;

/**
 * Keyed on thread *and* content hash: the same thread state is the work being
 * deduplicated, while a thread that gained a reply is genuinely different work and
 * should not queue behind it.
 */
function summaryLockKey(threadId: string, contentHash: string): string {
  return `ai-summary:${threadId}:${contentHash}`;
}

const TOOL_NAME = "record_summary";
const TOOL_DESCRIPTION =
  "Record the summary of the thread in the untrusted_email blocks. This is the only way to respond.";

export interface SummarizeInput {
  userId: string;
  threadId: string;
  mailboxAddress: string;
  /** Oldest first. */
  messages: readonly MessageForPrompt[];
  settings?: AiSettings;
  signal?: AbortSignal;
  /** Skips the §5 threshold — for a user explicitly asking for a summary. */
  force?: boolean;
}

export interface SummarizeResult {
  summary: AiSummaryOutput | null;
  fromCache: boolean;
  /** Set when nothing was done: "below-threshold". */
  skipped?: string;
  model?: string;
}

/**
 * Summarizes a thread, or returns the cached summary, or declines.
 *
 * The cache key is the hash of the ordered message hashes: a thread whose messages
 * have not changed is never re-summarized, and one that gained a reply always is.
 */
export async function summarizeThread(input: SummarizeInput): Promise<SummarizeResult> {
  if (input.messages.length === 0) {
    return { summary: null, fromCache: false, skipped: "empty-thread" };
  }

  if (input.force !== true && !needsSummary(input.messages)) {
    return { summary: null, fromCache: false, skipped: "below-threshold" };
  }

  const contentHash = threadContentHash(input.messages.map((message) => message.contentHash));

  const hit = await cachedSummary(input.userId, input.threadId, contentHash);
  if (hit) return asCacheHit(hit);

  /*
   * Nothing cached, so this thread state has to be summarized — by exactly one of us.
   * Inside the lock the cache is checked again: a waiter that gets in after the holder
   * finished is looking for work that is already done, and the second check is what
   * turns the race into a cache hit instead of a second call.
   */
  try {
    return await withMutex(
      summaryLockKey(input.threadId, contentHash),
      async () => {
        const raced = await cachedSummary(input.userId, input.threadId, contentHash);
        if (raced) {
          logger.debug(
            { userId: input.userId, threadId: input.threadId },
            "another worker summarized this thread while we waited",
          );
          return asCacheHit(raced);
        }
        return summarizeUncached(input, contentHash);
      },
      {
        ttlMs: LOCK_TTL_MS,
        waitMs: LOCK_WAIT_MS,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
  } catch (error) {
    if (!(error instanceof MutexTimeoutError)) throw error;

    /*
     * The holder is taking longer than the wait allows, or Redis is unavailable. Do
     * the work rather than failing: a duplicate summary costs one call, and the
     * upsert on (threadId, contentHash) means the two cannot become two rows.
     */
    logger.warn(
      { userId: input.userId, threadId: input.threadId },
      "summary lock timed out; summarizing without it",
    );
    const late = await cachedSummary(input.userId, input.threadId, contentHash);
    return late ? asCacheHit(late) : summarizeUncached(input, contentHash);
  }
}

function asCacheHit(cached: {
  headline: string;
  summary: string;
  keyPoints: unknown;
  actionItems: unknown;
  model: string;
}): SummarizeResult {
  return {
    summary: {
      headline: cached.headline,
      summary: cached.summary,
      keyPoints: cached.keyPoints as string[],
      actionItems: cached.actionItems as AiSummaryOutput["actionItems"],
    },
    fromCache: true,
    model: cached.model,
  };
}

/** The call itself. Only ever reached with the thread's lock held, or after it timed out. */
async function summarizeUncached(
  input: SummarizeInput,
  contentHash: string,
): Promise<SummarizeResult> {
  const { data, model } = await callStructured({
    userId: input.userId,
    feature: "summarize",
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    schema: aiSummarySchema,
    userContent: untrustedThreadBlock(threadForPrompt(input.messages, input.mailboxAddress)),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    logContext: { threadId: input.threadId, messages: input.messages.length },
  });

  const fields = {
    model,
    headline: data.headline,
    summary: data.summary,
    keyPoints: data.keyPoints as unknown as Prisma.InputJsonValue,
    actionItems: data.actionItems as unknown as Prisma.InputJsonValue,
  };

  /*
   * Upsert on `(threadId, contentHash)`: the unique key is the pair, so a thread
   * accumulates one row per distinct state rather than overwriting its history. Two
   * workers racing the same thread therefore collide on the key instead of writing
   * two rows for one state.
   */
  await dbForUser(input.userId).aiSummary.upsert({
    where: { threadId_contentHash: { threadId: input.threadId, contentHash } },
    create: { threadId: input.threadId, contentHash, ...fields },
    update: fields,
  });

  return { summary: data, fromCache: false, model };
}
