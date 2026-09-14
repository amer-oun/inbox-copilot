import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The watch keeper.
 *
 * Its job is to make one specific failure impossible: an inbox that looks empty because
 * nothing is telling us mail arrived. So the tests are mostly about the cases where
 * *nothing appears wrong* — a watch that expired quietly, and a watch that is live while
 * notifications are not arriving.
 */

const startWatch = vi.hoisted(() => vi.fn());
const stopWatch = vi.hoisted(() => vi.fn());
const mailProviderFor = vi.hoisted(() => vi.fn());
vi.mock("../providers/registry.js", () => ({ mailProviderFor }));

const enqueueDelta = vi.hoisted(() => vi.fn());
vi.mock("./deltaSync.js", () => ({ enqueueDelta }));

const accountFindFirst = vi.hoisted(() => vi.fn());
const accountUpdate = vi.hoisted(() => vi.fn());
const accountFindMany = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  prisma: { mailAccount: { findMany: accountFindMany } },
  dbForUser: () => ({
    mailAccount: { findFirst: accountFindFirst, update: accountUpdate },
  }),
  Prisma: {},
}));

const {
  ensureWatch,
  runWatchKeeper,
  stopWatchForMailbox,
  STALE_SYNC_MS,
  WATCH_RENEW_BEFORE_MS,
} = await import("./watch.js");
const { env } = await import("../lib/env.js");

const USER_ID = "user_1";
const ACCOUNT_ID = "mail_1";
const TOPIC = "projects/inbox-copilot-test/topics/gmail-push";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function mailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    userId: USER_ID,
    provider: "GMAIL",
    emailAddress: "person@example.com",
    syncStatus: "ACTIVE",
    syncCursor: "1000",
    watchExpiresAt: null,
    lastSyncedAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  env.GMAIL_PUBSUB_TOPIC = TOPIC;
  mailProviderFor.mockReset().mockReturnValue({ startWatch, stopWatch });
  startWatch.mockReset().mockResolvedValue({
    expiresAt: new Date(Date.now() + 7 * DAY),
    cursor: "5000",
  });
  stopWatch.mockReset().mockResolvedValue(undefined);
  enqueueDelta.mockReset().mockResolvedValue({ queued: true, jobId: "delta-mail_1" });
  accountFindFirst.mockReset().mockResolvedValue(mailbox());
  accountUpdate.mockReset().mockResolvedValue({});
  accountFindMany.mockReset().mockResolvedValue([mailbox()]);
});

describe("ensureWatch", () => {
  it("starts a watch and stores the topic and expiry", async () => {
    const result = await ensureWatch({ userId: USER_ID, mailAccountId: ACCOUNT_ID });

    expect(result.started).toBe(true);
    expect(accountUpdate).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: { watchResourceId: TOPIC, watchExpiresAt: result.expiresAt },
    });
  });

  it("never writes the provider's history id over our cursor", async () => {
    /*
     * Gmail's watch returns "now". Our cursor is "the last point we have actually
     * read", and overwriting it would skip everything in between — the exact silent gap
     * this phase exists to prevent.
     */
    await ensureWatch({ userId: USER_ID, mailAccountId: ACCOUNT_ID });

    const written = accountUpdate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(written).not.toHaveProperty("syncCursor");
  });

  it("leaves a watch with days left alone", async () => {
    // 100 quota units per call: re-asserting an hour before it matters is pure waste.
    accountFindFirst.mockResolvedValue(
      mailbox({ watchExpiresAt: new Date(Date.now() + 6 * DAY) }),
    );

    const result = await ensureWatch({ userId: USER_ID, mailAccountId: ACCOUNT_ID });

    expect(result.skipped).toBe("fresh");
    expect(startWatch).not.toHaveBeenCalled();
  });

  it("renews a watch inside the renewal window", async () => {
    accountFindFirst.mockResolvedValue(
      mailbox({ watchExpiresAt: new Date(Date.now() + WATCH_RENEW_BEFORE_MS - HOUR) }),
    );

    const result = await ensureWatch({ userId: USER_ID, mailAccountId: ACCOUNT_ID });
    expect(result.started).toBe(true);
  });

  it("renews a fresh watch when forced", async () => {
    accountFindFirst.mockResolvedValue(
      mailbox({ watchExpiresAt: new Date(Date.now() + 6 * DAY) }),
    );

    expect((await ensureWatch({ userId: USER_ID, mailAccountId: ACCOUNT_ID, force: true })).started).toBe(
      true,
    );
  });

  it("refuses when push is not configured", async () => {
    env.GMAIL_PUBSUB_TOPIC = "";

    await expect(
      ensureWatch({ userId: USER_ID, mailAccountId: ACCOUNT_ID }),
    ).rejects.toThrow(/GMAIL_PUBSUB_TOPIC/);
  });

  it("skips a revoked mailbox instead of failing hourly on it", async () => {
    accountFindFirst.mockResolvedValue(mailbox({ syncStatus: "REVOKED" }));

    const result = await ensureWatch({ userId: USER_ID, mailAccountId: ACCOUNT_ID });

    expect(result.skipped).toBe("inactive");
    expect(startWatch).not.toHaveBeenCalled();
  });

  it("skips a non-Gmail mailbox", async () => {
    accountFindFirst.mockResolvedValue(mailbox({ provider: "OUTLOOK" }));

    expect((await ensureWatch({ userId: USER_ID, mailAccountId: ACCOUNT_ID })).skipped).toBe(
      "not-gmail",
    );
  });
});

describe("stopWatchForMailbox", () => {
  it("stops at the provider and clears the columns", async () => {
    const result = await stopWatchForMailbox(USER_ID, {
      id: ACCOUNT_ID,
      provider: "GMAIL",
      emailAddress: "person@example.com",
      watchExpiresAt: new Date(Date.now() + DAY),
    });

    expect(result.stopped).toBe(true);
    expect(accountUpdate).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: { watchResourceId: null, watchExpiresAt: null },
    });
  });

  it("clears the columns even when the provider call fails", async () => {
    // The user asked to disconnect. A watch we could not stop expires within a week, and
    // its notifications already resolve to no mailbox.
    stopWatch.mockRejectedValue(new Error("gmail said no"));

    const result = await stopWatchForMailbox(USER_ID, {
      id: ACCOUNT_ID,
      provider: "GMAIL",
      emailAddress: "person@example.com",
      watchExpiresAt: new Date(Date.now() + DAY),
    });

    expect(result.stopped).toBe(false);
    expect(accountUpdate).toHaveBeenCalled();
  });

  it("calls nothing when there was no watch to stop", async () => {
    await stopWatchForMailbox(USER_ID, {
      id: ACCOUNT_ID,
      provider: "GMAIL",
      emailAddress: "person@example.com",
      watchExpiresAt: null,
    });

    expect(stopWatch).not.toHaveBeenCalled();
  });
});

describe("runWatchKeeper", () => {
  it("renews a mailbox with no watch and catches it up", async () => {
    const result = await runWatchKeeper();

    expect(result).toMatchObject({ checked: 1, renewed: 1, failed: 0, caughtUp: 1 });
    expect(enqueueDelta).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: ACCOUNT_ID,
      reason: "watch-renewed",
    });
  });

  it("queues a catch-up delta for a live watch that has gone quiet", async () => {
    /*
     * The failure with no other symptom: Google still considers the watch live, so
     * `watchExpiresAt` looks perfect, but the subscription was deleted or our endpoint
     * was failing. Silence is the only evidence, so silence is what is checked.
     */
    accountFindMany.mockResolvedValue([
      mailbox({
        watchExpiresAt: new Date(Date.now() + 6 * DAY),
        lastSyncedAt: new Date(Date.now() - STALE_SYNC_MS - 60_000),
      }),
    ]);

    const result = await runWatchKeeper();

    expect(result.renewed).toBe(0);
    expect(result.caughtUp).toBe(1);
    expect(enqueueDelta).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "sweep" }),
    );
  });

  it("leaves a healthy, recently synced mailbox completely alone", async () => {
    accountFindMany.mockResolvedValue([
      mailbox({
        watchExpiresAt: new Date(Date.now() + 6 * DAY),
        lastSyncedAt: new Date(Date.now() - 60_000),
      }),
    ]);

    const result = await runWatchKeeper();

    expect(result).toMatchObject({ renewed: 0, caughtUp: 0, skipped: 1 });
    expect(startWatch).not.toHaveBeenCalled();
    expect(enqueueDelta).not.toHaveBeenCalled();
  });

  it("does not queue a delta for a mailbox that has never backfilled", async () => {
    // There is nothing to be incremental from; the backfill is the right work.
    accountFindMany.mockResolvedValue([mailbox({ syncCursor: null })]);

    const result = await runWatchKeeper();
    expect(result.caughtUp).toBe(0);
  });

  it("keeps going when one mailbox fails to renew", async () => {
    accountFindMany.mockResolvedValue([
      mailbox({ id: "mail_1" }),
      mailbox({ id: "mail_2", userId: "user_2" }),
    ]);
    accountFindFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(mailbox({ id: where.id, userId: where.id === "mail_2" ? "user_2" : USER_ID })),
    );
    startWatch.mockRejectedValueOnce(new Error("grant is gone"));

    const result = await runWatchKeeper();

    expect(result).toMatchObject({ checked: 2, renewed: 1, failed: 1 });
  });

  it("does nothing at all when push is not configured", async () => {
    env.GMAIL_PUBSUB_TOPIC = "";

    const result = await runWatchKeeper();

    expect(result.checked).toBe(0);
    expect(accountFindMany).not.toHaveBeenCalled();
  });

  it("looks at mailboxes that are still backfilling, so push is live when they finish", async () => {
    await runWatchKeeper();

    expect(accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "GMAIL",
          syncStatus: { in: ["PENDING", "BACKFILLING", "ACTIVE", "ERROR"] },
        }),
      }),
    );
  });
});
