import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidGrantError, MailAccountRevokedError } from "../lib/errors.js";
import { encrypt } from "../lib/crypto.js";

/**
 * These tests are about the refresh *decision*, not about HTTP: the provider
 * client and Prisma are both mocked. What must hold is that a fresh token is
 * reused, an expiring one is refreshed under a lock, a rotated refresh token is
 * persisted, and `invalid_grant` revokes instead of retrying.
 */

const findFirst = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const refreshAccessToken = vi.hoisted(() => vi.fn());
const withMutex = vi.hoisted(() =>
  vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
);

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({ mailAccount: { findFirst, update } }),
}));
vi.mock("../lib/mutex.js", () => ({ withMutex }));
vi.mock("./registry.js", () => ({
  oauthClientFor: () => ({ refreshAccessToken }),
  redirectUriFor: () => "http://localhost:4000/oauth/google/callback",
}));

const { getAccessToken } = await import("./tokenManager.js");

const USER_ID = "user_1";
const MAIL_ACCOUNT_ID = "mail_1";

function vaultRow(overrides: Record<string, unknown> = {}) {
  const access = encrypt("stored-access-token");
  const refresh = encrypt("stored-refresh-token");
  return {
    id: MAIL_ACCOUNT_ID,
    userId: USER_ID,
    provider: "OUTLOOK",
    emailAddress: "user@example.com",
    syncStatus: "ACTIVE",
    keyVersion: access.keyVersion,
    accessTokenEnc: access.ciphertext,
    accessTokenIv: access.iv,
    accessTokenAuthTag: access.authTag,
    refreshTokenEnc: refresh.ciphertext,
    refreshTokenIv: refresh.iv,
    refreshTokenAuthTag: refresh.authTag,
    // Comfortably outside the five-minute skew.
    tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
    ...overrides,
  };
}

describe("getAccessToken", () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockReset();
    refreshAccessToken.mockReset();
    withMutex.mockClear();
    update.mockResolvedValue({});
  });

  it("returns the stored token when it is not close to expiry", async () => {
    findFirst.mockResolvedValue(vaultRow());

    await expect(getAccessToken(MAIL_ACCOUNT_ID, USER_ID)).resolves.toBe(
      "stored-access-token",
    );
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(withMutex).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the user", async () => {
    findFirst.mockResolvedValue(vaultRow());

    await getAccessToken(MAIL_ACCOUNT_ID, USER_ID);

    // The tenancy extension adds `userId`; the id filter is ours.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MAIL_ACCOUNT_ID } }),
    );
  });

  it("refreshes a token that expires inside the five-minute skew", async () => {
    findFirst.mockResolvedValue(
      vaultRow({ tokenExpiresAt: new Date(Date.now() + 60_000) }),
    );
    refreshAccessToken.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://graph.microsoft.com/Mail.Send"],
    });

    await expect(getAccessToken(MAIL_ACCOUNT_ID, USER_ID)).resolves.toBe(
      "new-access-token",
    );
    expect(refreshAccessToken).toHaveBeenCalledWith("stored-refresh-token");
  });

  it("holds a per-mailbox mutex while refreshing", async () => {
    findFirst.mockResolvedValue(
      vaultRow({ tokenExpiresAt: new Date(Date.now() + 60_000) }),
    );
    refreshAccessToken.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
    });

    await getAccessToken(MAIL_ACCOUNT_ID, USER_ID);

    expect(withMutex).toHaveBeenCalledWith(
      `token-refresh:${MAIL_ACCOUNT_ID}`,
      expect.any(Function),
      expect.objectContaining({ ttlMs: expect.any(Number) }),
    );
  });

  it("persists the rotated refresh token as ciphertext, never plaintext", async () => {
    findFirst.mockResolvedValue(
      vaultRow({ tokenExpiresAt: new Date(Date.now() + 60_000) }),
    );
    refreshAccessToken.mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
    });

    await getAccessToken(MAIL_ACCOUNT_ID, USER_ID);

    const data = update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data["refreshTokenEnc"]).toBeTypeOf("string");
    expect(data["refreshTokenIv"]).toBeTypeOf("string");
    expect(data["refreshTokenAuthTag"]).toBeTypeOf("string");
    expect(JSON.stringify(data)).not.toContain("rotated-refresh-token");
    expect(JSON.stringify(data)).not.toContain("new-access-token");
  });

  it("reuses the work of a concurrent refresher instead of rotating again", async () => {
    // First read: expiring. Second read (inside the lock): someone refreshed.
    findFirst
      .mockResolvedValueOnce(vaultRow({ tokenExpiresAt: new Date(Date.now() + 60_000) }))
      .mockResolvedValueOnce(vaultRow());

    await expect(getAccessToken(MAIL_ACCOUNT_ID, USER_ID)).resolves.toBe(
      "stored-access-token",
    );
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("marks the mailbox REVOKED on invalid_grant and does not retry", async () => {
    findFirst.mockResolvedValue(
      vaultRow({ tokenExpiresAt: new Date(Date.now() + 60_000) }),
    );
    refreshAccessToken.mockRejectedValue(
      new InvalidGrantError("Microsoft rejected the refresh token"),
    );

    await expect(getAccessToken(MAIL_ACCOUNT_ID, USER_ID)).rejects.toThrow(
      MailAccountRevokedError,
    );

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data["syncStatus"]).toBe("REVOKED");
    // The dead ciphertexts are dropped along with it.
    expect(data["refreshTokenEnc"]).toBeNull();
    expect(data["accessTokenEnc"]).toBeNull();
  });

  it("refuses a mailbox already known to be revoked without calling the provider", async () => {
    findFirst.mockResolvedValue(vaultRow({ syncStatus: "REVOKED" }));

    await expect(getAccessToken(MAIL_ACCOUNT_ID, USER_ID)).rejects.toThrow(
      MailAccountRevokedError,
    );
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(withMutex).not.toHaveBeenCalled();
  });

  it("surfaces a reconnect prompt when there is no refresh token to use", async () => {
    findFirst.mockResolvedValue(
      vaultRow({
        tokenExpiresAt: new Date(Date.now() + 60_000),
        refreshTokenEnc: null,
        refreshTokenIv: null,
        refreshTokenAuthTag: null,
      }),
    );

    await expect(getAccessToken(MAIL_ACCOUNT_ID, USER_ID)).rejects.toThrow(
      /reconnect it to grant offline access/,
    );
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("404s for a mailbox that is not the user's", async () => {
    findFirst.mockResolvedValue(null);

    await expect(getAccessToken(MAIL_ACCOUNT_ID, USER_ID)).rejects.toThrow(
      /Mailbox not found/,
    );
  });
});
