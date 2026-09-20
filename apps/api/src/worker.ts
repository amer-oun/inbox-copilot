import { disconnectDatabase } from "@inbox-copilot/db";
import { disconnectRedis } from "./lib/redis.js";
import { logger } from "./lib/logger.js";
import { closeQueues } from "./lib/queues.js";
import { startWorkers } from "./queueWorkers.js";

/**
 * Dedicated worker entrypoint. Same codebase as the API, different process (§1): a
 * 90-day backfill must not share an event loop with request handling.
 *
 * Run with `pnpm --filter @inbox-copilot/api dev:worker`, or `pnpm dev` for both. In
 * production this is `node dist/worker.js` as its own service.
 *
 * The consumers themselves are in `queueWorkers.ts`, which `src/index.ts` can also
 * host when `WORKER_IN_PROCESS=true`. This file is only the lifecycle: start, then
 * shut down cleanly. Everything it closes — the queue producers, Redis, the database —
 * it closes because in *this* process nothing else is using them.
 */

const runtime = await startWorkers();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "worker shutting down");
  await runtime.close();
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
