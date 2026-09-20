import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `pnpm ai:sweep --force`: re-running messages that already have rows.
 *
 * The motivating case is a mailbox whose every row was written by the dev stub, or by a
 * provider that has since been swapped. Nothing is *missing*, so the ordinary sweep
 * correctly reports zero — and rule 7 is working exactly as designed, serving a cached
 * answer that is no longer the answer anybody wants.
 *
 * So the tests here are about the two halves of that:
 *
 *   1. the sweep can be asked for work it would otherwise never find;
 *   2. the cache is bypassed *and* the rows are replaced rather than duplicated.
 *
 * And, just as importantly, about the blast radius: an ordinary enqueue must be
 * byte-for-byte what it always was, because rule 7 still holds for every other caller.
 */

const messageFindMany = vi.hoisted(() => vi.fn());
const messageCount = vi.hoisted(() => vi.fn());
const settingsFindFirst = vi.hoisted(() => vi.fn());
const usageCount = vi.hoisted(() => vi.fn());
const queryRaw = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    message: { findMany: messageFindMany, count: messageCount },
    userSettings: { findFirst: settingsFindFirst },
    aiUsage: { count: usageCount },
  }),
  prisma: {
    $queryRaw: queryRaw,
    mailAccount: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const enqueueEnrichment = vi.hoisted(() => vi.fn());

vi.mock("./enrich.js", () => ({ enqueueEnrichment }));

const { findMessagesToRecompute, sweepUserEnrichment } = await import("./sweep.js");

const USER_ID = "user_1";
const MAILBOX = "mail_1";

/** Three messages across two threads, newest first, as Prisma would return them. */
function rows() {
  return [
    { id: "m_new", mailAccountId: MAILBOX, threadId: "t_1" },
    { id: "m_old", mailAccountId: MAILBOX, threadId: "t_1" },
    { id: "m_solo", mailAccountId: MAILBOX, threadId: "t_2" },
  ];
}

beforeEach(() => {
  messageFindMany.mockReset().mockResolvedValue(rows());
  messageCount.mockReset().mockResolvedValue(3);
  settingsFindFirst.mockReset().mockResolvedValue(null);
  usageCount.mockReset().mockResolvedValue(0);
  queryRaw.mockReset().mockResolvedValue([]);
  enqueueEnrichment
    .mockReset()
    .mockImplementation(({ messageIds }: { messageIds: string[] }) =>
      Promise.resolve(messageIds.length),
    );
});

describe("findMessagesToRecompute", () => {
  it("takes every message, not only the ones missing rows", async () => {
    /*
     * The inversion. Every other finder in this file has a `NOT EXISTS` or a
     * `classification: { is: null }`; this one deliberately has no such predicate, because
     * the case it exists for leaves no gap to find.
     */
    const work = await findMessagesToRecompute({ userId: USER_ID });

    expect(messageFindMany.mock.calls[0]?.[0].where).toEqual({});
    expect(work.messages.map((m) => m.id)).toEqual(["m_new", "m_old", "m_solo"]);
  });

  it("nominates exactly one message per thread to re-summarize", async () => {
    /*
     * The cost control that makes forcing affordable. A summary is a property of the
     * *thread*; if all three messages carried "resummarize", a forced sweep would pay for
     * two identical summaries of t_1.
     */
    const work = await findMessagesToRecompute({ userId: USER_ID });

    expect([...work.resummarizeIds].sort()).toEqual(["m_new", "m_solo"]);
    expect(work.resummarizeIds.size).toBe(2);
  });

  it("nominates the newest message of each thread", async () => {
    // Matching what the ordinary summary finder does, so one job does both halves of a
    // thread's work: the summary and the classification the thread's columns reflect.
    const work = await findMessagesToRecompute({ userId: USER_ID });

    expect(work.resummarizeIds.has("m_new")).toBe(true);
    expect(work.resummarizeIds.has("m_old")).toBe(false);
    expect(messageFindMany.mock.calls[0]?.[0].orderBy).toEqual({ sentAt: "desc" });
  });

  it("scopes to one mailbox when asked", async () => {
    await findMessagesToRecompute({ userId: USER_ID, mailAccountId: MAILBOX });
    expect(messageFindMany.mock.calls[0]?.[0].where).toEqual({ mailAccountId: MAILBOX });
  });

  it("includes outbound mail, which the threat stage skips for itself", async () => {
    // Classification runs on the user's own sent mail — that is how it gets a language
    // and a category. Excluding it here would leave those rows stubbed for ever.
    await findMessagesToRecompute({ userId: USER_ID });
    expect(messageFindMany.mock.calls[0]?.[0].where.isOutbound).toBeUndefined();
  });
});

describe("the recompute sweep", () => {
  it("queues every message with the cache bypassed", async () => {
    const result = await sweepUserEnrichment({ userId: USER_ID, recompute: true });

    expect(result).toMatchObject({ found: 3, queued: 3, recomputed: true });
    expect(enqueueEnrichment.mock.calls[0]?.[0]).toMatchObject({
      userId: USER_ID,
      mailAccountId: MAILBOX,
      messageIds: ["m_new", "m_old", "m_solo"],
      ignoreCache: true,
    });
  });

  it("passes the one-per-thread summary set through to the queue", async () => {
    await sweepUserEnrichment({ userId: USER_ID, recompute: true });

    const ids = enqueueEnrichment.mock.calls[0]?.[0].resummarizeIds as Set<string>;
    expect([...ids].sort()).toEqual(["m_new", "m_solo"]);
  });

  it("does not run the gap finders at all", async () => {
    /*
     * "Every message" is a superset of "messages with no classification", so the gap
     * finders could only contribute duplicates — and the budget arithmetic that splits
     * `limit` between three of them means nothing when one finder wants everything.
     */
    await sweepUserEnrichment({ userId: USER_ID, recompute: true });

    // `findThreadsMissingSummaries` is the raw-SQL one; it must not have been consulted.
    expect(queryRaw).not.toHaveBeenCalled();
    expect(enqueueEnrichment).toHaveBeenCalledTimes(1);
  });

  it("reports what it could not take, so a partial run cannot look complete", async () => {
    // A mailbox bigger than the limit gets its newest messages first. Silence here would
    // leave the user wondering why only half the inbox changed.
    messageFindMany.mockResolvedValue(rows().slice(0, 2));
    messageCount.mockResolvedValue(57);

    const result = await sweepUserEnrichment({
      userId: USER_ID,
      recompute: true,
      limit: 2,
    });

    expect(result).toMatchObject({ found: 2, remaining: 55 });
  });

  it("reports nothing remaining when it took the lot", async () => {
    const result = await sweepUserEnrichment({ userId: USER_ID, recompute: true });
    expect(result.remaining).toBe(0);
  });

  it("is still bounded by the daily cap unless told otherwise", async () => {
    /*
     * The two overrides stay separate. Re-assessing a mailbox does not imply permission to
     * blow through the spend limit — which on a free tier is also the only thing pacing
     * the provider's per-minute quota.
     */
    usageCount.mockResolvedValue(498);
    messageFindMany.mockResolvedValue(rows().slice(0, 2));

    await sweepUserEnrichment({ userId: USER_ID, recompute: true });

    // 500 default cap, 498 used, so the batch is trimmed to the 2 calls left.
    expect(messageFindMany.mock.calls[0]?.[0].take).toBe(2);
  });

  it("ignores the cap when that is asked for separately", async () => {
    usageCount.mockResolvedValue(500);

    const result = await sweepUserEnrichment({
      userId: USER_ID,
      recompute: true,
      ignoreCap: true,
      limit: 50,
    });

    expect(result.skipped).toBeUndefined();
    expect(messageFindMany.mock.calls[0]?.[0].take).toBe(50);
  });

  it("stops at the cap with no budget and no override, as it always did", async () => {
    usageCount.mockResolvedValue(500);

    const result = await sweepUserEnrichment({ userId: USER_ID, recompute: true });

    expect(result).toMatchObject({ found: 0, queued: 0, skipped: "cap" });
    expect(enqueueEnrichment).not.toHaveBeenCalled();
  });

  it("respects AI being switched off", async () => {
    settingsFindFirst.mockResolvedValue({
      aiEnabled: false,
      autoSummarize: true,
      autoCategorize: true,
      phishingProtection: true,
      dailyAiCallCap: 500,
      defaultTone: "PROFESSIONAL",
    });

    const result = await sweepUserEnrichment({ userId: USER_ID, recompute: true });

    expect(result).toMatchObject({ found: 0, skipped: "disabled" });
  });

  it("groups by mailbox, so a two-mailbox user's ids do not cross", async () => {
    // The enrich job carries a mailAccountId and `runEnrich` filters on both — a
    // mismatched pair silently finds nothing.
    messageFindMany.mockResolvedValue([
      { id: "a1", mailAccountId: "mail_1", threadId: "t_a" },
      { id: "b1", mailAccountId: "mail_2", threadId: "t_b" },
    ]);

    await sweepUserEnrichment({ userId: USER_ID, recompute: true });

    const byMailbox = enqueueEnrichment.mock.calls.map((call) => [
      call[0].mailAccountId,
      call[0].messageIds,
    ]);
    expect(byMailbox).toEqual([
      ["mail_1", ["a1"]],
      ["mail_2", ["b1"]],
    ]);
  });
});

describe("the ordinary sweep is unchanged", () => {
  it("never sets the recompute flags", async () => {
    /*
     * The blast-radius test. Rule 7 still holds for the sync engine and the scheduled
     * sweep, and the way that stays true is that they do not pass the flag — so an
     * ordinary job's payload is what it has always been.
     */
    messageFindMany.mockResolvedValue([{ id: "m_gap", mailAccountId: MAILBOX }]);

    await sweepUserEnrichment({ userId: USER_ID });

    const call = enqueueEnrichment.mock.calls[0]?.[0];
    expect(call.ignoreCache).toBeUndefined();
    expect(call.resummarizeIds).toBeUndefined();
  });

  it("still looks for gaps rather than for everything", async () => {
    messageFindMany.mockResolvedValue([{ id: "m_gap", mailAccountId: MAILBOX }]);

    await sweepUserEnrichment({ userId: USER_ID });

    // The unclassified finder's predicate: no row means never classified.
    expect(messageFindMany.mock.calls[0]?.[0].where).toMatchObject({
      classification: { is: null },
    });
  });
});
