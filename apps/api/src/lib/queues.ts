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
  syncDelta: "sync.delta",
  syncWatch: "sync.watch",
  scheduleSend: "schedule.send",
  scheduleSweep: "schedule.sweep",
  followupCheck: "followup.check",
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

/**
 * One incremental sync of one mailbox (§4).
 *
 * `reason` is diagnostic: "webhook" is the fast path, and a mailbox whose deltas all
 * say "sweep" is a mailbox whose push has quietly stopped working.
 */
export const deltaJobSchema = z.object({
  mailAccountId: z.string().min(1),
  userId: z.string().min(1),
  reason: z.enum(["webhook", "sweep", "watch-renewed", "manual"]).default("webhook"),
});
export type DeltaJob = z.infer<typeof deltaJobSchema>;

/**
 * The watch keeper: renew what is about to expire, and catch up anything whose push
 * has lapsed. No payload — it always means "check every mailbox".
 */
export const watchJobSchema = z.object({
  /** Renew even watches that are not near expiry. */
  force: z.boolean().optional(),
});
export type WatchJob = z.infer<typeof watchJobSchema>;

/**
 * One scheduled send becoming due (§9).
 *
 * The payload is an id and nothing else — deliberately. The row is the source of
 * truth: the subject, the body, the recipients and above all the *status* are read
 * fresh at send time, so a job that Redis kept across a cancellation finds a
 * CANCELLED row and does nothing. A job carrying the body would be a second copy of
 * the mail, and the two could disagree about whether it should go.
 */
export const scheduleSendJobSchema = z.object({
  scheduledEmailId: z.string().min(1),
  userId: z.string().min(1),
});
export type ScheduleSendJob = z.infer<typeof scheduleSendJobSchema>;

/**
 * The sweeper §9 asks for: re-enqueue anything overdue, in case Redis lost a job.
 *
 * No payload — it always means "look for due sends". This is the half of the design
 * that makes the DB row recoverable on its own: a flushed Redis, a delayed job lost
 * to an eviction, or a scheduled send written while the worker was down all come back
 * through one indexed query on `(status, sendAt)`.
 */
export const scheduleSweepJobSchema = z.object({});
export type ScheduleSweepJob = z.infer<typeof scheduleSweepJobSchema>;

/**
 * The follow-up check (§9): resolve reminders whose thread got a reply, trigger the
 * ones that are due, and mail the opt-in digest.
 */
export const followUpCheckJobSchema = z.object({});
export type FollowUpCheckJob = z.infer<typeof followUpCheckJobSchema>;

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
let deltaQueue: Queue<DeltaJob> | undefined;
let watchQueue: Queue<WatchJob> | undefined;
let scheduleQueue: Queue<ScheduleSendJob> | undefined;
let scheduleSweeperQueue: Queue<ScheduleSweepJob> | undefined;
let followupQueue: Queue<FollowUpCheckJob> | undefined;

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

/**
 * How long a webhook-triggered delta waits before running.
 *
 * A short delay is what makes bursts collapse. Gmail publishes a notification per
 * change, so a thread with four new messages arrives as four pushes within a second;
 * with the mailbox id as the job id, the first push queues a delayed job and the next
 * three land on the same id and do nothing. One sync, four notifications.
 *
 * Two seconds is chosen against human perception rather than machine cost: it is below
 * the time it takes to switch to the tab, and well above the spacing of a burst.
 */
export const DELTA_DEBOUNCE_MS = 2_000;

/**
 * Deltas are per mailbox, so the id is the dedup key (§4). A second notification for a
 * mailbox already queued is a no-op, which is the point.
 */
export function deltaJobId(mailAccountId: string): string {
  // No colon: BullMQ builds its own Redis keys with `:` as the separator.
  return `delta-${mailAccountId}`;
}

export function syncDeltaQueue(): Queue<DeltaJob> {
  deltaQueue ??= new Queue<DeltaJob>(QUEUE_NAMES.syncDelta, {
    connection: bullConnection,
    defaultJobOptions: {
      /*
       * Three attempts on a 15-second curve. Unlike a backfill, a delta is small and
       * cheap to repeat, and the thing it usually fails on — a transient Gmail error —
       * clears in seconds. It is also self-healing: the cursor has not moved, so a
       * later delta covers whatever this one missed.
       */
      attempts: 3,
      backoff: { type: "exponential", delay: 15_000 },
      removeOnComplete: { age: 3_600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return deltaQueue;
}

export function syncWatchQueue(): Queue<WatchJob> {
  watchQueue ??= new Queue<WatchJob>(QUEUE_NAMES.syncWatch, {
    connection: bullConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 3_600, count: 50 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return watchQueue;
}

/**
 * How often the watch keeper runs.
 *
 * Hourly, not daily, even though a Gmail watch lasts seven days and is renewed with a
 * two-day margin — so renewal itself happens on a daily-or-better cadence either way.
 * The hourly tick is for the *other* half of this job: a mailbox whose watch has
 * lapsed, or whose push is silently broken, is a mailbox receiving no mail as far as
 * the user can tell. Discovering that within an hour costs one indexed query per run;
 * discovering it within a day is a day of an inbox that looks empty.
 */
export const WATCH_INTERVAL_MS = 60 * 60_000;

export const WATCH_SCHEDULER_ID = "sync-watch-hourly";

/** Registers the repeatable watch keeper. Idempotent, like the AI sweep. */
export async function scheduleWatchKeeper(): Promise<void> {
  await syncWatchQueue().upsertJobScheduler(
    WATCH_SCHEDULER_ID,
    { every: WATCH_INTERVAL_MS },
    { name: "watch", data: {} },
  );
}

/**
 * Scheduled sends do **not** retry. One attempt, and that is the phase-6 rule about
 * `sendMessage` carried into phase 10 unchanged: a 429 or a 502 from a send does not
 * say whether the message went out, and a retry that guesses wrong sends the user's
 * mail twice. A failed scheduled send lands in FAILED with the error on the row, and
 * the user is told; the one thing it does not do is try again on its own.
 *
 * This is also why the sweeper only ever picks up SCHEDULED rows. A row left in
 * SENDING is precisely the unknown-outcome case, and re-enqueueing it would be the
 * automatic retry this comment exists to refuse.
 */
export const SCHEDULE_SEND_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  // Kept long enough that "why did my 9am send fail" is answerable from the queue as
  // well as from the row.
  removeOnComplete: { age: 24 * 3_600, count: 500 },
  removeOnFail: { age: 30 * 24 * 3_600 },
};

export function scheduleSendQueue(): Queue<ScheduleSendJob> {
  scheduleQueue ??= new Queue<ScheduleSendJob>(QUEUE_NAMES.scheduleSend, {
    connection: bullConnection,
    defaultJobOptions: SCHEDULE_SEND_JOB_OPTIONS,
  });
  return scheduleQueue;
}

/**
 * One job per scheduled row, ever.
 *
 * The id is the dedup key, and here it guards against the sweeper: a row whose
 * delayed job is still sitting in Redis gets swept, the enqueue lands on the same id,
 * and nothing is duplicated. The database `idempotencyKey` is the backstop under
 * that, for the case where the job really was lost and two arrive anyway.
 */
export function scheduleSendJobId(scheduledEmailId: string): string {
  // No colon: BullMQ builds its own Redis keys with `:` as the separator.
  return `schedsend-${scheduledEmailId}`;
}

export function scheduleSweepQueue(): Queue<ScheduleSweepJob> {
  scheduleSweeperQueue ??= new Queue<ScheduleSweepJob>(QUEUE_NAMES.scheduleSweep, {
    connection: bullConnection,
    defaultJobOptions: {
      // A missed sweep is not worth retrying: the next one is a minute away.
      attempts: 1,
      removeOnComplete: { age: 3_600, count: 60 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return scheduleSweeperQueue;
}

/**
 * How often the scheduled-send sweeper runs.
 *
 * Every minute, which is far more often than the other keepers in this app, and for a
 * reason none of them share: this one is the *only* thing standing between a lost
 * Redis job and mail that silently never goes out at a time the user chose. The cost
 * is one query on the `(status, sendAt)` index, which finds nothing almost every time.
 * A 9am send discovered at 9:01 is a working feature; one discovered at 10am is not.
 */
export const SCHEDULE_SWEEP_INTERVAL_MS = 60_000;

export const SCHEDULE_SWEEP_SCHEDULER_ID = "schedule-sweep-every-1m";

/** Registers the repeatable sweeper. Idempotent, like the AI sweep. */
export async function scheduleSendSweeper(): Promise<void> {
  await scheduleSweepQueue().upsertJobScheduler(
    SCHEDULE_SWEEP_SCHEDULER_ID,
    { every: SCHEDULE_SWEEP_INTERVAL_MS },
    { name: "sweep", data: {} },
  );
}

export function followUpCheckQueue(): Queue<FollowUpCheckJob> {
  followupQueue ??= new Queue<FollowUpCheckJob>(QUEUE_NAMES.followupCheck, {
    connection: bullConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 3_600, count: 50 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return followupQueue;
}

/**
 * How often reminders are checked.
 *
 * Quarter-hourly, against a due date measured in days: the precision that matters is
 * not when a reminder appears but how quickly one *disappears* after the reply lands,
 * because a reminder to chase somebody who already answered is the failure mode that
 * makes a user turn the feature off. The delta sync also queues a check when it writes
 * inbound mail, so in practice a reply clears its reminder in seconds and this tick is
 * the floor under that.
 */
export const FOLLOWUP_CHECK_INTERVAL_MS = 15 * 60_000;

export const FOLLOWUP_CHECK_SCHEDULER_ID = "followup-check-every-15m";

export async function scheduleFollowUpCheck(): Promise<void> {
  await followUpCheckQueue().upsertJobScheduler(
    FOLLOWUP_CHECK_SCHEDULER_ID,
    { every: FOLLOWUP_CHECK_INTERVAL_MS },
    { name: "check", data: {} },
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all([
    backfillQueue?.close(),
    enrichQueue?.close(),
    sweepQueue?.close(),
    styleQueue?.close(),
    deltaQueue?.close(),
    watchQueue?.close(),
    scheduleQueue?.close(),
    scheduleSweeperQueue?.close(),
    followupQueue?.close(),
  ]);
  backfillQueue = undefined;
  enrichQueue = undefined;
  sweepQueue = undefined;
  styleQueue = undefined;
  deltaQueue = undefined;
  watchQueue = undefined;
  scheduleQueue = undefined;
  scheduleSweeperQueue = undefined;
  followupQueue = undefined;
}
