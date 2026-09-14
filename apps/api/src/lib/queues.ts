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
  aiSweep: "ai.sweep",
  aiStyle: "ai.style",
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

/**
 * The scheduled sweep for messages that were never enriched — capped, disabled at
 * the time, or synced before the AI layer existed. No payload: it always means
 * "look for work", and its schedule is defined at the worker.
 */
export const aiSweepJobSchema = z.object({
  /** Per-user ceiling for one run; omitted means the service default. */
  perUserLimit: z.number().int().min(1).max(5_000).optional(),
});
export type AiSweepJob = z.infer<typeof aiSweepJobSchema>;

/**
 * Build (or refresh) one user's writing-style profile.
 *
 * Queued rather than done inline at the end of a backfill: it is a Sonnet call over
 * thirty messages, and a sync that has just finished writing a mailbox should not
 * also be waiting on the model before it reports success.
 */
export const aiStyleJobSchema = z.object({
  userId: z.string().min(1),
  /** Rebuild even when the stored profile is recent. */
  force: z.boolean().optional(),
});
export type AiStyleJob = z.infer<typeof aiStyleJobSchema>;

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

/**
 * How often the sweep runs. Half-hourly is frequent enough that a cap lifting at
 * UTC midnight is picked up promptly, and cheap enough to ignore: when there is
 * nothing unenriched it is one indexed query per user.
 */
export const AI_SWEEP_INTERVAL_MS = 30 * 60_000;

/** Fixed scheduler id: upserting it means a redeploy re-uses it, not duplicates it. */
export const AI_SWEEP_SCHEDULER_ID = "ai-sweep-every-30m";

let backfillQueue: Queue<BackfillJob> | undefined;
let enrichQueue: Queue<AiEnrichJob> | undefined;
let sweepQueue: Queue<AiSweepJob> | undefined;
let styleQueue: Queue<AiStyleJob> | undefined;

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

export function aiSweepQueue(): Queue<AiSweepJob> {
  sweepQueue ??= new Queue<AiSweepJob>(QUEUE_NAMES.aiSweep, {
    connection: bullConnection,
    defaultJobOptions: {
      // A missed sweep is not worth retrying: the next one is 30 minutes away and
      // will find the same work.
      attempts: 1,
      removeOnComplete: { age: 24 * 3_600, count: 50 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return sweepQueue;
}

/**
 * Registers the repeatable sweep. Idempotent: `upsertJobScheduler` with a fixed id
 * replaces the existing schedule rather than adding a second one, so every worker
 * boot converges on exactly one.
 */
export async function scheduleAiSweep(): Promise<void> {
  await aiSweepQueue().upsertJobScheduler(
    AI_SWEEP_SCHEDULER_ID,
    { every: AI_SWEEP_INTERVAL_MS },
    { name: "sweep", data: {} },
  );
}

export function aiStyleQueue(): Queue<AiStyleJob> {
  styleQueue ??= new Queue<AiStyleJob>(QUEUE_NAMES.aiStyle, {
    connection: bullConnection,
    defaultJobOptions: {
      // Two attempts. A failed profile costs the user nothing immediate — their
      // drafts are merely more generic until the next backfill or a manual refresh.
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 3_600, count: 50 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return styleQueue;
}

/**
 * One profile job per user. The id dedupes the case that actually happens: a user
 * who connects two mailboxes gets two backfills, and both finish asking for the same
 * profile over the same sent mail.
 */
export function aiStyleJobId(userId: string): string {
  // No colon: BullMQ builds its own Redis keys with `:` as the separator.
  return `style-${userId}`;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([
    backfillQueue?.close(),
    enrichQueue?.close(),
    sweepQueue?.close(),
    styleQueue?.close(),
  ]);
  backfillQueue = undefined;
  enrichQueue = undefined;
  sweepQueue = undefined;
  styleQueue = undefined;
}
