import { dbForUser } from "@inbox-copilot/db";
import { ConflictError, NotFoundError, SyncCursorExpiredError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { isAbortError, statusOf } from "../lib/retry.js";
import {
  DELTA_DEBOUNCE_MS,
  deltaJobId,
  syncDeltaQueue,
  type DeltaJob,
} from "../lib/queues.js";
import { mailProviderFor } from "../providers/registry.js";
import { enqueueEnrichment } from "./ai/enrich.js";
import { runFollowUpCheck } from "./followUps.js";
import { persistThread } from "./sync.js";
import { startBackfill } from "./sync.js";
import type { MailProvider, RawChange } from "../providers/mailProvider.js";

/**
 * Incremental sync (§4): the job a push notification triggers.
 *
 * The push told us *that* something changed. Everything about *what* changed is read
 * here, over an authenticated connection, starting from the cursor in our own
 * database — so a notification cannot make us skip history, re-read someone else's
 * mailbox, or write anything it made up.
 *
 * Three rules, in the order they matter:
 *
 *   1. **The cursor advances last.** Only after every thread this delta touched has
 *      committed. A crash halfway through therefore costs a replay of a few threads,
 *      and every write is idempotent on `(mailAccountId, providerMessageId)`, so a
 *      replay is a no-op. The reverse order would lose mail silently, which is the
 *      one failure a mail client must not have.
 *   2. **Enrichment is queued only for genuinely new inbound messages.** New, because
 *      a label change re-fetches the whole thread and re-enriching it would pay for
 *      classifications we already hold; inbound, because the user's own sent mail does
 *      not need a priority score, and classifying it would put "needs reply: true" on
 *      the user's own words.
 *   3. **An expired cursor is a re-sync, not an error.** See `runDelta`'s catch.
 */

/** How many changed threads one delta will fetch before deferring the rest. */
const MAX_THREADS_PER_DELTA = 40;

interface DeltaMailbox {
  id: string;
  userId: string;
  provider: "GMAIL" | "OUTLOOK";
  emailAddress: string;
  syncStatus: string;
  syncCursor: string | null;
}

export interface DeltaResult {
  mailAccountId: string;
  /** Threads fetched and re-persisted. */
  threads: number;
  /** Messages written or updated. */
  messages: number;
  /** New inbound messages queued for enrichment. */
  enriched: number;
  /** Provider message ids that are gone provider-side and were removed here. */
  deleted: number;
  cursor: string | null;
  /** Set when nothing was done: "no-changes" | "no-cursor" | "revoked" | "not-gmail". */
  skipped?: string;
  /** Set when this delta could not proceed and recovered another way. */
  recovered?: "backfill";
  /** Follow-up reminders this delta's inbound mail resolved (§9). */
  remindersResolved?: number;
}

/**
 * Loads the mailbox for a delta.
 *
 * Through `dbForUser`, like every other read (rule 4) — the webhook resolved which
 * mailbox by address, but the *authority* to read it comes from this query being
 * scoped to the owning user.
 */
async function loadMailbox(userId: string, mailAccountId: string): Promise<DeltaMailbox> {
  const row = (await dbForUser(userId).mailAccount.findFirst({
    where: { id: mailAccountId },
    select: {
      id: true,
      userId: true,
      provider: true,
      emailAddress: true,
      syncStatus: true,
      syncCursor: true,
    },
  })) as DeltaMailbox | null;

  if (!row) throw new NotFoundError("Mailbox not found");
  return row;
}

/** The threads a change list touches, and the messages it says are gone. */
export function foldChanges(changes: readonly RawChange[]): {
  threadIds: string[];
  deletedMessageIds: string[];
} {
  const threadIds = new Set<string>();
  const deletedMessageIds: string[] = [];

  for (const change of changes) {
    if (change.kind === "deleted") {
      deletedMessageIds.push(change.providerMessageId);
      // Its thread is still refetched: the remaining messages, the count and the
      // snippet all change when one message leaves.
      threadIds.add(change.providerThreadId);
      continue;
    }
    threadIds.add(change.providerThreadId);
  }

  return { threadIds: [...threadIds], deletedMessageIds };
}

/**
 * Runs one incremental sync.
 *
 * Exported for the worker and for tests, which drive it with a stubbed provider.
 */
export async function runDelta(
  job: DeltaJob,
  hooks: { signal?: AbortSignal } = {},
): Promise<DeltaResult> {
  const { userId, mailAccountId } = job;
  const log = logger.child({ userId, mailAccountId, reason: job.reason });
  const db = dbForUser(userId);
  const signal = hooks.signal;

  const result: DeltaResult = {
    mailAccountId,
    threads: 0,
    messages: 0,
    enriched: 0,
    deleted: 0,
    cursor: null,
  };

  const mailbox = await loadMailbox(userId, mailAccountId);
  result.cursor = mailbox.syncCursor;

  if (mailbox.syncStatus === "REVOKED") {
    // Permanent until the user reconnects, so the worker must not retry it.
    throw new ConflictError("Mailbox access was revoked; reconnect it before syncing", {
      mailAccountId,
      needsReconnect: true,
    });
  }

  if (mailbox.provider !== "GMAIL") {
    result.skipped = "not-gmail";
    return result;
  }

  if (mailbox.syncCursor === null) {
    /*
     * No cursor means this mailbox has never completed a backfill — a push that
     * arrives mid-backfill, or before one. There is nothing to be incremental *from*,
     * and inventing a cursor from the notification would skip everything older than
     * it. The backfill is already the right work, and its own job id makes asking
     * again free.
     */
    log.info("delta with no cursor; leaving it to the backfill");
    const started = await startBackfill({ userId, mailAccountId });
    result.skipped = "no-cursor";
    if (started.enqueued) result.recovered = "backfill";
    return result;
  }

  const provider = mailProviderFor(mailbox.provider, {
    mailAccountId,
    userId,
    emailAddress: mailbox.emailAddress,
    ...(signal ? { signal } : {}),
  });

  try {
    const { changes, cursor } = await provider.syncDelta(mailbox.syncCursor);

    if (changes.length === 0) {
      /*
       * A notification with nothing behind it is normal: Gmail publishes for changes we
       * do not model (a label on a draft, a read receipt), and a debounced burst often
       * lands after the sync that already covered it. The cursor still advances, so the
       * next delta starts from here rather than re-reading this window forever.
       */
      await db.mailAccount.update({
        where: { id: mailAccountId },
        data: { syncCursor: cursor, lastSyncedAt: new Date(), syncError: null },
      });
      result.skipped = "no-changes";
      result.cursor = cursor;
      return result;
    }

    const { threadIds, deletedMessageIds } = foldChanges(changes);

    if (deletedMessageIds.length > 0) {
      /*
       * Deleted provider-side, so deleted here. Re-fetching the thread cannot express
       * this: the fetch returns the messages that remain, and our stale row would
       * survive as a message the user deleted and can still see.
       */
      const removed = await db.message.deleteMany({
        where: { mailAccountId, providerMessageId: { in: deletedMessageIds } },
      });
      result.deleted = removed.count;
    }

    const batch = threadIds.slice(0, MAX_THREADS_PER_DELTA);
    const deferred = threadIds.length - batch.length;

    for (const providerThreadId of batch) {
      if (signal?.aborted) break;

      const written = await syncOneThread({
        db,
        provider,
        mailAccountId,
        userId,
        providerThreadId,
      });

      if (written === null) continue; // the whole thread is gone

      result.threads += 1;
      result.messages += written.messages;
      result.enriched += written.enriched;
    }

    /*
     * The cursor moves now — after every thread above has committed — and only to the
     * value the provider reported for the window we just read (§4). When threads were
     * deferred it does **not** move: their changes are inside this window, and
     * advancing past them would drop the ones we did not fetch.
     */
    /*
     * An inbound message on a thread the user is waiting on is the cancellation
     * condition for a follow-up reminder (§9), and this is the earliest honest place to
     * act on it: the messages are committed, so a check run now sees them.
     *
     * Doing it here rather than leaving it to the quarter-hourly job is not an
     * optimization, it is the difference between the feature being usable and not. A
     * reminder that lingers for fifteen minutes after the reply arrived is a reminder
     * the user reads as wrong — and it is the digest's cadence that would then mail
     * them about a thread they have already dealt with. The scheduled check remains the
     * backstop for replies that arrive while this process is down.
     *
     * Scoped to this user and never allowed to fail the delta: the sync's job is mail,
     * and a reminder that resolves fifteen minutes late is a far smaller problem than a
     * sync that reports failure and re-reads a mailbox.
     */
    if (result.messages > 0) {
      try {
        const check = await runFollowUpCheck({ userId });
        if (check.resolved > 0) result.remindersResolved = check.resolved;
      } catch (error) {
        log.warn({ err: error }, "delta wrote mail but the follow-up check failed");
      }
    }

    if (deferred > 0) {
      log.warn(
        { threads: threadIds.length, fetched: batch.length, deferred },
        "delta hit its per-run thread ceiling; cursor held for the next run",
      );
      await enqueueDelta({ userId, mailAccountId, reason: job.reason });
    } else {
      await db.mailAccount.update({
        where: { id: mailAccountId },
        data: {
          syncCursor: cursor,
          lastSyncedAt: new Date(),
          syncError: null,
          // A delta that ran is a mailbox that is working; an earlier ERROR should not
          // outlive the failure that set it.
          ...(mailbox.syncStatus === "ERROR" ? { syncStatus: "ACTIVE" as const } : {}),
        },
      });
      result.cursor = cursor;
    }

    log.info(
      {
        threads: result.threads,
        messages: result.messages,
        enriched: result.enriched,
        deleted: result.deleted,
        cursor: result.cursor,
      },
      "delta sync complete",
    );
    return result;
  } catch (error) {
    if (error instanceof SyncCursorExpiredError) {
      /*
       * The provider no longer has the history we asked for — a watch that lapsed for
       * more than a week, or a long outage. There is no incremental recovery: the
       * cursor is cleared and a full backfill is queued, because a mailbox that cannot
       * catch up must not be left quietly frozen (§4's safety rail).
       */
      log.warn(
        { cursor: mailbox.syncCursor },
        "sync cursor expired; falling back to a backfill",
      );

      await db.mailAccount.update({
        where: { id: mailAccountId },
        data: { syncCursor: null, syncError: "History expired; re-syncing from scratch" },
      });
      await startBackfill({ userId, mailAccountId });

      result.skipped = "cursor-expired";
      result.recovered = "backfill";
      result.cursor = null;
      return result;
    }

    if (isAbortError(error)) {
      log.warn("delta cancelled");
      throw error;
    }

    /*
     * Anything else leaves the cursor where it was, on purpose: the next delta — the
     * retry, the next notification, or the hourly sweep — covers the same window
     * again. Recording the error is worth it for the UI, but it must not read as
     * "this mailbox is broken" when the next push will fix it.
     */
    log.error({ err: error }, "delta sync failed; cursor left in place");
    throw error;
  }
}

/**
 * Fetches one thread and writes it, returning what changed.
 *
 * `null` means the thread no longer exists provider-side, in which case our rows go
 * too — the cascade takes its messages and attachments with it.
 */
async function syncOneThread(input: {
  db: ReturnType<typeof dbForUser>;
  provider: MailProvider;
  mailAccountId: string;
  userId: string;
  providerThreadId: string;
}): Promise<{ messages: number; enriched: number } | null> {
  const { db, provider, mailAccountId, userId, providerThreadId } = input;

  let thread;
  try {
    thread = await provider.getThread(providerThreadId);
  } catch (error) {
    if (statusOf(error) === 404) {
      const removed = await db.thread.deleteMany({
        where: { mailAccountId, providerThreadId },
      });
      if (removed.count > 0) {
        logger.debug(
          { mailAccountId, providerThreadId },
          "thread is gone provider-side; removed locally",
        );
      }
      return null;
    }
    throw error;
  }

  if (thread.messages.length === 0) return null;

  /*
   * Which of these messages we already had, asked *before* the upsert — afterwards
   * every one of them exists and the question cannot be answered. This is what makes
   * "new" mean new rather than "in the payload".
   */
  const providerMessageIds = thread.messages.map((message) => message.providerMessageId);
  const known = await db.message.findMany({
    where: { mailAccountId, providerMessageId: { in: providerMessageIds } },
    select: { providerMessageId: true },
  });
  const knownIds = new Set(known.map((row) => row.providerMessageId));

  const storedIds = await persistThread(db, mailAccountId, thread);

  /*
   * `persistThread` returns our ids in the same order as `thread.messages`, so the two
   * lists line up index by index. Only new *inbound* messages are enriched (rule 2).
   */
  const toEnrich: string[] = [];
  thread.messages.forEach((message, index) => {
    const storedId = storedIds[index];
    if (storedId === undefined) return;
    if (knownIds.has(message.providerMessageId)) return;
    if (message.isOutbound) return;
    toEnrich.push(storedId);
  });

  const enriched =
    toEnrich.length === 0
      ? 0
      : await enqueueEnrichment({ userId, mailAccountId, messageIds: toEnrich });

  return { messages: thread.messages.length, enriched };
}

/**
 * Queues a delta for one mailbox, collapsing a burst into one job (§4).
 *
 * The mailbox id is the job id *and* the dedup key: while a job for this mailbox is
 * waiting or delayed, every further notification lands on the same id and changes
 * nothing. Combined with the short delay, four pushes for a four-message thread
 * become one sync.
 *
 * A finished job's id is cleared first, for the reason `enqueueEnrichment` documents:
 * BullMQ keeps completed jobs for a while and silently refuses to re-add an id it
 * still holds — which here would mean the *next* notification after a sync is ignored,
 * and the mailbox goes quiet for an hour until the sweep.
 *
 * Never throws. A webhook must answer Pub/Sub; it does not get to fail because Redis
 * hiccuped, and the hourly sweep is the backstop.
 */
export async function enqueueDelta(input: {
  userId: string;
  mailAccountId: string;
  reason?: DeltaJob["reason"];
}): Promise<{ queued: boolean; jobId: string }> {
  const jobId = deltaJobId(input.mailAccountId);
  const log = logger.child({ userId: input.userId, mailAccountId: input.mailAccountId });

  try {
    const queue = syncDeltaQueue();
    const existing = await queue.getJob(jobId);

    if (existing) {
      const state = await existing.getState();
      if (state === "waiting" || state === "delayed" || state === "active") {
        log.debug({ state }, "delta already queued; notification collapsed into it");
        return { queued: false, jobId };
      }
      await existing.remove();
    }

    await queue.add(
      "delta",
      {
        mailAccountId: input.mailAccountId,
        userId: input.userId,
        reason: input.reason ?? "webhook",
      } satisfies DeltaJob,
      { jobId, delay: DELTA_DEBOUNCE_MS },
    );

    return { queued: true, jobId };
  } catch (error) {
    log.error({ err: error }, "could not queue a delta sync");
    return { queued: false, jobId };
  }
}
