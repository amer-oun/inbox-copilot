import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { connectRedis, disconnectRedis } from "./lib/redis.js";
import { closeQueues } from "./lib/queues.js";
import { startWorkers, type WorkerRuntime } from "./queueWorkers.js";
import { disconnectDatabase } from "@inbox-copilot/db";

async function main(): Promise<void> {
  // Connecting is best-effort: a cold Redis must not stop the process from
  // booting, otherwise /health could never report it as down. ioredis keeps
  // retrying in the background and /health reflects the real state.
  await connectRedis().catch((error: unknown) => {
    logger.warn({ err: error }, "redis unavailable at startup; retrying in background");
  });

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, workerInProcess: env.WORKER_IN_PROCESS },
      "api listening",
    );
  });

  /*
   * The queue consumers, optionally hosted here (§1 prefers a separate process, and
   * `pnpm dev` still runs one).
   *
   * Started *after* `listen`, and deliberately not awaited before the server is up: a
   * platform that health-checks a new instance before routing traffic to it should not
   * be kept waiting by a Redis handshake, and a worker that cannot start must not stop
   * the API from serving. So a failure here is logged and the HTTP half lives on —
   * degraded in exactly the way the sweepers exist to recover from, rather than down.
   */
  let workers: WorkerRuntime | undefined;
  if (env.WORKER_IN_PROCESS) {
    try {
      workers = await startWorkers();
    } catch (error) {
      logger.error(
        { err: error },
        "WORKER_IN_PROCESS is set but the queue workers failed to start; serving HTTP only",
      );
    }
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void (async () => {
        // Workers first: they are the thing with jobs in flight, and closing Redis
        // under a backfill would abandon it mid-page.
        if (workers) await workers.close();
        await Promise.allSettled([
          closeQueues(),
          disconnectRedis(),
          disconnectDatabase(),
        ]);
        process.exit(0);
      })();
    });
    /*
     * Don't hang forever on a stuck keep-alive connection. Longer when this process is
     * also the worker, because `workers.close()` waits for in-flight jobs on purpose and
     * a backfill page takes seconds — but still inside the 30 seconds a platform like
     * Render allows between SIGTERM and SIGKILL, so the guard is ours rather than
     * theirs.
     */
    setTimeout(() => process.exit(1), env.WORKER_IN_PROCESS ? 25_000 : 10_000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Without these, Node prints the raw reason to stderr and exits — outside pino,
  // so outside the redaction config. Routing them through the logger keeps every
  // path that can print an error subject to the same rules, and a crash stays a
  // crash: the process still exits non-zero rather than limping on.
  process.on("uncaughtException", (error: Error) => {
    logger.fatal({ err: error }, "uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "api failed to start");
  process.exit(1);
});
