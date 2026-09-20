import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";

/**
 * Route contract for drafting, composing and sending.
 *
 * The shape of the URL space is the enforcement of rule 1, so most of these tests are
 * about what the routes *refuse*: there is no way to ask the server to generate and
 * send in one call, and the send route never consults a model.
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

const generateReplies = vi.hoisted(() => vi.fn());
const composeMessage = vi.hoisted(() => vi.fn());
const sendReply = vi.hoisted(() => vi.fn());
const buildWritingStyle = vi.hoisted(() => vi.fn());
const getWritingStyle = vi.hoisted(() => vi.fn());

vi.mock("../services/ai/reply.js", () => ({ generateReplies }));
vi.mock("../services/ai/compose.js", () => ({ composeMessage }));
vi.mock("../services/send.js", () => ({ sendReply }));
vi.mock("../services/ai/style.js", () => ({ buildWritingStyle, getWritingStyle }));
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
const THREAD_ID = "cldd4kzai000108l3a1b2c3d4";
const DRAFT_ID = "cldd4kzai000208l3a1b2c3d4";

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

const DRAFTS = {
  threadId: THREAD_ID,
  tone: "PROFESSIONAL",
  styleApplied: true,
  drafts: [
    {
      id: DRAFT_ID,
      tone: "PROFESSIONAL",
      label: "Accept",
      body: "Will do.",
      model: "claude-sonnet-5",
      createdAt: "2026-09-13T10:00:00.000Z",
    },
  ],
};

const SENT = {
  providerMessageId: "sent_1",
  providerThreadId: "gmail_thread_1",
  sentAt: "2026-09-13T10:05:00.000Z",
  usedDraftId: DRAFT_ID,
  edited: false,
  // §9: null unless the user ticked "remind me if nobody replies".
  reminderId: null,
};

beforeEach(() => {
  generateReplies.mockReset().mockResolvedValue(DRAFTS);
  composeMessage.mockReset().mockResolvedValue({
    subject: "Renewal timing",
    body: "Hi Dana,",
    model: "claude-sonnet-5",
    contextMessages: 2,
    styleApplied: true,
  });
  sendReply.mockReset().mockResolvedValue(SENT);
  buildWritingStyle.mockReset().mockResolvedValue({ style: null, sampleCount: 0 });
  getWritingStyle.mockReset().mockResolvedValue(null);
});

describe("POST /threads/:id/replies", () => {
  it("returns three drafts for the authenticated user", async () => {
    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/replies`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ tone: "CONCISE" });

    expect(response.status).toBe(201);
    expect(response.body.drafts).toHaveLength(1);
    expect(generateReplies).toHaveBeenCalledWith({
      userId: USER_ID,
      threadId: THREAD_ID,
      tone: "CONCISE",
    });
  });

  it("omits the tone entirely when the caller did not choose one", async () => {
    // `exactOptionalPropertyTypes`: passing `tone: undefined` is not the same as not
    // passing it, and the service reads "absent" as "use the user's default".
    await request(createApp())
      .post(`/threads/${THREAD_ID}/replies`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({});

    expect(generateReplies).toHaveBeenCalledWith({
      userId: USER_ID,
      threadId: THREAD_ID,
    });
  });

  it("rejects a tone that is not in the enum", async () => {
    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/replies`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ tone: "SARCASTIC" });

    expect(response.status).toBe(422);
    expect(generateReplies).not.toHaveBeenCalled();
  });

  it("rejects a malformed thread id before reaching the service", async () => {
    const response = await request(createApp())
      .post("/threads/not-a-cuid/replies")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({});

    expect(response.status).toBe(422);
    expect(generateReplies).not.toHaveBeenCalled();
  });

  it("needs an internal token", async () => {
    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/replies`)
      .send({});

    expect(response.status).toBe(401);
    expect(generateReplies).not.toHaveBeenCalled();
  });
});

describe("POST /threads/:id/reply", () => {
  it("sends the submitted body and reports the provider ids", async () => {
    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/reply`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ body: "Sending a revised invoice today.", draftId: DRAFT_ID });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(SENT);
    expect(sendReply).toHaveBeenCalledWith({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "Sending a revised invoice today.",
      draftId: DRAFT_ID,
      expectsReply: false,
    });
  });

  it("refuses a request with no body text", async () => {
    /*
     * The important negative case. There is no "send draft N" form of this request:
     * the text must be in the payload, which means a person had it on screen.
     */
    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/reply`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ draftId: DRAFT_ID });

    expect(response.status).toBe(422);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("refuses an empty body", async () => {
    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/reply`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ body: "" });

    expect(response.status).toBe(422);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("ignores anything else in the payload, including a tone or a prompt", async () => {
    await request(createApp())
      .post(`/threads/${THREAD_ID}/reply`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ body: "ok", tone: "FRIENDLY", regenerate: true, to: "attacker@evil.test" });

    expect(sendReply).toHaveBeenCalledWith({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      // Defaulted by the schema, not taken from the payload's extra keys.
      expectsReply: false,
    });
  });

  it("calls no model: the send path has no drafting service", async () => {
    await request(createApp())
      .post(`/threads/${THREAD_ID}/reply`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ body: "ok" });

    expect(generateReplies).not.toHaveBeenCalled();
    expect(composeMessage).not.toHaveBeenCalled();
  });

  it("needs an internal token", async () => {
    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/reply`)
      .send({ body: "ok" });

    expect(response.status).toBe(401);
    expect(sendReply).not.toHaveBeenCalled();
  });
});

describe("POST /compose", () => {
  it("returns a subject and body for a recipient the caller named", async () => {
    const response = await request(createApp())
      .post("/compose")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ to: "Dana@Northwind.example", intent: "Ask about the renewal date." });

    expect(response.status).toBe(200);
    expect(response.body.subject).toBe("Renewal timing");
    // Lowercased by the shared schema, so the correspondence lookup matches storage.
    expect(composeMessage).toHaveBeenCalledWith({
      userId: USER_ID,
      to: "dana@northwind.example",
      intent: "Ask about the renewal date.",
    });
  });

  it("rejects a recipient that is not an address", async () => {
    const response = await request(createApp())
      .post("/compose")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ to: "not-an-address", intent: "Hello." });

    expect(response.status).toBe(422);
    expect(composeMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty intent", async () => {
    const response = await request(createApp())
      .post("/compose")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ to: "dana@northwind.example", intent: "" });

    expect(response.status).toBe(422);
  });
});

describe("the writing style profile", () => {
  it("reads the stored profile, and reports its absence as null", async () => {
    const response = await request(createApp())
      .get("/writing-style")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ style: null });
  });

  it("rebuilds on request, and only forces when asked", async () => {
    const app = createApp();

    await request(app)
      .post("/writing-style")
      .set("authorization", `Bearer ${await internalToken()}`);
    expect(buildWritingStyle).toHaveBeenCalledWith({ userId: USER_ID, force: false });

    await request(app)
      .post("/writing-style?force=true")
      .set("authorization", `Bearer ${await internalToken()}`);
    expect(buildWritingStyle).toHaveBeenLastCalledWith({ userId: USER_ID, force: true });
  });

  it("needs an internal token", async () => {
    expect((await request(createApp()).get("/writing-style")).status).toBe(401);
  });
});

describe("the routes that do not exist", () => {
  it("has no endpoint that sends a stored draft by id", async () => {
    const token = await internalToken();
    const app = createApp();

    for (const path of [
      `/threads/${THREAD_ID}/replies/${DRAFT_ID}/send`,
      `/drafts/${DRAFT_ID}/send`,
      `/threads/${THREAD_ID}/send`,
      "/send",
    ]) {
      expect(
        (await request(app).post(path).set("authorization", `Bearer ${token}`)).status,
      ).toBe(404);
    }
  });

  it("does not accept a GET on the send route", async () => {
    const response = await request(createApp())
      .get(`/threads/${THREAD_ID}/reply`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(404);
    expect(sendReply).not.toHaveBeenCalled();
  });
});
