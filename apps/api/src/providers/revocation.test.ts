import { beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../lib/crypto.js";

/**
 * Disconnect must revoke, not just forget.
 *
 * Deleting our row while the provider grant stays live would tell the user
 * "disconnected" and leave an unused but valid grant on their account. These tests
 * pin the order (revoke, then delete), the idempotent cases, and the rule that a
 * revocation failure never blocks the disconnect the user asked for.
 */

const findFirst = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const revokeAccess = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => [] as string[]);

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    mailAccount: {
      findFirst,
      delete: (...args: unknown[]) => {
        calls.push("delete");
        return del(...args);
      },
      update: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
  }),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
vi.mock("./registry.js", () => ({
  oauthClientFor: () => ({
    revokeAccess: (...args: unknown[]) => {
      calls.push("revoke");
      return revokeAccess(...args);
    },
  }),
  redirectUriFor: () => "http://localhost:4000/oauth/google/callback",
}));
vi.mock("../lib/mutex.js", () => ({
  withMutex: async (_key: string, fn: () => Promise<unknown>) => fn(),
}));

const { disconnectMailAccount } = await import("../services/mailAccounts.js");

const USER_ID = "user_1";
const MAIL_ACCOUNT_ID = "mail_1";

function rowWithTokens(overrides: Record<string, unknown> = {}) {
  const refresh = encrypt("stored-refresh-token");
  return {
    id: MAIL_ACCOUNT_ID,
    userId: USER_ID,
    provider: "GMAIL",
    emailAddress: "person@example.com",
    syncStatus: "ACTIVE",
    keyVersion: refresh.keyVersion,
    accessTokenEnc: null,
    accessTokenIv: null,
    accessTokenAuthTag: null,
    refreshTokenEnc: refresh.ciphertext,
    refreshTokenIv: refresh.iv,
    refreshTokenAuthTag: refresh.authTag,
    tokenExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("disconnectMailAccount", () => {
  beforeEach(() => {
    findFirst.mockReset();
    del.mockReset();
    revokeAccess.mockReset();
    calls.length = 0;
    del.mockResolvedValue({});
  });

  it("revokes the grant before deleting the row", async () => {
    findFirst
      .mockResolvedValueOnce({ id: MAIL_ACCOUNT_ID })
      .mockResolvedValueOnce(rowWithTokens());
    revokeAccess.mockResolvedValue({ revoked: true });

    const outcome = await disconnectMailAccount({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
    });

    expect(calls).toEqual(["revoke", "delete"]);
    expect(outcome).toEqual({ revoked: true });
  });

  it("hands the decrypted refresh token to the provider, not the ciphertext", async () => {
    findFirst
      .mockResolvedValueOnce({ id: MAIL_ACCOUNT_ID })
      .mockResolvedValueOnce(rowWithTokens());
    revokeAccess.mockResolvedValue({ revoked: true });

    await disconnectMailAccount({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });

    expect(revokeAccess).toHaveBeenCalledWith("stored-refresh-token");
  });

  it("still deletes the mailbox when revocation fails", async () => {
    findFirst
      .mockResolvedValueOnce({ id: MAIL_ACCOUNT_ID })
      .mockResolvedValueOnce(rowWithTokens());
    revokeAccess.mockRejectedValue(new Error("provider unreachable"));

    const outcome = await disconnectMailAccount({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
    });

    expect(del).toHaveBeenCalledTimes(1);
    // The user is told the grant may still be live rather than being reassured.
    expect(outcome.revoked).toBe(false);
  });

  it("passes through a provider that cannot revoke, with somewhere to finish", async () => {
    findFirst
      .mockResolvedValueOnce({ id: MAIL_ACCOUNT_ID })
      .mockResolvedValueOnce(rowWithTokens({ provider: "OUTLOOK" }));
    revokeAccess.mockResolvedValue({
      revoked: false,
      manageUrl: "https://myapplications.microsoft.com/",
    });

    const outcome = await disconnectMailAccount({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
    });

    expect(del).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      revoked: false,
      manageUrl: "https://myapplications.microsoft.com/",
    });
  });

  it("skips the provider call when there is no stored refresh token", async () => {
    findFirst.mockResolvedValueOnce({ id: MAIL_ACCOUNT_ID }).mockResolvedValueOnce(
      rowWithTokens({
        refreshTokenEnc: null,
        refreshTokenIv: null,
        refreshTokenAuthTag: null,
        syncStatus: "REVOKED",
      }),
    );

    const outcome = await disconnectMailAccount({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
    });

    expect(revokeAccess).not.toHaveBeenCalled();
    expect(outcome.revoked).toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("does not touch the provider for a mailbox that is not the user's", async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      disconnectMailAccount({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID }),
    ).rejects.toThrow(/Mailbox not found/);

    expect(revokeAccess).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
