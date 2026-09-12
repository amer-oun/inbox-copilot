import { UnrecoverableError, Worker, type Job } from "bullmq";
import { disconnectDatabase } from "@inbox-copilot/db";
import { logger } from "./lib/logger.js";
import { env } from "./lib/env.js";
import {
  backfillJobSchema,
  bullConnection,
  closeQueues,
  QUEUE_NAMES,
  type BackfillJob,
} from "./lib/queues.js";
import { runBackfill } from "./services/sync.js";
import { MailAccountRevokedError, NotFoundError } from "./lib/errors.js";
import { ConflictError } from "./lib/errors.js";

/**
 * Worker entrypoint. Same codebase as the API, different process (§1): a 90-day
 * backfill must not share an event loop with request handling.
 *
 * Run with `pnpm --filter @inbox-copilot/api dev:worker`, or `pnpm dev` for both.
 */

/**
 * Mailboxes processed at once. Deliberately small: each job already fans out to
 * five concurrent `threads.get` calls, so this is a multiplier on Gmail quota, not
 * just on CPU.
 */
const WORKER_CONCURRENCY = 2;

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

  try {
    const progress = await runBackfill(payload, {
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
  }
}

const worker = new Worker<BackfillJob>(QUEUE_NAMES.syncBackfill, processBackfill, {
  connection: bullConnection,
  concurrency: WORKER_CONCURRENCY,
  limiter: { max: RATE_LIMIT.max, duration: RATE_LIMIT.duration },
});

worker.on("failed", (job, error) => {
  logger.error(
    { queue: QUEUE_NAMES.syncBackfill, jobId: job?.id, attempts: job?.attemptsMade, err: error },
    "job failed",
  );
});

worker.on("error", (error) => {
  // Connection-level problems arrive here; BullMQ reconnects on its own.
  logger.warn({ err: error }, "worker error");
});

logger.info(
  { queue: QUEUE_NAMES.syncBackfill, concurrency: WORKER_CONCURRENCY, env: env.NODE_ENV },
  "worker listening",
);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "worker shutting down");
  // `close()` waits for in-flight jobs so a deploy does not abandon a backfill
  // halfway through a page.
  await worker.close();
  await Promise.allSettled([closeQueues(), disconnectDatabase()]);
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
