import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { z } from "zod";
import { env } from "./env.js";

/**
 * BullMQ queues and their shared Redis connection.
 *
 * BullMQ needs its own connection options — `maxRetriesPerRequest: null` and
 * offline queueing on — which is exactly the opposite of what `lib/redis.ts`
 * configures for request-path commands. Sharing that client would break blocking
 * commands, so the two stay separate (see the note in lib/redis.ts).
 */

export const QUEUE_NAMES = {
  syncBackfill: "sync.backfill",
  aiEnrich: "ai.enrich",
} as const;

/**
 * Job payloads are validated on both ends. A job outlives the process that
 * enqueued it, so after a deploy a worker can dequeue a payload written by the
 * previous version — that is a contract, and contracts get schemas.
 */
export const backfillJobSchema = z.object({
  mailAccountId: z.string().min(1),
  userId: z.string().min(1),
  /** How far back to page. Defaults to 90 days at the service boundary (§4). */
  windowDays: z.number().int().min(1).max(3650),
  /** Set when a job is a continuation, so a resumed backfill does not restart. */
  pageToken: z.string().min(1).optional(),
});
export type BackfillJob = z.infer<typeof backfillJobSchema>;

/**
 * One message to enrich. The mailbox id rides along so log lines and the tenancy
 * check have it without a second query.
 */
export const aiEnrichJobSchema = z.object({
  messageId: z.string().min(1),
  mailAccountId: z.string().min(1),
  userId: z.string().min(1),
});
export type AiEnrichJob = z.infer<typeof aiEnrichJobSchema>;

export const bullConnection: ConnectionOptions = {
  url: env.REDIS_URL,
  // BullMQ's blocking commands must never time out mid-wait.
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
};

/**
 * Defaults for every enqueue.
 *
 * `attempts` + exponential backoff is the outer ring around the per-call retries in
 * `lib/retry.ts`: that one survives a rate limit inside a job, this one survives
 * the job dying.
 *
 * The 60-second base is deliberate. A backfill that failed on rate limiting needs the
 * quota window to actually recover; retrying a whole mailbox seconds later just
 * re-fills the bucket with the same requests. The curve is 60s, 2m, 4m, 8m — and the
 * attempt count stays at 5, because the fix for rate limiting is fewer requests, not
 * more attempts.
 *
 * Completed jobs are kept briefly so `sync-status` can still see the last outcome;
 * failures are kept much longer because they are the ones worth reading.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 60_000 },
  removeOnComplete: { age: 3_600, count: 100 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

/**
 * Enrichment is per message, so a backfill of a busy mailbox enqueues thousands of
 * these. Two deliberate differences from the backfill defaults:
 *
 *   - fewer attempts. The failure modes here are a bad model response or a spent
 *     cap; neither is fixed by trying five times, and §5's Batch API backfill
 *     (phase 5) is the proper sweep for messages left unclassified.
 *   - a short base delay. Unlike a Gmail quota block, a transient Anthropic 429 or
 *     529 clears in seconds, and `lib/retry.ts` has already waited inside the job.
 */
export const ENRICH_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { age: 600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

let backfillQueue: Queue<BackfillJob> | undefined;
let enrichQueue: Queue<AiEnrichJob> | undefined;

/** Lazily constructed: importing this module must not open a connection. */
export function syncBackfillQueue(): Queue<BackfillJob> {
  backfillQueue ??= new Queue<BackfillJob>(QUEUE_NAMES.syncBackfill, {
    connection: bullConnection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return backfillQueue;
}

/**
 * One in-flight backfill per mailbox. Using the mailbox id as the job id makes
 * enqueueing idempotent: a user mashing "Sync now" collapses into the job already
 * queued rather than racing a second pass over the same threads.
 */
export function backfillJobId(mailAccountId: string): string {
  // No colon: BullMQ rejects a custom job id containing one, because it builds its
  // own Redis keys with `:` as the separator.
  return `backfill-${mailAccountId}`;
}

/** Lazily constructed, for the same reason as the backfill queue. */
export function aiEnrichQueue(): Queue<AiEnrichJob> {
  enrichQueue ??= new Queue<AiEnrichJob>(QUEUE_NAMES.aiEnrich, {
    connection: bullConnection,
    defaultJobOptions: ENRICH_JOB_OPTIONS,
  });
  return enrichQueue;
}

/**
 * One enrichment per message, ever — the job id is the message id, so a resync that
 * re-persists the same message collapses onto the job already queued instead of
 * paying for a second classification. (The content-hash cache would catch it too;
 * this catches it before a worker, a DB read and a queue slot are spent.)
 */
export function aiEnrichJobId(messageId: string): string {
  // No colon: BullMQ builds its own Redis keys with `:` as the separator.
  return `enrich-${messageId}`;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([backfillQueue?.close(), enrichQueue?.close()]);
  backfillQueue = undefined;
  enrichQueue = undefined;
}
