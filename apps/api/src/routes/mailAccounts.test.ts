import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { mailAccountListSchema } from "@inbox-copilot/shared";

/**
 * Route-level contract: who may call, and what may come back. The response
 * assertions exist to catch a token-shaped field leaking into JSON (rule 3).
 */

const keypair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
// jose signs with a KeyObject, not a PEM string.
const privateKey = createPrivateKey(keypair.privateKey);
const publicKey = keypair.publicKey;

// env.ts is imported before the app, so the middleware picks up this keypair.
process.env["INTERNAL_JWT_PUBLIC_KEY"] = Buffer.from(publicKey).toString("base64");

const listMailAccounts = vi.hoisted(() => vi.fn());
const startMailAccountConnect = vi.hoisted(() => vi.fn());
const disconnectMailAccount = vi.hoisted(() => vi.fn());

vi.mock("../services/mailAccounts.js", () => ({
  listMailAccounts,
  startMailAccountConnect,
  disconnectMailAccount,
}));
vi.mock("@inbox-copilot/db", () => ({ pingDatabase: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  pingRedis: vi.fn(),
  redis: { set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));

const { createApp } = await import("../app.js");

const USER_ID = "cldd4kzai000008l3a1b2c3d4";
const MAIL_ACCOUNT_ID = "cldd4kzai000108l3a1b2c3d4";

async function internalToken(
  overrides: { subject?: string; audience?: string; expires?: string } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(overrides.subject ?? USER_ID)
    .setIssuer("inbox-copilot-web")
    .setAudience(overrides.audience ?? "inbox-copilot-api")
    .setIssuedAt()
    .setExpirationTime(overrides.expires ?? "60s")
    .sign(privateKey);
}

const SAMPLE_ACCOUNT = {
  id: MAIL_ACCOUNT_ID,
  provider: "GMAIL" as const,
  emailAddress: "person@example.com",
  displayName: "Person Example",
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  syncStatus: "PENDING" as const,
  syncError: null,
  lastSyncedAt: null,
  createdAt: new Date().toISOString(),
  needsReconnect: false,
};

describe("mail account routes", () => {
  beforeEach(() => {
    listMailAccounts.mockReset();
    startMailAccountConnect.mockReset();
    disconnectMailAccount.mockReset();
  });

  describe("authentication", () => {
    it("rejects a request with no internal token", async () => {
      const res = await request(createApp()).get("/mail-accounts");

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
      expect(listMailAccounts).not.toHaveBeenCalled();
    });

    it("rejects a token signed by someone else", async () => {
      const other = createPrivateKey(
        generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey,
      );

      const forged = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setSubject(USER_ID)
        .setIssuer("inbox-copilot-web")
        .setAudience("inbox-copilot-api")
        .setIssuedAt()
        .setExpirationTime("60s")
        .sign(other);

      const res = await request(createApp())
        .get("/mail-accounts")
        .set("authorization", `Bearer ${forged}`);

      expect(res.status).toBe(401);
      expect(listMailAccounts).not.toHaveBeenCalled();
    });

    it("rejects a token minted for a different audience", async () => {
      const res = await request(createApp())
        .get("/mail-accounts")
        .set("authorization", `Bearer ${await internalToken({ audience: "elsewhere" })}`);

      expect(res.status).toBe(401);
    });

    it("rejects an expired token", async () => {
      const res = await request(createApp())
        .get("/mail-accounts")
        .set("authorization", `Bearer ${await internalToken({ expires: "-10s" })}`);

      expect(res.status).toBe(401);
    });

    it("does not say why the token was rejected", async () => {
      const res = await request(createApp())
        .get("/mail-accounts")
        .set("authorization", `Bearer ${await internalToken({ expires: "-10s" })}`);

      expect(res.body.error.message).toBe("Invalid internal token");
    });
  });

  describe("GET /mail-accounts", () => {
    it("returns the caller's mailboxes and nothing token-shaped", async () => {
      listMailAccounts.mockResolvedValue([SAMPLE_ACCOUNT]);

      const res = await request(createApp())
        .get("/mail-accounts")
        .set("authorization", `Bearer ${await internalToken()}`);

      expect(res.status).toBe(200);
      const body = mailAccountListSchema.parse(res.body);
      expect(body.accounts).toHaveLength(1);
      expect(listMailAccounts).toHaveBeenCalledWith(USER_ID);

      const raw = JSON.stringify(res.body);
      for (const forbidden of [
        "accessToken",
        "refreshToken",
        "TokenEnc",
        "authTag",
        "keyVersion",
        "iv",
      ]) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  describe("POST /mail-accounts/:provider/connect", () => {
    it("returns the provider consent URL", async () => {
      startMailAccountConnect.mockResolvedValue({
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=x",
      });

      const res = await request(createApp())
        .post("/mail-accounts/google/connect")
        .set("authorization", `Bearer ${await internalToken()}`);

      expect(res.status).toBe(201);
      expect(res.body.authorizeUrl).toContain("accounts.google.com");
      expect(startMailAccountConnect).toHaveBeenCalledWith({
        userId: USER_ID,
        provider: "google",
      });
    });

    it("rejects an unknown provider slug", async () => {
      const res = await request(createApp())
        .post("/mail-accounts/yahoo/connect")
        .set("authorization", `Bearer ${await internalToken()}`);

      expect(res.status).toBe(422);
      expect(startMailAccountConnect).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /mail-accounts/:mailAccountId", () => {
    it("disconnects the mailbox for the calling user and reports the revocation", async () => {
      disconnectMailAccount.mockResolvedValue({ revoked: true });

      const res = await request(createApp())
        .delete(`/mail-accounts/${MAIL_ACCOUNT_ID}`)
        .set("authorization", `Bearer ${await internalToken()}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revoked: true });
      expect(disconnectMailAccount).toHaveBeenCalledWith({
        userId: USER_ID,
        mailAccountId: MAIL_ACCOUNT_ID,
        // Threaded through for the audit row, so a vanished mailbox can be traced back
        // to the request that removed it.
        requestId: expect.any(String),
      });
    });

    it("passes on where to finish when the provider cannot be revoked", async () => {
      disconnectMailAccount.mockResolvedValue({
        revoked: false,
        manageUrl: "https://myapplications.microsoft.com/",
      });

      const res = await request(createApp())
        .delete(`/mail-accounts/${MAIL_ACCOUNT_ID}`)
        .set("authorization", `Bearer ${await internalToken()}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        revoked: false,
        manageUrl: "https://myapplications.microsoft.com/",
      });
    });

    it("rejects an id that is not a cuid", async () => {
      const res = await request(createApp())
        .delete("/mail-accounts/not-an-id")
        .set("authorization", `Bearer ${await internalToken()}`);

      expect(res.status).toBe(422);
      expect(disconnectMailAccount).not.toHaveBeenCalled();
    });
  });
});
