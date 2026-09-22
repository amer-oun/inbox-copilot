import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { DEMO_USER_ID } from "@inbox-copilot/shared";

/**
 * The public demo, at the HTTP boundary.
 *
 * Most of this file is about refusals, because that is the demo's promise: a demo
 * session reaches the same routes as an account, and every route that sends,
 * schedules or touches a mailbox connection answers 403 before its service runs.
 * The UI hides nothing — these are the tests that make hiding unnecessary.
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
process.env["DEMO_MODE"] = "true";

const sendReply = vi.hoisted(() => vi.fn());
const generateReplies = vi.hoisted(() => vi.fn());
const composeMessage = vi.hoisted(() => vi.fn());
const buildWritingStyle = vi.hoisted(() => vi.fn());
const scheduleReply = vi.hoisted(() => vi.fn());
const scheduleNewMessage = vi.hoisted(() => vi.fn());
const cancelScheduledEmail = vi.hoisted(() => vi.fn());
const startMailAccountConnect = vi.hoisted(() => vi.fn());
const disconnectMailAccount = vi.hoisted(() => vi.fn());
const startBackfill = vi.hoisted(() => vi.fn());
const listThreads = vi.hoisted(() => vi.fn());
const recordThreatAppeal = vi.hoisted(() => vi.fn());
const dismissReminder = vi.hoisted(() => vi.fn());
const translateMessage = vi.hoisted(() => vi.fn());
const resolveTargetLang = vi.hoisted(() => vi.fn());
const demoReplies = vi.hoisted(() => vi.fn());
const demoTranslate = vi.hoisted(() => vi.fn());
const ensureDemoMailbox = vi.hoisted(() => vi.fn());
const markDemoChanged = vi.hoisted(() => vi.fn());
const startDemoSession = vi.hoisted(() => vi.fn());

vi.mock("../services/send.js", () => ({ sendReply }));
vi.mock("../services/ai/reply.js", () => ({ generateReplies }));
vi.mock("../services/ai/compose.js", () => ({ composeMessage }));
vi.mock("../services/ai/style.js", () => ({
  buildWritingStyle,
  getWritingStyle: vi.fn(),
}));
vi.mock("../services/schedule.js", () => ({
  scheduleReply,
  scheduleNewMessage,
  cancelScheduledEmail,
  listScheduledEmails: vi.fn(),
}));
vi.mock("../services/mailAccounts.js", () => ({
  listMailAccounts: vi.fn(),
  startMailAccountConnect,
  disconnectMailAccount,
}));
vi.mock("../services/sync.js", () => ({ startBackfill, getSyncStatus: vi.fn() }));
vi.mock("../services/threads.js", () => ({ listThreads, getThread: vi.fn() }));
vi.mock("../services/security/appeals.js", () => ({ recordThreatAppeal }));
vi.mock("../services/followUps.js", () => ({
  dismissReminder,
  snoozeReminder: vi.fn(),
  listDueReminders: vi.fn(),
}));
vi.mock("../services/ai/translate.js", () => ({ translateMessage, resolveTargetLang }));
vi.mock("../services/demo/ai.js", () => ({ demoReplies, demoTranslate }));
vi.mock("../services/demo/seed.js", () => ({
  ensureDemoMailbox,
  markDemoChanged,
  startDemoSession,
}));
vi.mock("@inbox-copilot/db", () => ({ pingDatabase: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  pingRedis: vi.fn(),
  redis: { set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));

const { createApp } = await import("../app.js");

const USER_ID = "cldd4kzai000008l3a1b2c3d4";
const THREAD_ID = "cdemothrd0000000000000001";
const MESSAGE_ID = "cdemomesg0000000000000201";
const MAILBOX_ID = "cdemoacct0000000000000001";
const SCHEDULED_ID = "cdemoschd0000000000000001";
const REMINDER_ID = "cdemoremd0000000000000001";
const SESSION_ID = "visit_abcdefghijklmnop";

async function token(
  subject: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(subject)
    .setIssuer("inbox-copilot-web")
    .setAudience("inbox-copilot-api")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

const demoToken = () => token(DEMO_USER_ID, { ses: "demo", sid: SESSION_ID });
const userToken = () => token(USER_ID, { ses: "user" });

beforeEach(() => {
  for (const mock of [
    sendReply,
    generateReplies,
    composeMessage,
    buildWritingStyle,
    scheduleReply,
    scheduleNewMessage,
    cancelScheduledEmail,
    startMailAccountConnect,
    disconnectMailAccount,
    startBackfill,
    listThreads,
    recordThreatAppeal,
    dismissReminder,
    translateMessage,
    demoReplies,
    demoTranslate,
    ensureDemoMailbox,
    markDemoChanged,
    startDemoSession,
  ]) {
    mock.mockReset();
  }
  resolveTargetLang.mockReset().mockResolvedValue("en");
  ensureDemoMailbox.mockResolvedValue(undefined);
  listThreads.mockResolvedValue({ items: [], nextCursor: null });
});

describe("what a demo session can never do", () => {
  const refusals: Array<{
    name: string;
    method: "post" | "delete";
    path: string;
    body?: unknown;
    service: ReturnType<typeof vi.fn>;
  }> = [
    {
      name: "send a reply",
      method: "post",
      path: `/threads/${THREAD_ID}/reply`,
      body: { body: "Signed and attached." },
      service: sendReply,
    },
    {
      name: "schedule a reply",
      method: "post",
      path: "/scheduled/replies",
      body: {
        threadId: THREAD_ID,
        body: "Later.",
        sendAtLocal: "2030-01-01T09:00",
        timezone: "Europe/London",
      },
      service: scheduleReply,
    },
    {
      name: "schedule a new message",
      method: "post",
      path: "/scheduled/messages",
      body: {
        mailAccountId: MAILBOX_ID,
        to: ["someone@example.com"],
        subject: "Hi",
        body: "Later.",
        sendAtLocal: "2030-01-01T09:00",
        timezone: "Europe/London",
      },
      service: scheduleNewMessage,
    },
    {
      name: "connect a mailbox",
      method: "post",
      path: "/mail-accounts/google/connect",
      service: startMailAccountConnect,
    },
    {
      name: "disconnect the demo mailbox",
      method: "delete",
      path: `/mail-accounts/${MAILBOX_ID}`,
      service: disconnectMailAccount,
    },
    {
      name: "sync the demo mailbox",
      method: "post",
      path: `/mail-accounts/${MAILBOX_ID}/sync`,
      service: startBackfill,
    },
    {
      name: "compose a new message",
      method: "post",
      path: "/compose",
      body: { intent: "Say hello", to: ["someone@example.com"] },
      service: composeMessage,
    },
    {
      name: "rebuild the writing style",
      method: "post",
      path: "/writing-style",
      service: buildWritingStyle,
    },
  ];

  for (const { name, method, path, body, service } of refusals) {
    it(`refuses to ${name}, before the service runs`, async () => {
      const response = await request(createApp())
        [method](path)
        .set("authorization", `Bearer ${await demoToken()}`)
        .send(body ?? {});

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("DEMO_READ_ONLY");
      expect(response.body.error.message).toMatch(/demo/i);
      expect(service).not.toHaveBeenCalled();
    });
  }

  it("still lets a real account send", async () => {
    sendReply.mockResolvedValue({
      providerMessageId: "sent_1",
      providerThreadId: "gmail_thread_1",
      sentAt: "2026-09-13T10:05:00.000Z",
      usedDraftId: null,
      edited: false,
      reminderId: null,
    });

    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/reply`)
      .set("authorization", `Bearer ${await userToken()}`)
      .send({ body: "Signed and attached." });

    expect(response.status).toBe(201);
    expect(sendReply).toHaveBeenCalledTimes(1);
  });
});

describe("what a demo session can do", () => {
  it("reads the inbox as the demo user, after making sure it is seeded", async () => {
    const response = await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${await demoToken()}`);

    expect(response.status).toBe(200);
    expect(ensureDemoMailbox).toHaveBeenCalled();
    expect(listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ userId: DEMO_USER_ID }),
    );
  });

  it("does not touch the demo mailbox for a real account", async () => {
    await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${await userToken()}`);

    expect(ensureDemoMailbox).not.toHaveBeenCalled();
  });

  it("drafts through the demo path, never the live one directly", async () => {
    demoReplies.mockResolvedValue({
      threadId: THREAD_ID,
      tone: "PROFESSIONAL",
      styleApplied: true,
      drafts: [],
    });

    const response = await request(createApp())
      .post(`/threads/${THREAD_ID}/replies`)
      .set("authorization", `Bearer ${await demoToken()}`)
      .send({ tone: "PROFESSIONAL" });

    expect(response.status).toBe(201);
    expect(generateReplies).not.toHaveBeenCalled();
    expect(demoReplies).toHaveBeenCalledWith({
      user: { id: DEMO_USER_ID, demo: true, demoSessionId: SESSION_ID },
      threadId: THREAD_ID,
      tone: "PROFESSIONAL",
    });
  });

  it("translates through the demo path", async () => {
    demoTranslate.mockResolvedValue({
      messageId: MESSAGE_ID,
      targetLang: "en",
      sourceLang: "fr",
      translatedText: "Hello Sam,",
      model: "demo-sample",
      fromCache: true,
      createdAt: "2026-09-13T10:00:00.000Z",
    });

    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/translate`)
      .set("authorization", `Bearer ${await demoToken()}`)
      .send({ targetLang: "en" });

    expect(response.status).toBe(200);
    expect(translateMessage).not.toHaveBeenCalled();
    expect(demoTranslate).toHaveBeenCalledTimes(1);
  });

  it("marks the mailbox changed when a visitor appeals a verdict", async () => {
    recordThreatAppeal.mockResolvedValue({
      messageId: MESSAGE_ID,
      recorded: true,
      appeal: {
        createdAt: "2026-09-13T10:00:00.000Z",
        note: null,
        claimedLevel: "PHISHING",
        claimedScore: 100,
      },
    });

    await request(createApp())
      .post(`/messages/${MESSAGE_ID}/threat-appeal`)
      .set("authorization", `Bearer ${await demoToken()}`)
      .send({});

    expect(markDemoChanged).toHaveBeenCalledTimes(1);
  });

  it("marks the mailbox changed when a visitor dismisses a reminder or cancels a send", async () => {
    dismissReminder.mockRejectedValue(new Error("stop after the service"));
    cancelScheduledEmail.mockRejectedValue(new Error("stop after the service"));

    // The mark comes after the service succeeds, so a failing one leaves it unset.
    await request(createApp())
      .post(`/follow-ups/${REMINDER_ID}/dismiss`)
      .set("authorization", `Bearer ${await demoToken()}`);
    await request(createApp())
      .post(`/scheduled/${SCHEDULED_ID}/cancel`)
      .set("authorization", `Bearer ${await demoToken()}`);

    expect(dismissReminder).toHaveBeenCalledTimes(1);
    expect(cancelScheduledEmail).toHaveBeenCalledTimes(1);
    expect(markDemoChanged).not.toHaveBeenCalled();
  });
});

describe("POST /demo/session", () => {
  it("restores the mailbox for a new demo visit", async () => {
    startDemoSession.mockResolvedValue({
      reset: true,
      seededAt: "2026-09-13T10:00:00.000Z",
    });

    const response = await request(createApp())
      .post("/demo/session")
      .set("authorization", `Bearer ${await demoToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.reset).toBe(true);
  });

  it("is refused for a real account, which must not be able to reset the demo", async () => {
    const response = await request(createApp())
      .post("/demo/session")
      .set("authorization", `Bearer ${await userToken()}`);

    expect(response.status).toBe(403);
    expect(startDemoSession).not.toHaveBeenCalled();
  });
});

describe("the two kinds of session cannot be confused", () => {
  it("refuses a demo claim that names a real user", async () => {
    const response = await request(createApp())
      .get("/threads")
      .set(
        "authorization",
        `Bearer ${await token(USER_ID, { ses: "demo", sid: SESSION_ID })}`,
      );

    expect(response.status).toBe(401);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("refuses a user claim that names the demo user", async () => {
    const response = await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${await token(DEMO_USER_ID, { ses: "user" })}`);

    expect(response.status).toBe(401);
  });

  it("refuses a claim-less token that names the demo user", async () => {
    // A token minted before the claim existed is a real session, and the demo user is
    // not one.
    const response = await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${await token(DEMO_USER_ID)}`);

    expect(response.status).toBe(401);
  });

  it("refuses a demo token without a visit id", async () => {
    const response = await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${await token(DEMO_USER_ID, { ses: "demo" })}`);

    expect(response.status).toBe(401);
  });

  it("refuses an unknown session kind", async () => {
    const response = await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${await token(USER_ID, { ses: "admin" })}`);

    expect(response.status).toBe(401);
  });

  it("still accepts a claim-less token for a real user", async () => {
    const response = await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${await token(USER_ID)}`);

    expect(response.status).toBe(200);
  });
});
