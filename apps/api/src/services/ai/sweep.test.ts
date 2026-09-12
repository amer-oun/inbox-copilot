import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sweep that closes the cap loop.
 *
 * The behaviour worth pinning is the budget arithmetic: a sweep that queues more
 * than the remaining daily allowance turns a spend limit into thousands of jobs that
 * each rediscover the cap, which is how a "fix" becomes a log flood.
 */

const messageFindMany = vi.hoisted(() => vi.fn());
const queryRaw = vi.hoisted(() => vi.fn());
const usageCount = vi.hoisted(() => vi.fn());
const settingsFindFirst = vi.hoisted(() => vi.fn());
const mailAccountFindMany = vi.hoisted(() => vi.fn());
const tenantCalls = vi.hoisted(() => [] as string[]);

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: (userId: string) => {
    tenantCalls.push(userId);
    return {
      message: { findMany: messageFindMany },
      aiUsage: { count: usageCount },
      userSettings: { findFirst: settingsFindFirst },
    };
  },
  /*
   * The base client: used to enumerate mailbox owners, and for the one raw query
   * whose tenancy predicate is written out rather than injected.
   */
  prisma: { mailAccount: { findMany: mailAccountFindMany }, $queryRaw: queryRaw },
}));

const enqueueEnrichment = vi.hoisted(() => vi.fn());
vi.mock("./enrich.js", () => ({ enqueueEnrichment }));

const {
  findThreadsMissingSummaries,
  findUnenrichedMessages,
  sweepAllEnrichment,
  sweepUserEnrichment,
  SWEEP_USER_LIMIT,
} = await import("./sweep.js");

const USER_ID = "user_1";
const MAIL_ACCOUNT_ID = "mail_1";

function messages(count: number, mailAccountId = MAIL_ACCOUNT_ID) {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg_${index}`,
    mailAccountId,
  }));
}

beforeEach(() => {
  tenantCalls.length = 0;
  messageFindMany.mockReset().mockResolvedValue(messages(3));
  queryRaw.mockReset().mockResolvedValue([]);
  usageCount.mockReset().mockResolvedValue(0);
  settingsFindFirst.mockReset().mockResolvedValue({
    aiEnabled: true,
    autoSummarize: true,
    autoCategorize: true,
    dailyAiCallCap: 500,
  });
  mailAccountFindMany.mockReset().mockResolvedValue([{ userId: USER_ID }]);
  enqueueEnrichment.mockReset().mockImplementation(
    async ({ messageIds }: { messageIds: string[] }) => messageIds.length,
  );
});

describe("findUnenrichedMessages", () => {
  it("asks for messages with no classification row at all", async () => {
    await findUnenrichedMessages({ userId: USER_ID });

    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { classification: { is: null } },
        orderBy: { sentAt: "desc" },
        take: SWEEP_USER_LIMIT,
      }),
    );
  });

  it("can be narrowed to one mailbox", async () => {
    await findUnenrichedMessages({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID, limit: 10 });

    expect(messageFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { mailAccountId: MAIL_ACCOUNT_ID, classification: { is: null } },
      take: 10,
    });
  });

  it("reads through the tenancy client", async () => {
    await findUnenrichedMessages({ userId: USER_ID });
    expect(tenantCalls).toContain(USER_ID);
  });
});

describe("sweepUserEnrichment", () => {
  it("queues what it found", async () => {
    const result = await sweepUserEnrichment({ userId: USER_ID });

    expect(result).toMatchObject({ found: 3, queued: 3, budget: 500 });
    expect(enqueueEnrichment).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      messageIds: ["msg_0", "msg_1", "msg_2"],
    });
  });

  it("trims the batch to the remaining daily budget", async () => {
    // 500-cap, 495 used: five calls left, so five messages — not two hundred.
    usageCount.mockResolvedValue(495);

    await sweepUserEnrichment({ userId: USER_ID });

    expect(messageFindMany.mock.calls[0]?.[0].take).toBe(5);
  });

  it("does nothing when the budget is spent", async () => {
    usageCount.mockResolvedValue(500);

    const result = await sweepUserEnrichment({ userId: USER_ID });

    expect(result).toMatchObject({ found: 0, queued: 0, skipped: "cap", budget: 0 });
    // Not even a lookup: there is nothing that could be done with the result.
    expect(messageFindMany).not.toHaveBeenCalled();
    expect(enqueueEnrichment).not.toHaveBeenCalled();
  });

  it("ignores the budget when forced", async () => {
    usageCount.mockResolvedValue(500);

    const result = await sweepUserEnrichment({ userId: USER_ID, force: true, limit: 50 });

    expect(result.queued).toBe(3);
    expect(messageFindMany.mock.calls[0]?.[0].take).toBe(50);
  });

  it("respects an explicit limit below the budget", async () => {
    await sweepUserEnrichment({ userId: USER_ID, limit: 2 });
    expect(messageFindMany.mock.calls[0]?.[0].take).toBe(2);
  });

  it("does nothing when the user has AI disabled", async () => {
    settingsFindFirst.mockResolvedValue({
      aiEnabled: false,
      autoSummarize: true,
      autoCategorize: true,
      dailyAiCallCap: 500,
    });

    const result = await sweepUserEnrichment({ userId: USER_ID });

    expect(result.skipped).toBe("disabled");
    expect(messageFindMany).not.toHaveBeenCalled();
  });

  it("groups messages by mailbox so jobs carry the right mailAccountId", async () => {
    // A user with two mailboxes: the enrich job's tenancy read filters on both ids,
    // so a message queued under the wrong mailbox would simply never be found.
    messageFindMany.mockResolvedValue([
      { id: "a1", mailAccountId: "mail_a" },
      { id: "b1", mailAccountId: "mail_b" },
      { id: "a2", mailAccountId: "mail_a" },
    ]);

    const result = await sweepUserEnrichment({ userId: USER_ID });

    expect(result.queued).toBe(3);
    expect(enqueueEnrichment).toHaveBeenCalledTimes(2);
    expect(enqueueEnrichment).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: "mail_a",
      messageIds: ["a1", "a2"],
    });
    expect(enqueueEnrichment).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: "mail_b",
      messageIds: ["b1"],
    });
  });

  it("reports zero without queueing when nothing is unenriched", async () => {
    messageFindMany.mockResolvedValue([]);

    const result = await sweepUserEnrichment({ userId: USER_ID });

    expect(result).toMatchObject({ found: 0, queued: 0 });
    expect(enqueueEnrichment).not.toHaveBeenCalled();
  });
});

describe("findThreadsMissingSummaries", () => {
  /** The SQL text and the parameters, from the tagged-template call. */
  function rawCall(): { sql: string; params: unknown[] } {
    const [strings, ...params] = queryRaw.mock.calls[0] as [string[], ...unknown[]];
    return { sql: strings.join("?"), params };
  }

  it("filters by the mailbox owner, since raw SQL bypasses the tenancy extension", async () => {
    await findThreadsMissingSummaries({ userId: USER_ID });

    const { sql, params } = rawCall();
    expect(sql).toMatch(/JOIN "MailAccount" a ON a\."id" = t\."mailAccountId"/);
    expect(sql).toMatch(/a\."userId" = \?/);
    expect(params[0]).toBe(USER_ID);
  });

  it("covers both ways a thread qualifies for a summary", async () => {
    await findThreadsMissingSummaries({ userId: USER_ID });
    const { sql, params } = rawCall();

    // Three messages, or one long body — the second is why this is raw SQL.
    expect(sql).toMatch(/"messageCount" >= \?/);
    expect(sql).toMatch(/length\(COALESCE\(lm\."bodyText", lm\."snippet", ''\)\) > \?/);
    expect(params).toContain(3);
    expect(params).toContain(1_500);
  });

  it("excludes threads that already have a summary", async () => {
    await findThreadsMissingSummaries({ userId: USER_ID });
    expect(rawCall().sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "AiSummary"/);
  });

  it("takes the newest message of each thread, newest threads first", async () => {
    await findThreadsMissingSummaries({ userId: USER_ID });
    const { sql } = rawCall();

    expect(sql).toMatch(/DISTINCT ON \(t\."id"\)/);
    expect(sql).toMatch(/ORDER BY t\."id", m\."sentAt" DESC/);
    expect(sql).toMatch(/ORDER BY x\."lastMessageAt" DESC/);
  });

  it("passes the mailbox filter and the limit", async () => {
    await findThreadsMissingSummaries({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      limit: 12,
    });

    expect(rawCall().params).toContain(MAIL_ACCOUNT_ID);
    expect(rawCall().params).toContain(12);
  });

  it("passes null for the mailbox filter when unset, so the predicate is a no-op", async () => {
    await findThreadsMissingSummaries({ userId: USER_ID });

    expect(rawCall().params).toContain(null);
    expect(rawCall().sql).toMatch(/::text IS NULL OR/);
  });

  it("returns the rows as message ids", async () => {
    queryRaw.mockResolvedValue([
      { id: "newest_a", mailAccountId: "mail_a" },
      { id: "newest_b", mailAccountId: "mail_b" },
    ]);

    expect(await findThreadsMissingSummaries({ userId: USER_ID })).toEqual([
      { id: "newest_a", mailAccountId: "mail_a" },
      { id: "newest_b", mailAccountId: "mail_b" },
    ]);
  });
});

describe("sweeping threads whose summary the cap refused", () => {
  /*
   * The gap this closes: enrichment is two calls, and a cap falling between them
   * leaves a message classified and its thread unsummarized — which a query about
   * missing classifications can never find again.
   */
  it("queues the newest message of a thread that has no summary", async () => {
    messageFindMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([{ id: "newest", mailAccountId: MAIL_ACCOUNT_ID }]);

    const result = await sweepUserEnrichment({ userId: USER_ID });

    expect(result).toMatchObject({ found: 1, queued: 1 });
    expect(enqueueEnrichment).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      messageIds: ["newest"],
    });
  });

  it("does not queue the same message twice for both reasons", async () => {
    // An unclassified message that is also its thread's newest needs one job, which
    // does both halves.
    messageFindMany.mockResolvedValue([{ id: "msg_0", mailAccountId: MAIL_ACCOUNT_ID }]);
    queryRaw.mockResolvedValue([{ id: "msg_0", mailAccountId: MAIL_ACCOUNT_ID }]);

    const result = await sweepUserEnrichment({ userId: USER_ID });

    expect(result.found).toBe(1);
    expect(enqueueEnrichment).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      messageIds: ["msg_0"],
    });
  });

  it("spends the budget on unclassified messages first", async () => {
    // Classification is the more visible gap, and the more expensive one to leave.
    usageCount.mockResolvedValue(497);
    messageFindMany.mockResolvedValue(messages(3));

    await sweepUserEnrichment({ userId: USER_ID });

    expect(messageFindMany.mock.calls[0]?.[0].take).toBe(3);
    // Budget of three, three unclassified: no room left to look for summaries.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("uses the leftover budget for missing summaries", async () => {
    usageCount.mockResolvedValue(495);
    messageFindMany.mockResolvedValue(messages(2));

    await sweepUserEnrichment({ userId: USER_ID });

    // Five of budget, two unclassified: three left for summaries.
    expect(queryRaw.mock.calls[0]).toContain(3);
  });
});

describe("sweepAllEnrichment", () => {
  it("enumerates only mailbox owners, and only their ids", async () => {
    await sweepAllEnrichment();

    // The single deliberate non-tenant read: two id columns, no mail.
    expect(mailAccountFindMany).toHaveBeenCalledWith({
      where: { syncStatus: { in: ["ACTIVE", "BACKFILLING"] } },
      select: { userId: true },
      distinct: ["userId"],
    });
  });

  it("sweeps each owner through the tenancy client", async () => {
    mailAccountFindMany.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);

    const results = await sweepAllEnrichment();

    expect(results.map((result) => result.userId)).toEqual(["u1", "u2"]);
    expect(new Set(tenantCalls)).toEqual(new Set(["u1", "u2"]));
  });

  it("keeps going when one user's sweep fails", async () => {
    // On a schedule, aborting halfway would leave an arbitrary subset done.
    mailAccountFindMany.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);
    settingsFindFirst
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValue({
        aiEnabled: true,
        autoSummarize: true,
        autoCategorize: true,
        dailyAiCallCap: 500,
      });

    const results = await sweepAllEnrichment();

    expect(results).toHaveLength(1);
    expect(results[0]?.userId).toBe("u2");
  });

  it("passes a per-user limit through", async () => {
    await sweepAllEnrichment({ perUserLimit: 7 });
    expect(messageFindMany.mock.calls[0]?.[0].take).toBe(7);
  });

  it("returns an empty list when there are no mailboxes", async () => {
    mailAccountFindMany.mockResolvedValue([]);
    expect(await sweepAllEnrichment()).toEqual([]);
  });
});
