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
 * the job dying. Completed jobs are kept briefly so `sync-status` can still see the
 * last outcome; failures are kept much longer because they are the ones worth
 * reading.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 100 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

let backfillQueue: Queue<BackfillJob> | undefined;

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

export async function closeQueues(): Promise<void> {
  await backfillQueue?.close();
  backfillQueue = undefined;
}
