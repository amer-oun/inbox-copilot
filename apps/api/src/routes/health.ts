import { Router } from "express";
import { pingDatabase } from "@inbox-copilot/db";
import {
  healthResponseSchema,
  type DependencyHealth,
  type HealthResponse,
} from "@inbox-copilot/shared";
import { pingRedis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

const SERVICE_NAME = "inbox-copilot-api";
const VERSION = process.env["npm_package_version"] ?? "0.1.0";

/** Never let a hung socket hold the health check open. */
const PING_TIMEOUT_MS = 2_000;

async function timed(name: string, ping: () => Promise<void>): Promise<DependencyHealth> {
  const startedAt = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  try {
    await Promise.race([
      ping(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`${name} ping timed out after ${PING_TIMEOUT_MS}ms`)),
          PING_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    return { status: "up", latencyMs: Math.round(elapsed()) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.error({ dependency: name, err: error }, "health check dependency down");
    // The message is ours, not the driver's — connection strings stay out of responses.
    return {
      status: "down",
      latencyMs: Math.round(elapsed()),
      error: message.slice(0, 200),
    };
  }
}

export const healthRouter: Router = Router();

healthRouter.get("/health", async (_req, res) => {
  const [postgres, redis] = await Promise.all([
    timed("postgres", pingDatabase),
    timed("redis", pingRedis),
  ]);

  const healthy = postgres.status === "up" && redis.status === "up";

  const body: HealthResponse = healthResponseSchema.parse({
    status: healthy ? "ok" : "degraded",
    service: SERVICE_NAME,
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString(),
    dependencies: { postgres, redis },
  });

  res.status(healthy ? 200 : 503).json(body);
});
