import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { healthResponseSchema } from "@inbox-copilot/shared";

const pingDatabase = vi.hoisted(() => vi.fn<() => Promise<void>>());
const pingRedis = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("@inbox-copilot/db", () => ({ pingDatabase }));
vi.mock("../lib/redis.js", () => ({ pingRedis }));

const { createApp } = await import("../app.js");

describe("GET /health", () => {
  beforeEach(() => {
    pingDatabase.mockReset();
    pingRedis.mockReset();
  });

  it("returns 200 and ok when both dependencies answer", async () => {
    pingDatabase.mockResolvedValue(undefined);
    pingRedis.mockResolvedValue(undefined);

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.dependencies.postgres.status).toBe("up");
    expect(body.dependencies.redis.status).toBe("up");
  });

  it("returns 503 and degraded when Postgres is unreachable", async () => {
    pingDatabase.mockRejectedValue(new Error("connection refused"));
    pingRedis.mockResolvedValue(undefined);

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(503);
    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe("degraded");
    expect(body.dependencies.postgres.status).toBe("down");
    expect(body.dependencies.redis.status).toBe("up");
  });

  it("returns 503 when Redis is unreachable", async () => {
    pingDatabase.mockResolvedValue(undefined);
    pingRedis.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.dependencies.redis.status).toBe("down");
  });
});
