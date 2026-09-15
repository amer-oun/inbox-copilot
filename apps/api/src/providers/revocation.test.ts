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
const eventCreate = vi.hoisted(() => vi.fn());
const revokeAccess = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => [] as string[]);

/**
 * The delete and the audit row happen inside one transaction, so the mock provides one:
 * `$transaction(fn)` hands back a client whose writes push onto `calls`, which is how the
 * ordering assertions below can see both of them.
 */
vi.mock("@inbox-copilot/db", () => {
  const mailAccount = {
    findFirst,
    delete: (...args: unknown[]) => {
      calls.push("delete");
      return del(...args);
    },
    update: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  };
  const mailAccountEvent = {
    create: (...args: unknown[]) => {
      calls.push("audit");
      return eventCreate(...args);
    },
  };
  const client = {
    mailAccount,
    mailAccountEvent,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return {
    dbForUser: () => client,
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  };
});
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
    eventCreate.mockReset().mockResolvedValue({});
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

    // Revoke at the provider, then record, then delete — and the record is inside the
    // same transaction as the delete, so neither can happen without the other.
    expect(calls).toEqual(["revoke", "audit", "delete"]);
    expect(outcome).toEqual({ revoked: true });
  });

  it("writes an audit row that survives the mailbox", async () => {
    findFirst
      .mockResolvedValueOnce({
        id: MAIL_ACCOUNT_ID,
        provider: "GMAIL",
        emailAddress: "person@example.com",
      })
      .mockResolvedValueOnce(rowWithTokens());
    revokeAccess.mockResolvedValue({ revoked: true });

    await disconnectMailAccount({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      requestId: "req-abc-123",
    });

    expect(eventCreate.mock.calls[0]?.[0].data).toEqual({
      kind: "DISCONNECTED",
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      provider: "GMAIL",
      // The address, because "which mailbox vanished" is the question this answers.
      emailAddress: "person@example.com",
      requestId: "req-abc-123",
      grantRevoked: true,
    });
  });

  it("records that the grant was left live when revocation failed", async () => {
    findFirst
      .mockResolvedValueOnce({
        id: MAIL_ACCOUNT_ID,
        provider: "GMAIL",
        emailAddress: "person@example.com",
      })
      .mockResolvedValueOnce(rowWithTokens());
    revokeAccess.mockRejectedValue(new Error("provider unreachable"));

    await disconnectMailAccount({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });

    expect(eventCreate.mock.calls[0]?.[0].data).toMatchObject({ grantRevoked: false });
  });

  it("records a null request id rather than inventing one", async () => {
    // A disconnect from a script or a worker did not come from a request, and the row
    // should say so instead of implying a correlation that leads nowhere.
    findFirst
      .mockResolvedValueOnce({
        id: MAIL_ACCOUNT_ID,
        provider: "GMAIL",
        emailAddress: "person@example.com",
      })
      .mockResolvedValueOnce(rowWithTokens());
    revokeAccess.mockResolvedValue({ revoked: true });

    await disconnectMailAccount({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });

    expect(eventCreate.mock.calls[0]?.[0].data.requestId).toBeNull();
  });

  it("does not delete the mailbox when the audit row cannot be written", async () => {
    /*
     * The deliberate trade: a disconnect the system cannot account for is worse than a
     * disconnect the user has to click twice. The insert throwing rolls the transaction
     * back, so the mailbox is still there.
     */
    findFirst
      .mockResolvedValueOnce({
        id: MAIL_ACCOUNT_ID,
        provider: "GMAIL",
        emailAddress: "person@example.com",
      })
      .mockResolvedValueOnce(rowWithTokens());
    revokeAccess.mockResolvedValue({ revoked: true });
    eventCreate.mockRejectedValue(new Error("audit insert failed"));

    await expect(
      disconnectMailAccount({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID }),
    ).rejects.toThrow(/audit insert failed/);

    expect(del).not.toHaveBeenCalled();
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
