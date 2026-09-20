import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { connectRedis, disconnectRedis } from "./lib/redis.js";
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
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "api listening");
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void Promise.allSettled([disconnectRedis(), disconnectDatabase()]).then(() =>
        process.exit(0),
      );
    });
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 10_000).unref();
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
