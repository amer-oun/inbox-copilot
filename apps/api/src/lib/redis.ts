import { Redis } from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Shared connection for ordinary commands. BullMQ queues get their own
 * connections (they need `maxRetriesPerRequest: null`) — do not reuse this one.
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
});

export async function connectRedis(): Promise<void> {
  if (redis.status === "ready" || redis.status === "connecting") return;
  await redis.connect();
}

// ioredis emits 'error' on every failed reconnect attempt; an unhandled one
// would crash the process.
redis.on("error", (error: Error) => {
  logger.warn({ err: error }, "redis connection error");
});

/** Cheap round-trip used by the health check. */
export async function pingRedis(): Promise<void> {
  const reply = await redis.ping();
  if (reply !== "PONG") {
    throw new Error(`unexpected PING reply: ${reply}`);
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
