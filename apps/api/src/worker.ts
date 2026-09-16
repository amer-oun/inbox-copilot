import { UnrecoverableError, Worker, type Job } from "bullmq";
import { disconnectDatabase } from "@inbox-copilot/db";
import { connectRedis, disconnectRedis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { env } from "./lib/env.js";
import {
  aiEnrichJobSchema,
  aiStyleJobSchema,
  aiSweepJobSchema,
  deltaJobSchema,
  watchJobSchema,
  scheduleSendJobSchema,
  scheduleSweepJobSchema,
  followUpCheckJobSchema,
  scheduleAiSweep,
  scheduleWatchKeeper,
  scheduleSendSweeper,
  scheduleFollowUpCheck,
  backfillJobSchema,
  bullConnection,
  closeQueues,
  QUEUE_NAMES,
  type AiEnrichJob,
  type AiStyleJob,
  type AiSweepJob,
  type BackfillJob,
  type DeltaJob,
  type WatchJob,
  type ScheduleSendJob,
  type ScheduleSweepJob,
  type FollowUpCheckJob,
} from "./lib/queues.js";
import { runBackfill } from "./services/sync.js";
import { runEnrich } from "./services/ai/enrich.js";
import { sweepAllEnrichment } from "./services/ai/sweep.js";
import { buildWritingStyle } from "./services/ai/style.js";
import { runDelta } from "./services/deltaSync.js";
import { runWatchKeeper } from "./services/watch.js";
import { runScheduledSend, sweepDueScheduledEmails } from "./services/schedule.js";
import { runFollowUpCheck } from "./services/followUps.js";
import { MailAccountRevokedError, NotFoundError } from "./lib/errors.js";
import { ConflictError } from "./lib/errors.js";

/**
 * Worker entrypoint. Same codebase as the API, different process (§1): a 90-day
 * backfill must not share an event loop with request handling.
 *
 * Run with `pnpm --filter @inbox-copilot/api dev:worker`, or `pnpm dev` for both.
 */

/**
 * Mailboxes processed at once. Deliberately small: each job fans out to two
 * concurrent `threads.get` calls, and all of them draw on the same per-mailbox quota
 * bucket, so this is a multiplier on Gmail quota and not just on CPU.
 */
const WORKER_CONCURRENCY = 2;

/**
 * Enrichment runs wider than sync: an AI call is latency, not local quota, and each
 * job is one message rather than a whole mailbox. The real bound on this work is the
 * per-user daily cap, checked inside every call (services/ai/usage.ts).
 */
const ENRICH_CONCURRENCY = 5;

/**
 * In-flight abort controllers, keyed by job id.
 *
 * BullMQ abandons a failed attempt but does not cancel the work it started. Without
 * this, a run that failed on rate limiting keeps its `threads.get` calls in flight
 * while the retry begins — the attempts stack, and the second attempt is rate-limited
 * by the first. Aborting on the way out is what keeps one attempt running at a time.
 */
const inFlight = new Map<string, AbortController>();

function abortJob(jobId: string | undefined, reason: string): void {
  if (jobId === undefined) return;
  const controller = inFlight.get(jobId);
  if (!controller || controller.signal.aborted) return;

  logger.warn({ jobId, reason }, "aborting in-flight provider calls");
  controller.abort();
}

/**
 * A second ceiling, in case many mailboxes are queued at once: no more than this
 * many jobs may *start* per interval, whatever the concurrency allows.
 */
const RATE_LIMIT = { max: 10, duration: 60_000 } as const;

/** Failures that will never succeed on retry, so BullMQ must stop trying. */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof MailAccountRevokedError ||
    error instanceof NotFoundError ||
    // "Reconnect first" — a retry cannot fix a missing grant.
    (error instanceof ConflictError &&
      typeof error.details === "object" &&
      error.details !== null &&
      "needsReconnect" in error.details)
  );
}

async function processBackfill(job: Job<BackfillJob>): Promise<void> {
  // Validate on the way in: this payload may have been written by a previous
  // deploy (see lib/queues.ts).
  const payload = backfillJobSchema.parse(job.data);
  const log = logger.child({
    userId: payload.userId,
    mailAccountId: payload.mailAccountId,
  });

  log.info({ jobId: job.id, attempt: job.attemptsMade + 1 }, "backfill started");

  const controller = new AbortController();
  if (job.id !== undefined) inFlight.set(job.id, controller);

  try {
    const progress = await runBackfill(payload, {
      signal: controller.signal,
      onProgress: async (current) => {
        await job.updateProgress(current);
      },
    });
    log.info({ jobId: job.id, ...progress }, "backfill finished");
  } catch (error) {
    if (isPermanent(error)) {
      // Wrapping in UnrecoverableError is what stops BullMQ from burning four
      // more attempts on a mailbox that needs the user to reconnect it.
      const message = error instanceof Error ? error.message : "permanent failure";
      log.warn({ jobId: job.id, err: error }, "backfill cannot be retried");
      throw new UnrecoverableError(message);
    }
    throw error;
  } finally {
    // Whatever happened, nothing from this attempt may still be talking to Gmail:
    // the next attempt is about to, and the checkpoint means it resumes rather than
    // repeats. Cancelling here is also what frees the queued quota waiters.
    controller.abort();
    if (job.id !== undefined) inFlight.delete(job.id);
  }
}

/**
 * Enrichment of one message (§5).
 *
 * A cap or a disabled setting comes back in `skipped` rather than as a throw, so
 * those complete rather than retry — see the note in services/ai/enrich.ts.
 */
async function processEnrich(job: Job<AiEnrichJob>): Promise<void> {
  const payload = aiEnrichJobSchema.parse(job.data);
  const log = logger.child({
    userId: payload.userId,
    mailAccountId: payload.mailAccountId,
    messageId: payload.messageId,
  });

  const controller = new AbortController();
  const key = `enrich-${job.id ?? payload.messageId}`;
  inFlight.set(key, controller);

  try {
    const result = await runEnrich(payload, { signal: controller.signal });
    if (result.skipped.length > 0) {
      log.debug({ jobId: job.id, skipped: result.skipped }, "enrich skipped work");
    }
  } catch (error) {
    if (isPermanent(error)) {
      const message = error instanceof Error ? error.message : "permanent failure";
      log.warn({ jobId: job.id, err: error }, "enrich cannot be retried");
      throw new UnrecoverableError(message);
    }
    throw error;
  } finally {
    controller.abort();
    inFlight.delete(key);
  }
}

/**
 * The scheduled sweep: find messages with no classification and queue them.
 *
 * This is what stops a spent daily cap from becoming permanent. It runs on one
 * worker only because BullMQ's scheduler delivers each repeat once, whatever the
 * number of workers.
 */
async function processSweep(job: Job<AiSweepJob>): Promise<void> {
  const payload = aiSweepJobSchema.parse(job.data);
  const results = await sweepAllEnrichment(payload);

  const queued = results.reduce((sum, result) => sum + result.queued, 0);
  if (queued > 0) {
    logger.info({ jobId: job.id, queued, users: results.length }, "sweep queued enrichment");
  }
}

/**
 * Builds a user's writing-style profile (§5).
 *
 * Cheap to lose and cheap to repeat, so nothing here is clever: a failure is logged
 * and the profile is simply missing until the next backfill or a manual refresh, and
 * the only visible consequence is that this user's drafts sound less like them.
 */
async function processStyle(job: Job<AiStyleJob>): Promise<void> {
  const payload = aiStyleJobSchema.parse(job.data);
  const log = logger.child({ userId: payload.userId });

  const result = await buildWritingStyle({
    userId: payload.userId,
    ...(payload.force === true ? { force: true } : {}),
  });

  log.info(
    { jobId: job.id, samples: result.sampleCount, skipped: result.skipped ?? null },
    "writing style job finished",
  );
}

/**
 * One incremental sync (§4), triggered by a push or by the keeper.
 *
 * Aborted on failure like a backfill, and for the same reason: BullMQ abandons the
 * attempt but not its in-flight Gmail requests, and two attempts reading the same
 * mailbox rate-limit each other.
 */
async function processDelta(job: Job<DeltaJob>): Promise<void> {
  const payload = deltaJobSchema.parse(job.data);
  const log = logger.child({
    userId: payload.userId,
    mailAccountId: payload.mailAccountId,
  });

  const controller = new AbortController();
  const key = `delta-${job.id ?? payload.mailAccountId}`;
  inFlight.set(key, controller);

  try {
    const result = await runDelta(payload, { signal: controller.signal });
    log.debug(
      {
        jobId: job.id,
        threads: result.threads,
        messages: result.messages,
        enriched: result.enriched,
        skipped: result.skipped ?? null,
        recovered: result.recovered ?? null,
      },
      "delta job finished",
    );
  } catch (error) {
    if (isPermanent(error)) {
      const message = error instanceof Error ? error.message : "permanent failure";
      log.warn({ jobId: job.id, err: error }, "delta cannot be retried");
      throw new UnrecoverableError(message);
    }
    throw error;
  } finally {
    controller.abort();
    inFlight.delete(key);
  }
}

/**
 * The watch keeper (§4): renew expiring Gmail watches, and queue a catch-up delta for
 * any mailbox whose push is not live or has gone quiet.
 *
 * Never throws per mailbox — `runWatchKeeper` counts failures and continues — so one
 * revoked grant cannot stop everyone else's watch from being renewed.
 */
async function processWatch(job: Job<WatchJob>): Promise<void> {
  const payload = watchJobSchema.parse(job.data);
  const result = await runWatchKeeper(
    payload.force === true ? { force: true } : {},
  );

  if (result.renewed > 0 || result.caughtUp > 0 || result.failed > 0) {
    logger.info({ jobId: job.id, ...result }, "watch keeper queued work");
  }
}

/**
 * One scheduled send becoming due (§9).
 *
 * The important thing about this function is what it does *not* do on failure.
 * `runScheduledSend` returns `{ status: "failed" }` after writing FAILED and the error
 * to the row — it does not throw, so BullMQ records a completed job, and there is no
 * retry. That is the phase-6 send rule carried forward: a send whose outcome is unknown
 * is not attempted again, because the provider may have accepted the message before the
 * error and a second attempt would put the user's mail in somebody's inbox twice.
 *
 * The queue is configured with `attempts: 1` as well (`SCHEDULE_SEND_JOB_OPTIONS`), so
 * this holds even if a future change here starts throwing.
 */
async function processScheduledSend(job: Job<ScheduleSendJob>): Promise<void> {
  const payload = scheduleSendJobSchema.parse(job.data);
  const log = logger.child({
    userId: payload.userId,
    scheduledEmailId: payload.scheduledEmailId,
  });

  const controller = new AbortController();
  const key = `schedsend-${job.id ?? payload.scheduledEmailId}`;
  inFlight.set(key, controller);

  try {
    const result = await runScheduledSend(payload, { signal: controller.signal });
    log.debug({ jobId: job.id, ...result }, "scheduled send job finished");
  } finally {
    controller.abort();
    inFlight.delete(key);
  }
}

/**
 * The scheduled-send sweeper (§9): re-enqueue anything overdue.
 *
 * This is the job that makes "the DB row is recoverable on its own" true. Redis losing
 * a delayed job — an eviction, a restart without persistence, a development
 * `FLUSHALL` — would otherwise mean a send the user is counting on never fires, with no
 * error anywhere. One indexed query per minute turns that into a delay of at most a
 * minute.
 */
async function processScheduleSweep(job: Job<ScheduleSweepJob>): Promise<void> {
  scheduleSweepJobSchema.parse(job.data);
  const result = await sweepDueScheduledEmails();
  if (result.found > 0) {
    logger.info({ jobId: job.id, ...result }, "scheduled-send sweep found overdue sends");
  }
}

/**
 * The follow-up check (§9): resolve, then trigger, then digest.
 *
 * Never throws per reminder — `runFollowUpCheck` counts failures and continues — so one
 * bad row cannot stop everybody else's reminders from resolving.
 */
async function processFollowUpCheck(job: Job<FollowUpCheckJob>): Promise<void> {
  followUpCheckJobSchema.parse(job.data);
  const result = await runFollowUpCheck();
  if (result.resolved > 0 || result.triggered > 0 || result.digestsSent > 0) {
    logger.info({ jobId: job.id, ...result }, "follow-up check did work");
  }
}

const worker = new Worker<BackfillJob>(QUEUE_NAMES.syncBackfill, processBackfill, {
  connection: bullConnection,
  concurrency: WORKER_CONCURRENCY,
  limiter: { max: RATE_LIMIT.max, duration: RATE_LIMIT.duration },
});

const enrichWorker = new Worker<AiEnrichJob>(QUEUE_NAMES.aiEnrich, processEnrich, {
  connection: bullConnection,
  concurrency: ENRICH_CONCURRENCY,
});

const sweepWorker = new Worker<AiSweepJob>(QUEUE_NAMES.aiSweep, processSweep, {
  connection: bullConnection,
  concurrency: 1,
});

/**
 * Deltas run wider than backfills and narrower than enrichment: each is a handful of
 * Gmail reads for one mailbox, and the per-mailbox quota bucket paces them anyway.
 */
const deltaWorker = new Worker<DeltaJob>(QUEUE_NAMES.syncDelta, processDelta, {
  connection: bullConnection,
  concurrency: 4,
});

deltaWorker.on("failed", (job, error) => {
  abortJob(`delta-${job?.id}`, "job failed");
  logger.error(
    { queue: QUEUE_NAMES.syncDelta, jobId: job?.id, attempts: job?.attemptsMade, err: error },
    "delta job failed",
  );
});

deltaWorker.on("stalled", (jobId) => {
  abortJob(`delta-${jobId}`, "job stalled");
  logger.warn({ queue: QUEUE_NAMES.syncDelta, jobId }, "delta job stalled");
});

deltaWorker.on("error", (error) => {
  logger.warn({ err: error }, "delta worker error");
});

const watchWorker = new Worker<WatchJob>(QUEUE_NAMES.syncWatch, processWatch, {
  connection: bullConnection,
  // One at a time: it walks every mailbox, and two concurrent runs would race to renew
  // the same watches.
  concurrency: 1,
});

watchWorker.on("failed", (job, error) => {
  logger.error(
    { queue: QUEUE_NAMES.syncWatch, jobId: job?.id, err: error },
    "watch keeper failed",
  );
});

watchWorker.on("error", (error) => {
  logger.warn({ err: error }, "watch worker error");
});

/**
 * Scheduled sends.
 *
 * Concurrency 3: these are one provider call each and they cluster on the hour, because
 * that is when people schedule things. Wider would not help — the rate limiter below
 * is per worker and a mailbox's own quota is the real bound.
 */
const scheduleSendWorker = new Worker<ScheduleSendJob>(
  QUEUE_NAMES.scheduleSend,
  processScheduledSend,
  { connection: bullConnection, concurrency: 3 },
);

scheduleSendWorker.on("failed", (job, error) => {
  abortJob(`schedsend-${job?.id}`, "job failed");
  // A failure that reaches here is an unexpected throw rather than a failed send —
  // `runScheduledSend` records those on the row and returns. Either way: no retry.
  logger.error(
    { queue: QUEUE_NAMES.scheduleSend, jobId: job?.id, err: error },
    "scheduled send job failed",
  );
});

scheduleSendWorker.on("stalled", (jobId) => {
  abortJob(`schedsend-${jobId}`, "job stalled");
  logger.warn({ queue: QUEUE_NAMES.scheduleSend, jobId }, "scheduled send job stalled");
});

scheduleSendWorker.on("error", (error) => {
  logger.warn({ err: error }, "scheduled send worker error");
});

const scheduleSweepWorker = new Worker<ScheduleSweepJob>(
  QUEUE_NAMES.scheduleSweep,
  processScheduleSweep,
  // One at a time: two concurrent sweeps would race to enqueue the same due rows. The
  // job id dedupe would absorb it, but there is nothing to gain from the race.
  { connection: bullConnection, concurrency: 1 },
);

scheduleSweepWorker.on("failed", (job, error) => {
  logger.error(
    { queue: QUEUE_NAMES.scheduleSweep, jobId: job?.id, err: error },
    "scheduled-send sweep failed",
  );
});

scheduleSweepWorker.on("error", (error) => {
  logger.warn({ err: error }, "schedule sweep worker error");
});

const followUpWorker = new Worker<FollowUpCheckJob>(
  QUEUE_NAMES.followupCheck,
  processFollowUpCheck,
  { connection: bullConnection, concurrency: 1 },
);

followUpWorker.on("failed", (job, error) => {
  logger.error(
    { queue: QUEUE_NAMES.followupCheck, jobId: job?.id, err: error },
    "follow-up check failed",
  );
});

followUpWorker.on("error", (error) => {
  logger.warn({ err: error }, "follow-up worker error");
});

const styleWorker = new Worker<AiStyleJob>(QUEUE_NAMES.aiStyle, processStyle, {
  connection: bullConnection,
  // One at a time: it is a per-user job that runs once a month at most, and the only
  // thing that would make it concurrent is a mass signup.
  concurrency: 1,
});

styleWorker.on("failed", (job, error) => {
  logger.error(
    { queue: QUEUE_NAMES.aiStyle, jobId: job?.id, err: error },
    "writing style job failed",
  );
});

styleWorker.on("error", (error) => {
  logger.warn({ err: error }, "style worker error");
});

sweepWorker.on("failed", (job, error) => {
  logger.error({ queue: QUEUE_NAMES.aiSweep, jobId: job?.id, err: error }, "sweep failed");
});

sweepWorker.on("error", (error) => {
  logger.warn({ err: error }, "sweep worker error");
});

/*
 * The request-path Redis client (lib/redis.ts) is lazy and has offline queueing
 * disabled, so the first command against it throws unless it has been connected.
 * BullMQ's own connections are separate, so nothing here connects it implicitly —
 * and this process needs it for `withMutex`: the token-refresh lock, and the
 * per-thread summarization lock. Until this call existed, the first refresh in a
 * worker failed with "Stream isn't writeable".
 */
await connectRedis();

// Registered here rather than at enqueue time: the schedule is a property of the
// worker deployment, and upserting it makes a restart converge on one schedule.
await scheduleAiSweep();

// The watch keeper, on the same terms: a property of the deployment, converging on one
// schedule however many times a worker restarts.
await scheduleWatchKeeper();

/*
 * The scheduled-send sweeper and the follow-up check, on the same terms: a property of
 * the deployment, upserted so a restart converges on one schedule rather than adding a
 * second. The sweeper runs every minute — far more often than the other keepers —
 * because it is the only thing between a lost Redis job and mail that silently never
 * goes out (see SCHEDULE_SWEEP_INTERVAL_MS).
 */
await scheduleSendSweeper();
await scheduleFollowUpCheck();

enrichWorker.on("failed", (job, error) => {
  abortJob(`enrich-${job?.id}`, "job failed");
  logger.error(
    {
      queue: QUEUE_NAMES.aiEnrich,
      jobId: job?.id,
      attempts: job?.attemptsMade,
      err: error,
    },
    "job failed",
  );
});

enrichWorker.on("stalled", (jobId) => {
  abortJob(`enrich-${jobId}`, "job stalled");
  logger.warn({ queue: QUEUE_NAMES.aiEnrich, jobId }, "job stalled");
});

enrichWorker.on("error", (error) => {
  logger.warn({ err: error }, "enrich worker error");
});

worker.on("failed", (job, error) => {
  // Belt and braces with the `finally` above: a job that BullMQ fails out from under
  // us (a stall, a lost lock) never reaches that block.
  abortJob(job?.id, "job failed");
  logger.error(
    {
      queue: QUEUE_NAMES.syncBackfill,
      jobId: job?.id,
      attempts: job?.attemptsMade,
      err: error,
    },
    "job failed",
  );
});

worker.on("stalled", (jobId) => {
  abortJob(jobId, "job stalled");
  logger.warn({ queue: QUEUE_NAMES.syncBackfill, jobId }, "job stalled");
});

worker.on("error", (error) => {
  // Connection-level problems arrive here; BullMQ reconnects on its own.
  logger.warn({ err: error }, "worker error");
});

logger.info(
  {
    queues: [
      QUEUE_NAMES.syncBackfill,
      QUEUE_NAMES.aiEnrich,
      QUEUE_NAMES.aiSweep,
      QUEUE_NAMES.aiStyle,
      QUEUE_NAMES.syncDelta,
      QUEUE_NAMES.syncWatch,
      QUEUE_NAMES.scheduleSend,
      QUEUE_NAMES.scheduleSweep,
      QUEUE_NAMES.followupCheck,
    ],
    concurrency: { backfill: WORKER_CONCURRENCY, enrich: ENRICH_CONCURRENCY },
    env: env.NODE_ENV,
  },
  "worker listening",
);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "worker shutting down");
  // Stop making requests immediately; `close()` below waits for the jobs to unwind.
  for (const [jobId] of inFlight) abortJob(jobId, "worker shutting down");
  // `close()` waits for in-flight jobs so a deploy does not abandon a backfill
  // halfway through a page.
  await Promise.all([
    worker.close(),
    enrichWorker.close(),
    sweepWorker.close(),
    styleWorker.close(),
    deltaWorker.close(),
    watchWorker.close(),
    // Waited on like the rest: a deploy must not abandon a send mid-flight, because
    // nothing downstream can tell whether it went out.
    scheduleSendWorker.close(),
    scheduleSweepWorker.close(),
    followUpWorker.close(),
  ]);
  await Promise.allSettled([closeQueues(), disconnectRedis(), disconnectDatabase()]);
  process.exit(0);
}

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));

process.on("uncaughtException", (error: Error) => {
  logger.fatal({ err: error }, "uncaught exception in worker");
  process.exit(1);
});
process.on("unhandledRejection", (reason: unknown) => {
  logger.fatal({ err: reason }, "unhandled promise rejection in worker");
  process.exit(1);
});
