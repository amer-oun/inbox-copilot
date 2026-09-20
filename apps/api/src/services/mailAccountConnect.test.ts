import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The connect half of the mailbox audit trail.
 *
 * `completeMailAccountConnect` had no test of its own before this: the route tests mock it
 * out, and its behaviour was covered indirectly. What is pinned here is the part that has
 * to hold for the trail to be worth having — a row for every mailbox that appears, with
 * the id of the request that made it appear, written in the same transaction as the
 * mailbox itself.
 */

const mailAccountFindFirst = vi.hoisted(() => vi.fn());
const mailAccountCreate = vi.hoisted(() => vi.fn());
const mailAccountUpdate = vi.hoisted(() => vi.fn());
const eventCreate = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => [] as string[]);

vi.mock("@inbox-copilot/db", () => {
  class KnownRequestError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }

  const client = {
    mailAccount: {
      findFirst: mailAccountFindFirst,
      create: (...args: unknown[]) => {
        calls.push("mailbox");
        return mailAccountCreate(...args);
      },
      update: (...args: unknown[]) => {
        calls.push("mailbox");
        return mailAccountUpdate(...args);
      },
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    mailAccountEvent: {
      create: (...args: unknown[]) => {
        calls.push("audit");
        return eventCreate(...args);
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      calls.push("begin");
      const result = await fn(client);
      calls.push("commit");
      return result;
    },
  };

  return {
    dbForUser: () => client,
    Prisma: { PrismaClientKnownRequestError: KnownRequestError },
  };
});

const exchangeCode = vi.hoisted(() => vi.fn());
const fetchIdentity = vi.hoisted(() => vi.fn());

vi.mock("../providers/registry.js", () => ({
  oauthClientFor: () => ({
    exchangeCode,
    fetchIdentity,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  }),
  redirectUriFor: () => "http://localhost:4000/oauth/google/callback",
}));

vi.mock("../providers/tokenManager.js", () => ({
  tokenVaultFields: () => ({
    accessTokenEnc: "cipher",
    accessTokenIv: "iv",
    accessTokenAuthTag: "tag",
    refreshTokenEnc: "cipher",
    refreshTokenIv: "iv",
    refreshTokenAuthTag: "tag",
    keyVersion: 1,
  }),
  revokeMailboxGrant: vi.fn(),
}));

const { completeMailAccountConnect } = await import("./mailAccounts.js");

const USER_ID = "user_1";
const EMAIL = "person@example.com";
/** Shaped like a real cuid: the DTO validates it on the way out. */
const MAIL_ACCOUNT_ID = "cldd4kzai000108l3a1b2c3d4";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: MAIL_ACCOUNT_ID,
    provider: "GMAIL",
    emailAddress: EMAIL,
    displayName: "Person",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    syncStatus: "PENDING",
    syncError: null,
    lastSyncedAt: null,
    createdAt: new Date("2026-09-15T02:00:00Z"),
    ...overrides,
  };
}

function connect(requestId?: string) {
  return completeMailAccountConnect({
    userId: USER_ID,
    provider: "google",
    code: "auth-code",
    ...(requestId === undefined ? {} : { requestId }),
  });
}

beforeEach(() => {
  calls.length = 0;
  mailAccountFindFirst.mockReset().mockResolvedValue(null);
  mailAccountCreate.mockReset().mockResolvedValue(row());
  mailAccountUpdate.mockReset().mockResolvedValue(row());
  eventCreate.mockReset().mockResolvedValue({});
  exchangeCode.mockReset().mockResolvedValue({
    accessToken: "access",
    refreshToken: "refresh",
    scopes: [],
    expiresAt: new Date("2026-09-15T03:00:00Z"),
  });
  fetchIdentity
    .mockReset()
    .mockResolvedValue({ emailAddress: EMAIL, displayName: "Person" });
});

describe("a newly connected mailbox", () => {
  it("records CONNECTED with the request that connected it", async () => {
    await connect("req-connect-1");

    expect(eventCreate.mock.calls[0]?.[0].data).toEqual({
      kind: "CONNECTED",
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      provider: "GMAIL",
      emailAddress: EMAIL,
      requestId: "req-connect-1",
      // Only disconnect revokes a grant, so there is nothing to say here.
      grantRevoked: null,
    });
  });

  it("writes the mailbox and the record in one transaction", async () => {
    // The mailbox first, because the audit row needs the id the create produced — which is
    // also why this is an interactive transaction rather than a batch.
    await connect("req-connect-1");

    expect(calls).toEqual(["begin", "mailbox", "audit", "commit"]);
  });

  it("does not create the mailbox when the record cannot be written", async () => {
    eventCreate.mockRejectedValue(new Error("audit insert failed"));

    await expect(connect("req-connect-1")).rejects.toThrow(/audit insert failed/);

    // The create was issued, and rolled back with the transaction: what must not happen is
    // a mailbox appearing with no record of where it came from.
    expect(calls).toEqual(["begin", "mailbox", "audit"]);
  });
});

describe("reconnecting a mailbox that already exists", () => {
  beforeEach(() => {
    mailAccountFindFirst.mockResolvedValue({ id: MAIL_ACCOUNT_ID });
  });

  it("records RECONNECTED rather than CONNECTED", async () => {
    /*
     * The row is reused so the already-synced threads are not orphaned, and the trail
     * should say which of the two happened: "CONNECTED" against an id that has existed for
     * a month would be misleading in exactly the situation you are reading the trail.
     */
    await connect("req-reconnect-1");

    expect(eventCreate.mock.calls[0]?.[0].data).toMatchObject({
      kind: "RECONNECTED",
      mailAccountId: MAIL_ACCOUNT_ID,
      requestId: "req-reconnect-1",
    });
    expect(mailAccountCreate).not.toHaveBeenCalled();
  });

  it("updates the mailbox and records it in one transaction", async () => {
    await connect("req-reconnect-1");
    expect(calls).toEqual(["begin", "mailbox", "audit", "commit"]);
  });
});

describe("two consent screens finishing at once", () => {
  it("records the loser as a reconnect of the winner's row", async () => {
    mailAccountFindFirst.mockResolvedValue(null);
    const conflict = await import("@inbox-copilot/db").then(
      (db) =>
        new (
          db.Prisma.PrismaClientKnownRequestError as unknown as new (
            message: string,
            code: string,
          ) => Error
        )("unique violation", "P2002"),
    );
    mailAccountCreate.mockRejectedValue(conflict);

    await connect("req-race-1");

    expect(eventCreate.mock.calls[0]?.[0].data).toMatchObject({
      kind: "RECONNECTED",
      requestId: "req-race-1",
    });
  });
});

describe("a connect with no request behind it", () => {
  it("records a null request id", async () => {
    await connect();
    expect(eventCreate.mock.calls[0]?.[0].data.requestId).toBeNull();
  });
});
