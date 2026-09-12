import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { startSyncResponseSchema, syncStatusResponseSchema } from "@inbox-copilot/shared";

/** Route contract for the two sync endpoints, including who may call them. */

const keypair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const privateKey = createPrivateKey(keypair.privateKey);
process.env["INTERNAL_JWT_PUBLIC_KEY"] = Buffer.from(keypair.publicKey).toString("base64");

const startBackfill = vi.hoisted(() => vi.fn());
const getSyncStatus = vi.hoisted(() => vi.fn());

vi.mock("../services/sync.js", () => ({ startBackfill, getSyncStatus }));
vi.mock("../services/mailAccounts.js", () => ({
  listMailAccounts: vi.fn(),
  startMailAccountConnect: vi.fn(),
  disconnectMailAccount: vi.fn(),
}));
vi.mock("@inbox-copilot/db", () => ({ pingDatabase: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  pingRedis: vi.fn(),
  redis: { set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));

const { createApp } = await import("../app.js");

const USER_ID = "cldd4kzai000008l3a1b2c3d4";
const MAIL_ACCOUNT_ID = "cldd4kzai000108l3a1b2c3d4";

async function internalToken(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(USER_ID)
    .setIssuer("inbox-copilot-web")
    .setAudience("inbox-copilot-api")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

const STATUS = {
  mailAccountId: MAIL_ACCOUNT_ID,
  syncStatus: "BACKFILLING" as const,
  syncError: null,
  lastSyncedAt: null,
  backfilledUntil: new Date("2025-01-01T00:00:00Z").toISOString(),
  hasCursor: false,
  threadCount: 40,
  messageCount: 120,
  job: {
    state: "active" as const,
    threadsProcessed: 40,
    attemptsMade: 1,
    failedReason: null,
  },
};

describe("POST /mail-accounts/:mailAccountId/sync", () => {
  beforeEach(() => {
    startBackfill.mockReset();
    getSyncStatus.mockReset();
  });

  it("enqueues a backfill and answers 202", async () => {
    startBackfill.mockResolvedValue({
      enqueued: true,
      jobId: `backfill-${MAIL_ACCOUNT_ID}`,
      syncStatus: "PENDING",
    });

    const res = await request(createApp())
      .post(`/mail-accounts/${MAIL_ACCOUNT_ID}/sync`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(res.status).toBe(202);
    expect(startSyncResponseSchema.parse(res.body).enqueued).toBe(true);
    expect(startBackfill).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
    });
  });

  it("reports enqueued:false when a backfill is already running", async () => {
    startBackfill.mockResolvedValue({
      enqueued: false,
      jobId: `backfill-${MAIL_ACCOUNT_ID}`,
      syncStatus: "BACKFILLING",
    });

    const res = await request(createApp())
      .post(`/mail-accounts/${MAIL_ACCOUNT_ID}/sync`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(res.status).toBe(202);
    expect(res.body.enqueued).toBe(false);
  });

  it("requires the internal token", async () => {
    const res = await request(createApp()).post(`/mail-accounts/${MAIL_ACCOUNT_ID}/sync`);

    expect(res.status).toBe(401);
    expect(startBackfill).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a cuid", async () => {
    const res = await request(createApp())
      .post("/mail-accounts/not-an-id/sync")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(res.status).toBe(422);
    expect(startBackfill).not.toHaveBeenCalled();
  });

  it("surfaces a revoked mailbox as a 409 with a reconnect hint", async () => {
    const { ConflictError } = await import("../lib/errors.js");
    startBackfill.mockRejectedValue(
      new ConflictError("Mailbox access was revoked; reconnect it before syncing", {
        needsReconnect: true,
      }),
    );

    const res = await request(createApp())
      .post(`/mail-accounts/${MAIL_ACCOUNT_ID}/sync`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ needsReconnect: true });
  });
});

describe("GET /mail-accounts/:mailAccountId/sync-status", () => {
  beforeEach(() => {
    startBackfill.mockReset();
    getSyncStatus.mockReset();
  });

  it("returns progress", async () => {
    getSyncStatus.mockResolvedValue(STATUS);

    const res = await request(createApp())
      .get(`/mail-accounts/${MAIL_ACCOUNT_ID}/sync-status`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(res.status).toBe(200);
    const body = syncStatusResponseSchema.parse(res.body);
    expect(body.threadCount).toBe(40);
    expect(body.job?.state).toBe("active");
  });

  it("leaks nothing token-shaped", async () => {
    getSyncStatus.mockResolvedValue(STATUS);

    const res = await request(createApp())
      .get(`/mail-accounts/${MAIL_ACCOUNT_ID}/sync-status`)
      .set("authorization", `Bearer ${await internalToken()}`);

    const raw = JSON.stringify(res.body);
    for (const forbidden of ["accessToken", "refreshToken", "TokenEnc", "authTag", "syncCursor"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("404s for a mailbox that is not the caller's", async () => {
    const { NotFoundError } = await import("../lib/errors.js");
    getSyncStatus.mockRejectedValue(new NotFoundError("Mailbox not found"));

    const res = await request(createApp())
      .get(`/mail-accounts/${MAIL_ACCOUNT_ID}/sync-status`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(res.status).toBe(404);
  });

  it("requires the internal token", async () => {
    const res = await request(createApp()).get(
      `/mail-accounts/${MAIL_ACCOUNT_ID}/sync-status`,
    );

    expect(res.status).toBe(401);
    expect(getSyncStatus).not.toHaveBeenCalled();
  });
});
