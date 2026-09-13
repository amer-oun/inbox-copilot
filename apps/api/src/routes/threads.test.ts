import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";

/**
 * Route contract for the two read endpoints, including who may call them and what
 * an untrusted query string can do.
 */

const keypair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const privateKey = createPrivateKey(keypair.privateKey);
process.env["INTERNAL_JWT_PUBLIC_KEY"] = Buffer.from(keypair.publicKey).toString("base64");

const listThreads = vi.hoisted(() => vi.fn());
const getThread = vi.hoisted(() => vi.fn());

vi.mock("../services/threads.js", () => ({ listThreads, getThread }));
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

const LIST_PAGE = {
  items: [
    {
      id: THREAD_ID,
      subject: "Invoice 4471",
      snippet: "Could you send a revised invoice",
      from: { name: "Dana", email: "dana@northwind.example" },
      messageCount: 2,
      lastMessageAt: "2026-09-12T09:00:00.000Z",
      isRead: false,
      isStarred: false,
      hasAttachments: false,
      category: "FINANCE" as const,
      priority: "HIGH" as const,
      priorityScore: 72,
      needsReply: true,
      language: "en",
      threatLevel: "UNKNOWN" as const,
      summaryHeadline: "Invoice 4471 disputed",
    },
  ],
  nextCursor: "eyJzY29yZSI6NzJ9",
};

const DETAIL = {
  id: THREAD_ID,
  subject: "Invoice 4471",
  participants: [{ name: "Dana", email: "dana@northwind.example" }],
  messageCount: 1,
  firstMessageAt: "2026-09-10T09:00:00.000Z",
  lastMessageAt: "2026-09-12T09:00:00.000Z",
  isRead: true,
  isStarred: false,
  category: "FINANCE" as const,
  priority: "HIGH" as const,
  priorityScore: 72,
  needsReply: true,
  language: "en",
  threatLevel: "UNKNOWN" as const,
  summary: null,
  messages: [
    {
      id: "cldd4kzai000208l3a1b2c3d4",
      from: { name: "Dana", email: "dana@northwind.example" },
      to: ["me@example.com"],
      cc: [],
      subject: "Invoice 4471",
      sentAt: "2026-09-10T09:00:00.000Z",
      isRead: true,
      isOutbound: false,
      bodyText: "hello",
      bodyHtmlSanitized: "<p>hello</p>",
      blockedRemoteImages: 2,
      attachments: [],
    },
  ],
};

beforeEach(() => {
  listThreads.mockReset().mockResolvedValue(LIST_PAGE);
  getThread.mockReset().mockResolvedValue(DETAIL);
});

describe("GET /threads", () => {
  it("returns a page for the authenticated user", async () => {
    const response = await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.nextCursor).toBe("eyJzY29yZSI6NzJ9");
    expect(listThreads).toHaveBeenCalledWith({
      userId: USER_ID,
      category: "ALL",
      limit: 25,
    });
  });

  it("requires the internal token", async () => {
    const response = await request(createApp()).get("/threads");

    expect(response.status).toBe(401);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("passes category, cursor and limit through", async () => {
    await request(createApp())
      .get("/threads?category=NEWSLETTER&cursor=abc&limit=5")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(listThreads).toHaveBeenCalledWith({
      userId: USER_ID,
      category: "NEWSLETTER",
      cursor: "abc",
      limit: 5,
    });
  });

  it("acts as the token's subject, not a query parameter", async () => {
    // The only source of identity is the JWT: a `userId` in the URL is ignored.
    const other = "cldd4kzai000908l3a1b2c3d4";
    await request(createApp())
      .get(`/threads?userId=${other}`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(listThreads.mock.calls[0]?.[0].userId).toBe(USER_ID);
  });

  it.each([
    ["an unknown category", "category=NOPE"],
    ["a limit above the cap", "limit=500"],
    ["a limit of zero", "limit=0"],
    ["a non-numeric limit", "limit=many"],
  ])("rejects %s with 422", async (_label, query) => {
    const response = await request(createApp())
      .get(`/threads?${query}`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(422);
    expect(listThreads).not.toHaveBeenCalled();
  });
});

describe("GET /threads/:threadId", () => {
  it("returns the thread with its messages", async () => {
    const response = await request(createApp())
      .get(`/threads/${THREAD_ID}`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(200);
    expect(response.body.messages[0].bodyHtmlSanitized).toBe("<p>hello</p>");
    expect(response.body.messages[0].blockedRemoteImages).toBe(2);
    expect(getThread).toHaveBeenCalledWith({ userId: USER_ID, threadId: THREAD_ID });
  });

  it("requires the internal token", async () => {
    const response = await request(createApp()).get(`/threads/${THREAD_ID}`);

    expect(response.status).toBe(401);
    expect(getThread).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a cuid before touching the service", async () => {
    const response = await request(createApp())
      .get("/threads/../../etc/passwd")
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(getThread).not.toHaveBeenCalled();
  });

  it("maps a service NotFound to 404", async () => {
    const { NotFoundError } = await import("../lib/errors.js");
    getThread.mockRejectedValue(new NotFoundError("Thread not found"));

    const response = await request(createApp())
      .get(`/threads/${THREAD_ID}`)
      .set("authorization", `Bearer ${await internalToken()}`);

    expect(response.status).toBe(404);
  });

  it("has no write route on the threads surface", async () => {
    // Phase 5 is read-only: nothing the browser can reach may mutate mail.
    const token = `Bearer ${await internalToken()}`;
    const app = createApp();

    for (const method of ["post", "patch", "delete"] as const) {
      const response = await request(app)[method](`/threads/${THREAD_ID}`).set("authorization", token);
      expect(response.status).toBe(404);
    }
  });
});
