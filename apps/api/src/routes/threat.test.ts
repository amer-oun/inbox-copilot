import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";

/**
 * Route contract for the threat surface (§6).
 *
 * Short by design, and the tests are mostly about the routes that are *absent*: a user
 * can tell us we were wrong, and there is nothing here that lets a request set a level,
 * clear a flag, or ask for an assessment on demand.
 */

const keypair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const privateKey = createPrivateKey(keypair.privateKey);
process.env["INTERNAL_JWT_PUBLIC_KEY"] = Buffer.from(keypair.publicKey).toString(
  "base64",
);

const recordThreatAppeal = vi.hoisted(() => vi.fn());

vi.mock("../services/security/appeals.js", () => ({ recordThreatAppeal }));
vi.mock("../services/ai/reply.js", () => ({ generateReplies: vi.fn() }));
vi.mock("../services/ai/compose.js", () => ({ composeMessage: vi.fn() }));
vi.mock("../services/send.js", () => ({ sendReply: vi.fn() }));
vi.mock("../services/ai/style.js", () => ({
  buildWritingStyle: vi.fn(),
  getWritingStyle: vi.fn(),
}));
vi.mock("../services/threads.js", () => ({ listThreads: vi.fn(), getThread: vi.fn() }));
vi.mock("../services/sync.js", () => ({
  startBackfill: vi.fn(),
  getSyncStatus: vi.fn(),
}));
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
const MESSAGE_ID = "cldd4kzai000308l3a1b2c3d4";

async function internalToken(subject = USER_ID): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(subject)
    .setIssuer("inbox-copilot-web")
    .setAudience("inbox-copilot-api")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

const APPEAL = {
  messageId: MESSAGE_ID,
  appeal: {
    createdAt: "2026-09-15T10:00:00.000Z",
    note: null,
    claimedLevel: "SUSPICIOUS",
    claimedScore: 57,
  },
};

beforeEach(() => {
  recordThreatAppeal.mockReset().mockResolvedValue(APPEAL);
});

describe("POST /messages/:messageId/threat-appeal", () => {
  it("records the appeal for the authenticated user", async () => {
    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/threat-appeal`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.appeal.claimedLevel).toBe("SUSPICIOUS");
    expect(recordThreatAppeal).toHaveBeenCalledWith({
      userId: USER_ID,
      messageId: MESSAGE_ID,
    });
  });

  it("accepts an optional note and trims it", async () => {
    recordThreatAppeal.mockResolvedValue({
      ...APPEAL,
      appeal: { ...APPEAL.appeal, note: "I know this sender" },
    });

    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/threat-appeal`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ note: "  I know this sender  " });

    expect(response.status).toBe(201);
    expect(recordThreatAppeal).toHaveBeenCalledWith({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      note: "I know this sender",
    });
  });

  it("works with no body at all", async () => {
    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/threat-appeal`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(201);
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/threat-appeal`)
      .send({});

    expect(response.status).toBe(401);
    expect(recordThreatAppeal).not.toHaveBeenCalled();
  });

  it("validates the message id", async () => {
    const response = await request(createApp())
      .post("/messages/not-a-cuid/threat-appeal")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({});

    expect(response.status).toBe(422);
    expect(recordThreatAppeal).not.toHaveBeenCalled();
  });

  it("rejects a note longer than the column expects", async () => {
    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/threat-appeal`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ note: "x".repeat(501) });

    expect(response.status).toBe(422);
  });

  it("ignores fields that are not part of the contract", async () => {
    /*
     * The important refusal: there is no way to talk the appeal into setting a level. The
     * schema has one optional field, and anything else a client sends is dropped rather
     * than forwarded.
     */
    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/threat-appeal`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ note: "fine", threatLevel: "SAFE", threatScore: 0, level: "SAFE" });

    expect(response.status).toBe(201);
    expect(recordThreatAppeal).toHaveBeenCalledWith({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      note: "fine",
    });
  });

  it("has no route that assesses a message on demand", async () => {
    // Assessment happens in the enrichment pipeline, from mail the sync engine fetched:
    // the one model-calling path stays out of reach of anything a page can trigger.
    const app = createApp();
    const token = `Bearer ${await internalToken()}`;

    for (const path of [
      `/messages/${MESSAGE_ID}/threat`,
      `/messages/${MESSAGE_ID}/assess`,
      `/messages/${MESSAGE_ID}/threat-level`,
    ]) {
      const response = await request(app).post(path).set("authorization", token).send({});
      expect(response.status).toBe(404);
    }
  });
});
