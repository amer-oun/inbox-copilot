import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";

/**
 * Route contracts for phase 10: scheduled send, follow-ups, translation.
 *
 * The assertion this file exists for is the one about the *URL space* rather than any
 * one handler. Rule 1 says every AI output is a draft and sending is a separate,
 * user-initiated call — and adding a delay is exactly the change that could break it,
 * because "send this later" invites an endpoint that takes a draft id and a time. There
 * is no such endpoint, and the test at the bottom of the scheduling block is what keeps
 * it that way.
 */

const keypair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const privateKey = createPrivateKey(keypair.privateKey);
process.env["INTERNAL_JWT_PUBLIC_KEY"] = Buffer.from(keypair.publicKey).toString("base64");

const scheduleReply = vi.hoisted(() => vi.fn());
const scheduleNewMessage = vi.hoisted(() => vi.fn());
const listScheduledEmails = vi.hoisted(() => vi.fn());
const cancelScheduledEmail = vi.hoisted(() => vi.fn());
const listDueReminders = vi.hoisted(() => vi.fn());
const dismissReminder = vi.hoisted(() => vi.fn());
const snoozeReminder = vi.hoisted(() => vi.fn());
const translateMessage = vi.hoisted(() => vi.fn());
const resolveTargetLang = vi.hoisted(() => vi.fn());

vi.mock("../services/schedule.js", () => ({
  scheduleReply,
  scheduleNewMessage,
  listScheduledEmails,
  cancelScheduledEmail,
}));
vi.mock("../services/followUps.js", () => ({
  listDueReminders,
  dismissReminder,
  snoozeReminder,
}));
vi.mock("../services/ai/translate.js", () => ({ translateMessage, resolveTargetLang }));

vi.mock("../services/security/appeals.js", () => ({ recordThreatAppeal: vi.fn() }));
vi.mock("../services/ai/reply.js", () => ({ generateReplies: vi.fn() }));
vi.mock("../services/ai/compose.js", () => ({ composeMessage: vi.fn() }));
vi.mock("../services/send.js", () => ({ sendReply: vi.fn() }));
vi.mock("../services/ai/style.js", () => ({
  buildWritingStyle: vi.fn(),
  getWritingStyle: vi.fn(),
}));
vi.mock("../services/threads.js", () => ({ listThreads: vi.fn(), getThread: vi.fn() }));
vi.mock("../services/sync.js", () => ({ startBackfill: vi.fn(), getSyncStatus: vi.fn() }));
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
const SCHEDULED_ID = "cldd4kzai000208l3a1b2c3d4";
const REMINDER_ID = "cldd4kzai000308l3a1b2c3d4";
const MESSAGE_ID = "cldd4kzai000408l3a1b2c3d4";
const MAIL_ACCOUNT_ID = "cldd4kzai000508l3a1b2c3d4";

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

const SCHEDULED = {
  id: SCHEDULED_ID,
  threadId: THREAD_ID,
  to: ["Dana <dana@northwind.example>"],
  cc: [],
  subject: "Re: Invoice 4471",
  bodyText: "Sending the revised invoice today.",
  sendAt: "2026-09-17T08:00:00.000Z",
  sendAtLocal: "2026-09-17T09:00",
  timezone: "Africa/Tunis",
  status: "SCHEDULED",
  expectsReply: false,
  attempts: 0,
  lastError: null,
  sentAt: null,
  createdAt: "2026-09-16T08:00:00.000Z",
};

const REMINDER = {
  id: REMINDER_ID,
  threadId: THREAD_ID,
  subject: "Invoice 4471",
  recipients: ["dana@northwind.example"],
  dueAt: "2026-09-15T08:00:00.000Z",
  snoozedUntil: null,
  status: "TRIGGERED",
  reason: "Re: Invoice 4471",
  createdAt: "2026-09-12T08:00:00.000Z",
};

const TRANSLATION = {
  messageId: MESSAGE_ID,
  targetLang: "en",
  sourceLang: "fr",
  translatedText: "Hello, could you settle the invoice before Friday?",
  model: "claude-sonnet-5",
  fromCache: false,
  createdAt: "2026-09-16T08:00:00.000Z",
};

beforeEach(() => {
  scheduleReply.mockReset().mockResolvedValue(SCHEDULED);
  scheduleNewMessage.mockReset().mockResolvedValue({ ...SCHEDULED, threadId: null });
  listScheduledEmails.mockReset().mockResolvedValue([SCHEDULED]);
  cancelScheduledEmail.mockReset().mockResolvedValue({ ...SCHEDULED, status: "CANCELLED" });
  listDueReminders.mockReset().mockResolvedValue([REMINDER]);
  dismissReminder.mockReset().mockResolvedValue({ ...REMINDER, status: "DISMISSED" });
  snoozeReminder.mockReset().mockResolvedValue({ ...REMINDER, status: "SNOOZED" });
  translateMessage.mockReset().mockResolvedValue(TRANSLATION);
  resolveTargetLang.mockReset().mockResolvedValue("en");
});

describe("POST /scheduled/replies", () => {
  it("queues the submitted body with the wall clock and the zone", async () => {
    const response = await request(createApp())
      .post("/scheduled/replies")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({
        threadId: THREAD_ID,
        body: "Sending the revised invoice today.",
        sendAtLocal: "2026-09-17T09:00",
        timezone: "Africa/Tunis",
      });

    expect(response.status).toBe(201);
    expect(scheduleReply).toHaveBeenCalledWith({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "Sending the revised invoice today.",
      sendAtLocal: "2026-09-17T09:00",
      timezone: "Africa/Tunis",
      expectsReply: false,
    });
  });

  it("refuses an instant where a wall clock is required", async () => {
    /*
     * The §9 rule at the wire boundary. A caller that sends `"...T09:00:00Z"` has
     * already collapsed the zone into an instant, and accepting it would silently store
     * a time that cannot survive a DST change — so the schema rejects the shape rather
     * than the service having to detect the loss later.
     */
    const response = await request(createApp())
      .post("/scheduled/replies")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({
        threadId: THREAD_ID,
        body: "ok",
        sendAtLocal: "2026-09-17T09:00:00Z",
        timezone: "Africa/Tunis",
      });

    expect(response.status).toBe(422);
    expect(scheduleReply).not.toHaveBeenCalled();
  });

  it("requires a timezone, and will not invent one", async () => {
    const response = await request(createApp())
      .post("/scheduled/replies")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ threadId: THREAD_ID, body: "ok", sendAtLocal: "2026-09-17T09:00" });

    expect(response.status).toBe(422);
  });

  it("ignores anything else in the payload, including a recipient", async () => {
    /*
     * A scheduled reply's recipient is computed by the API from the parent message, the
     * same as an immediate one. A caller cannot name one here, so neither can an email
     * that talked a model into suggesting one.
     */
    await request(createApp())
      .post("/scheduled/replies")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({
        threadId: THREAD_ID,
        body: "ok",
        sendAtLocal: "2026-09-17T09:00",
        timezone: "Africa/Tunis",
        to: "attacker@evil.example",
        cc: ["attacker@evil.example"],
        subject: "Something else",
      });

    expect(scheduleReply).toHaveBeenCalledWith({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      sendAtLocal: "2026-09-17T09:00",
      timezone: "Africa/Tunis",
      expectsReply: false,
    });
  });

  it("carries the reminder flag when the user ticked it", async () => {
    await request(createApp())
      .post("/scheduled/replies")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({
        threadId: THREAD_ID,
        body: "ok",
        sendAtLocal: "2026-09-17T09:00",
        timezone: "Africa/Tunis",
        expectsReply: true,
      });

    expect(scheduleReply.mock.calls[0]?.[0].expectsReply).toBe(true);
  });

  it("requires authentication", async () => {
    const response = await request(createApp()).post("/scheduled/replies").send({
      threadId: THREAD_ID,
      body: "ok",
      sendAtLocal: "2026-09-17T09:00",
      timezone: "Africa/Tunis",
    });

    expect(response.status).toBe(401);
    expect(scheduleReply).not.toHaveBeenCalled();
  });

  it("has no route that schedules a stored draft by id", async () => {
    /*
     * Rule 1, stated against the URL space rather than against an implementation.
     *
     * Scheduling is the feature most likely to grow a "generate and send at 9am"
     * shortcut, because the delay makes it feel less like sending. It has not: every
     * route that can put mail on the wire takes the body, and these paths do not exist.
     */
    const app = createApp();
    const token = await internalToken();

    for (const path of [
      "/scheduled/drafts",
      `/threads/${THREAD_ID}/schedule-draft`,
      `/scheduled/replies/${SCHEDULED_ID}/send`,
      "/scheduled/generate",
    ]) {
      const response = await request(app)
        .post(path)
        .set("authorization", `Bearer ${token}`)
        .send({ draftId: SCHEDULED_ID, sendAtLocal: "2026-09-17T09:00" });
      expect(response.status).toBe(404);
    }
  });
});

describe("POST /scheduled/messages", () => {
  it("takes the recipient from the request, because there is no thread to derive one from", async () => {
    const response = await request(createApp())
      .post("/scheduled/messages")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({
        mailAccountId: MAIL_ACCOUNT_ID,
        to: ["dana@northwind.example"],
        subject: "Quote",
        body: "Here it is.",
        sendAtLocal: "2026-09-17T09:00",
        timezone: "Africa/Tunis",
      });

    expect(response.status).toBe(201);
    expect(scheduleNewMessage).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      to: ["dana@northwind.example"],
      cc: [],
      subject: "Quote",
      body: "Here it is.",
      sendAtLocal: "2026-09-17T09:00",
      timezone: "Africa/Tunis",
    });
  });

  it("refuses a malformed recipient", async () => {
    const response = await request(createApp())
      .post("/scheduled/messages")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({
        mailAccountId: MAIL_ACCOUNT_ID,
        to: ["not-an-address"],
        subject: "Quote",
        body: "Here it is.",
        sendAtLocal: "2026-09-17T09:00",
        timezone: "Africa/Tunis",
      });

    expect(response.status).toBe(422);
  });
});

describe("GET /scheduled", () => {
  it("returns the queue", async () => {
    const response = await request(createApp())
      .get("/scheduled")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.items[0].id).toBe(SCHEDULED_ID);
    // No status filter means the service's default, which includes failures.
    expect(listScheduledEmails).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it("passes a status filter through", async () => {
    await request(createApp())
      .get("/scheduled?status=SENT")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(listScheduledEmails).toHaveBeenCalledWith({ userId: USER_ID, status: "SENT" });
  });

  it("refuses a status that is not one of ours", async () => {
    const response = await request(createApp())
      .get("/scheduled?status=WHATEVER")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(422);
  });
});

describe("POST /scheduled/:id/cancel", () => {
  it("cancels by id", async () => {
    const response = await request(createApp())
      .post(`/scheduled/${SCHEDULED_ID}/cancel`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("CANCELLED");
    expect(cancelScheduledEmail).toHaveBeenCalledWith({
      userId: USER_ID,
      scheduledId: SCHEDULED_ID,
    });
  });

  it("is not a DELETE, because the record is what tells the user what they asked for", async () => {
    const response = await request(createApp())
      .delete(`/scheduled/${SCHEDULED_ID}`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(404);
  });
});

describe("GET /follow-ups", () => {
  it("returns what is due", async () => {
    const response = await request(createApp())
      .get("/follow-ups")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.items[0].threadId).toBe(THREAD_ID);
  });

  it("has no route that creates a reminder", async () => {
    /*
     * A reminder exists because the send path made one, so it always names a message we
     * know went out and a thread we can watch. A caller-created reminder would be one
     * the check job could never resolve — it would sit there until dismissed by hand,
     * which is the behaviour that teaches people to ignore the list.
     */
    const response = await request(createApp())
      .post("/follow-ups")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ threadId: THREAD_ID, dueAt: "2026-09-20T08:00:00.000Z" });

    expect(response.status).toBe(404);
  });
});

describe("follow-up actions", () => {
  it("dismisses", async () => {
    const response = await request(createApp())
      .post(`/follow-ups/${REMINDER_ID}/dismiss`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(200);
    expect(dismissReminder).toHaveBeenCalledWith({ userId: USER_ID, reminderId: REMINDER_ID });
  });

  it("snoozes for a default of three days when no body is sent", async () => {
    await request(createApp())
      .post(`/follow-ups/${REMINDER_ID}/snooze`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(snoozeReminder).toHaveBeenCalledWith({
      userId: USER_ID,
      reminderId: REMINDER_ID,
      days: 3,
    });
  });

  it("refuses an absurd snooze", async () => {
    // Days rather than a timestamp, bounded: the alternative is a reminder that arrives
    // in 2031 by typo.
    const response = await request(createApp())
      .post(`/follow-ups/${REMINDER_ID}/snooze`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ days: 4000 });

    expect(response.status).toBe(422);
  });
});

describe("POST /messages/:messageId/translate", () => {
  it("translates into the requested language", async () => {
    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/translate`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ targetLang: "en" });

    expect(response.status).toBe(200);
    expect(response.body.translatedText).toBe(TRANSLATION.translatedText);
    expect(resolveTargetLang).toHaveBeenCalledWith({ userId: USER_ID, requested: "en" });
  });

  it("resolves the language on the server when the request omits it", async () => {
    // The default lives in `UserSettings`, and it is read here rather than filled in by
    // the UI so that "my default language" is one fact in one place.
    await request(createApp())
      .post(`/messages/${MESSAGE_ID}/translate`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({});

    expect(resolveTargetLang).toHaveBeenCalledWith({ userId: USER_ID });
    expect(translateMessage).toHaveBeenCalledWith({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      targetLang: "en",
    });
  });

  it("reports a cache hit on the wire", async () => {
    // So the UI can say "no new AI call" honestly rather than guessing.
    translateMessage.mockResolvedValue({ ...TRANSLATION, fromCache: true });

    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/translate`)
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ targetLang: "en" });

    expect(response.body.fromCache).toBe(true);
  });

  it("refuses a message id that is not a cuid", async () => {
    const response = await request(createApp())
      .post("/messages/not-an-id/translate")
      .set("authorization", `Bearer ${await internalToken()}`)
      .send({ targetLang: "en" });

    expect(response.status).toBe(422);
    expect(translateMessage).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const response = await request(createApp())
      .post(`/messages/${MESSAGE_ID}/translate`)
      .send({ targetLang: "en" });

    expect(response.status).toBe(401);
    expect(translateMessage).not.toHaveBeenCalled();
  });

  it("is not a GET, because the first call for a pair spends tokens", async () => {
    // A GET that bills is a GET a prefetcher, a link preview or a browser retry can bill
    // twice. Every later call for the same pair is free, but the method describes the
    // worst case.
    const response = await request(createApp())
      .get(`/messages/${MESSAGE_ID}/translate`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(404);
  });
});
