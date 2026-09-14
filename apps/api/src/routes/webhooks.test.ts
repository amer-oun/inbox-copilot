import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT, exportJWK } from "jose";

/**
 * The Gmail push webhook.
 *
 * Two things are under test, and keeping them apart is the point of the file:
 * *authentication* (a Google-signed token for our audience and service account), and
 * *what the payload is allowed to do* (select a mailbox, and nothing else). The second
 * is what makes a compromised topic boring rather than dangerous.
 */

// A key pair standing in for Google's. The JWKS endpoint is mocked to serve it, so the
// verification path runs for real — issuer, audience, signature, service account.
const keypair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const googleKey = createPrivateKey(keypair.privateKey);

const internal = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
process.env["INTERNAL_JWT_PUBLIC_KEY"] = Buffer.from(internal.publicKey).toString("base64");

const jwk = await exportJWK(createPrivateKey(keypair.privateKey));
const publicJwk = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid: "test-key" };

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: unknown) => {
    if (String(url).includes("oauth2/v3/certs")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  }),
);

const enqueueDelta = vi.hoisted(() => vi.fn());
vi.mock("../services/deltaSync.js", () => ({ enqueueDelta }));

const accountFindMany = vi.hoisted(() => vi.fn());
vi.mock("@inbox-copilot/db", () => ({
  prisma: { mailAccount: { findMany: accountFindMany } },
  pingDatabase: vi.fn(),
}));

vi.mock("../services/threads.js", () => ({ listThreads: vi.fn(), getThread: vi.fn() }));
vi.mock("../services/sync.js", () => ({ startBackfill: vi.fn(), getSyncStatus: vi.fn() }));
vi.mock("../services/mailAccounts.js", () => ({
  listMailAccounts: vi.fn(),
  startMailAccountConnect: vi.fn(),
  disconnectMailAccount: vi.fn(),
}));
vi.mock("../services/ai/reply.js", () => ({ generateReplies: vi.fn() }));
vi.mock("../services/ai/compose.js", () => ({ composeMessage: vi.fn() }));
vi.mock("../services/send.js", () => ({ sendReply: vi.fn() }));
vi.mock("../services/ai/style.js", () => ({
  buildWritingStyle: vi.fn(),
  getWritingStyle: vi.fn(),
}));
vi.mock("../lib/redis.js", () => ({
  pingRedis: vi.fn(),
  redis: { set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));

const { createApp } = await import("../app.js");
const { env } = await import("../lib/env.js");
const { resetPubsubKeys, expectedAudience } = await import("../lib/pubsub.js");

const USER_ID = "cldd4kzai000008l3a1b2c3d4";
const ACCOUNT_ID = "cldd4kzai000108l3a1b2c3d4";
const MAILBOX = "person@example.com";
const SERVICE_ACCOUNT = "gmail-push@inbox-copilot-test.iam.gserviceaccount.com";

async function pushToken(
  overrides: {
    audience?: string;
    issuer?: string;
    email?: string | null;
    emailVerified?: boolean;
  } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (overrides.email !== null) {
    claims["email"] = overrides.email ?? SERVICE_ACCOUNT;
    claims["email_verified"] = overrides.emailVerified ?? true;
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "test-key" })
    .setSubject("1234567890")
    .setIssuer(overrides.issuer ?? "https://accounts.google.com")
    .setAudience(overrides.audience ?? expectedAudience())
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(googleKey);
}

/** A Pub/Sub push body carrying Gmail's notification. */
function pushBody(payload: unknown = { emailAddress: MAILBOX, historyId: 987654 }) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      messageId: "pubsub-msg-1",
      publishTime: "2026-09-14T10:00:00Z",
    },
    subscription: "projects/inbox-copilot-test/subscriptions/gmail-push",
  };
}

beforeEach(() => {
  resetPubsubKeys();
  env.GMAIL_PUBSUB_SERVICE_ACCOUNT = SERVICE_ACCOUNT;
  env.GMAIL_WEBHOOK_DEV_TOKEN = "";
  enqueueDelta.mockReset().mockResolvedValue({ queued: true, jobId: "delta-1" });
  accountFindMany.mockReset().mockResolvedValue([{ id: ACCOUNT_ID, userId: USER_ID }]);
});

describe("authentication", () => {
  it("accepts a Google-signed token for our audience and service account", async () => {
    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", `Bearer ${await pushToken()}`)
      .send(pushBody());

    expect(response.status).toBe(204);
    expect(enqueueDelta).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: ACCOUNT_ID,
      reason: "webhook",
    });
  });

  it("refuses a request with no token", async () => {
    const response = await request(createApp()).post("/webhooks/gmail").send(pushBody());

    expect(response.status).toBe(401);
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it("refuses a token signed by somebody else", async () => {
    const forged = await new SignJWT({ email: SERVICE_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer("https://accounts.google.com")
      .setAudience(expectedAudience())
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(createPrivateKey(internal.privateKey));

    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", `Bearer ${forged}`)
      .send(pushBody());

    expect(response.status).toBe(401);
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it("refuses a token minted for a different audience", async () => {
    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", `Bearer ${await pushToken({ audience: "https://someone.else/hook" })}`)
      .send(pushBody());

    expect(response.status).toBe(401);
  });

  it("refuses a token from another service account", async () => {
    /*
     * Without this check, anyone with *any* Google service account could mint a valid
     * identity token for a URL they guessed. This is what makes the endpoint's secrecy
     * irrelevant.
     */
    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", `Bearer ${await pushToken({ email: "attacker@evil.iam.gserviceaccount.com" })}`)
      .send(pushBody());

    expect(response.status).toBe(401);
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it("refuses a token whose email is not verified", async () => {
    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", `Bearer ${await pushToken({ emailVerified: false })}`)
      .send(pushBody());

    expect(response.status).toBe(401);
  });

  it("refuses a token from the wrong issuer", async () => {
    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", `Bearer ${await pushToken({ issuer: "https://evil.example" })}`)
      .send(pushBody());

    expect(response.status).toBe(401);
  });

  it("says nothing about why it refused", async () => {
    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", "Bearer nonsense")
      .send(pushBody());

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: "UNAUTHORIZED", message: "Push verification failed" },
    });
  });
});

describe("the development token", () => {
  it("is accepted outside production when it is configured", async () => {
    env.GMAIL_WEBHOOK_DEV_TOKEN = "local-only-secret";

    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", "Bearer local-only-secret")
      .send(pushBody());

    expect(response.status).toBe(204);
    expect(enqueueDelta).toHaveBeenCalled();
  });

  it("is ignored in production even when it is set", async () => {
    // The one path that would accept a hand-written token, made unreachable in a
    // deployment rather than merely discouraged.
    env.GMAIL_WEBHOOK_DEV_TOKEN = "local-only-secret";
    env.NODE_ENV = "production";

    try {
      const response = await request(createApp())
        .post("/webhooks/gmail")
        .set("authorization", "Bearer local-only-secret")
        .send(pushBody());

      expect(response.status).toBe(401);
      expect(enqueueDelta).not.toHaveBeenCalled();
    } finally {
      env.NODE_ENV = "test";
    }
  });

  it("is not a wildcard: a wrong value is still refused", async () => {
    env.GMAIL_WEBHOOK_DEV_TOKEN = "local-only-secret";

    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set("authorization", "Bearer guess")
      .send(pushBody());

    expect(response.status).toBe(401);
  });
});

describe("the payload", () => {
  beforeEach(() => {
    env.GMAIL_WEBHOOK_DEV_TOKEN = "local-only-secret";
  });

  const auth = { authorization: "Bearer local-only-secret" };

  it("uses the address only to look up mailboxes we already own", async () => {
    await request(createApp()).post("/webhooks/gmail").set(auth).send(pushBody());

    expect(accountFindMany).toHaveBeenCalledWith({
      where: {
        provider: "GMAIL",
        emailAddress: MAILBOX,
        syncStatus: { not: "REVOKED" },
      },
      select: { id: true, userId: true },
    });
  });

  it("lower-cases the address, since Gmail's casing is not ours", async () => {
    await request(createApp())
      .post("/webhooks/gmail")
      .set(auth)
      .send(pushBody({ emailAddress: "Person@Example.com", historyId: 1 }));

    expect(accountFindMany.mock.calls[0]?.[0]?.where?.emailAddress).toBe(MAILBOX);
  });

  it("never passes the claimed history id to the sync", async () => {
    /*
     * The core of "trigger, not data". Believing this number would let whoever can
     * publish to the topic decide how far back we read — or, with a high value, skip
     * history we never fetched.
     */
    await request(createApp())
      .post("/webhooks/gmail")
      .set(auth)
      .send(pushBody({ emailAddress: MAILBOX, historyId: 999999999 }));

    const enqueued = enqueueDelta.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(enqueued).sort()).toEqual(["mailAccountId", "reason", "userId"]);
    expect(JSON.stringify(enqueued)).not.toContain("999999999");
  });

  it("acknowledges a notification for a mailbox nobody has connected", async () => {
    // A stale watch from a previous deployment against the same topic. A retry would
    // find the same nothing, forever.
    accountFindMany.mockResolvedValue([]);

    const response = await request(createApp())
      .post("/webhooks/gmail")
      .set(auth)
      .send(pushBody({ emailAddress: "stranger@example.com" }));

    expect(response.status).toBe(204);
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it("acknowledges an unparseable payload rather than looping", async () => {
    for (const body of [
      {},
      { message: {} },
      { message: { data: "not-base64-json" } },
      { message: { data: Buffer.from("{}", "utf8").toString("base64") } },
    ]) {
      const response = await request(createApp()).post("/webhooks/gmail").set(auth).send(body);
      expect(response.status).toBe(204);
    }
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it("queues one delta per user when two people connect the same mailbox", async () => {
    accountFindMany.mockResolvedValue([
      { id: "acct_a", userId: "user_a" },
      { id: "acct_b", userId: "user_b" },
    ]);

    await request(createApp()).post("/webhooks/gmail").set(auth).send(pushBody());

    expect(enqueueDelta).toHaveBeenCalledTimes(2);
  });

  it("does no syncing itself", async () => {
    // It verifies, enqueues and answers. Syncing inline would hold Pub/Sub's connection
    // for the length of a Gmail read and let a burst become concurrent syncs.
    const response = await request(createApp()).post("/webhooks/gmail").set(auth).send(pushBody());

    expect(response.status).toBe(204);
    expect(response.text).toBe("");
  });
});

describe("the wrong method", () => {
  it("answers 405 with a hint, so a misconfigured subscription is diagnosable", async () => {
    const response = await request(createApp()).get("/webhooks/gmail");

    expect(response.status).toBe(405);
    expect(response.body.error.code).toBe("METHOD_NOT_ALLOWED");
  });
});
