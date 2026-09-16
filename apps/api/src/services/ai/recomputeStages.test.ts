import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cache bypass itself, at each of the three stages, and the replacement of rows.
 *
 * `recompute.test.ts` covers the sweep finding the work; this covers what happens when the
 * job runs. Two things have to be true for `--force` to mean anything:
 *
 *   1. the cached answer is not consulted;
 *   2. the row is **replaced**, not duplicated — otherwise a re-assessed mailbox would end
 *      up with two verdicts per message and no way to tell which is current.
 *
 * And one thing has to remain true for rule 7: with the flag absent, every one of these
 * paths still checks the cache first.
 */

const classificationFindFirst = vi.hoisted(() => vi.fn());
const classificationUpsert = vi.hoisted(() => vi.fn());
const summaryFindFirst = vi.hoisted(() => vi.fn());
const summaryUpsert = vi.hoisted(() => vi.fn());
const usageCount = vi.hoisted(() => vi.fn());
const usageCreate = vi.hoisted(() => vi.fn());
const settingsFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    aiClassification: { findFirst: classificationFindFirst, upsert: classificationUpsert },
    aiSummary: { findFirst: summaryFindFirst, upsert: summaryUpsert },
    aiUsage: { count: usageCount, create: usageCreate },
    userSettings: { findFirst: settingsFindFirst },
  }),
  Prisma: {},
}));

const callStructured = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({ callStructured }));

/** Redis-backed lock: run the body, no locking, so the summary path is exercised. */
vi.mock("../../lib/mutex.js", () => ({
  withMutex: async (_key: string, fn: () => Promise<unknown>) => fn(),
  MutexTimeoutError: class MutexTimeoutError extends Error {},
}));

const { classifyMessage } = await import("./classify.js");
const { summarizeThread } = await import("./summarize.js");

const USER_ID = "user_1";
const MESSAGE_ID = "cldd4kzai000108l3a1b2c3d4";
const THREAD_ID = "cldd4kzai000208l3a1b2c3d4";
const CONTENT_HASH = "hash-of-the-body";

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    subject: "Revised invoice 4471",
    fromName: "Dana",
    fromEmail: "dana@northwind.example",
    to: ["owner@example.com"],
    cc: [],
    replyTo: null,
    sentAt: new Date("2026-09-14T09:00:00Z"),
    bodyText: "Could you confirm the totals by Friday? ".repeat(60),
    bodyHtml: null,
    snippet: null,
    isOutbound: false,
    hasAttachments: false,
    contentHash: CONTENT_HASH,
    ...overrides,
  };
}

/** A stored row, as the stub left it. */
const STUBBED_CLASSIFICATION = {
  id: "row_1",
  category: "OTHER",
  priority: "LOW",
  priorityScore: 10,
  needsReply: false,
  language: "und",
  model: "claude-haiku-4-5-20251001",
  contentHash: CONTENT_HASH,
};

const STUBBED_SUMMARY = {
  id: "sum_1",
  headline: "[stubbed summary] Invoice 4471",
  summary: "[stubbed summary] …",
  keyPoints: [],
  actionItems: [],
  model: "claude-sonnet-5",
};

beforeEach(() => {
  classificationFindFirst.mockReset().mockResolvedValue(STUBBED_CLASSIFICATION);
  classificationUpsert.mockReset().mockResolvedValue({});
  summaryFindFirst.mockReset().mockResolvedValue(STUBBED_SUMMARY);
  summaryUpsert.mockReset().mockResolvedValue({});
  usageCount.mockReset().mockResolvedValue(0);
  usageCreate.mockReset().mockResolvedValue({});
  settingsFindFirst.mockReset().mockResolvedValue(null);
  callStructured.mockReset().mockResolvedValue({
    data: {
      category: "FINANCE",
      priority: "HIGH",
      priorityScore: 70,
      needsReply: true,
      language: "en",
      confidence: 0.9,
    },
    model: "gemini-3.1-flash-lite",
    tokens: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
});

describe("classification", () => {
  it("serves the stored row when not recomputing", async () => {
    // Rule 7, unchanged: this is the behaviour every ordinary caller still gets.
    const result = await classifyMessage({
      userId: USER_ID,
      mailAccountId: "mail_1",
      mailboxAddress: "owner@example.com",
      message: message(),
    });

    expect(result.fromCache).toBe(true);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("does not even look up the cache when recomputing", async () => {
    /*
     * Skipped rather than looked up and discarded. A query whose answer cannot change the
     * outcome is a query for nothing, and not making it keeps "we checked and ignored it"
     * out of the ambiguous middle.
     */
    const result = await classifyMessage({
      userId: USER_ID,
      mailAccountId: "mail_1",
      mailboxAddress: "owner@example.com",
      message: message(),
      ignoreCache: true,
    });

    expect(classificationFindFirst).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(false);
    expect(callStructured).toHaveBeenCalledTimes(1);
  });

  it("replaces the row rather than adding a second one", async () => {
    /*
     * The upsert is keyed on `messageId`, which is unique — so a recompute overwrites. A
     * re-assessed mailbox with two verdicts per message and no way to tell which is
     * current would be worse than one left stubbed.
     */
    await classifyMessage({
      userId: USER_ID,
      mailAccountId: "mail_1",
      mailboxAddress: "owner@example.com",
      message: message(),
      ignoreCache: true,
    });

    const call = classificationUpsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({ messageId: MESSAGE_ID });
    expect(call.update).toMatchObject({
      category: "FINANCE",
      priorityScore: 70,
      model: "gemini-3.1-flash-lite",
    });
  });

  it("clears every threat column, so 'not assessed' is not left naming an assessor", async () => {
    /*
     * A bug the recompute turned from rare into routine, found by running it.
     *
     * Classification writes the threat columns as an honest "not assessed" placeholder and
     * the threat stage overwrites them moments later. When that stage is rate-limited —
     * which on a free tier is the normal weather — what survives is the placeholder, so it
     * has to be honest on its own. Before this, `threatIntent`/`threatExplanation`/
     * `threatModel` were left untouched on the update path, leaving 18 rows in a real
     * mailbox reading UNKNOWN while still naming the previous provider and carrying its
     * explanation.
     *
     * It also protects the invariant §6's retry loop is built on: `findUnassessedMessages`
     * treats UNKNOWN as "needs assessing", and a row that is UNKNOWN must not look assessed
     * by any other column.
     */
    await classifyMessage({
      userId: USER_ID,
      mailAccountId: "mail_1",
      mailboxAddress: "owner@example.com",
      message: message(),
      ignoreCache: true,
    });

    const { create, update } = classificationUpsert.mock.calls[0]?.[0];
    for (const fields of [create, update]) {
      expect(fields.threatLevel).toBe("UNKNOWN");
      expect(fields.threatScore).toBe(0);
      expect(fields.threatIntent).toBeNull();
      expect(fields.threatExplanation).toBeNull();
      expect(fields.threatModel).toBeNull();
    }
  });

  it("writes the new provider's model id, so the row says who produced it", async () => {
    // "Which provider wrote this" is the first question about any row after a switch.
    await classifyMessage({
      userId: USER_ID,
      mailAccountId: "mail_1",
      mailboxAddress: "owner@example.com",
      message: message(),
      ignoreCache: true,
    });

    expect(classificationUpsert.mock.calls[0]?.[0].create.model).toBe("gemini-3.1-flash-lite");
  });
});

describe("thread summaries", () => {
  const SUMMARY_OUTPUT = {
    data: {
      headline: "Dana is waiting on confirmation of the revised totals",
      summary: "Dana sent a revised invoice and needs the totals confirmed by Friday.",
      keyPoints: ["Invoice 4471 was revised."],
      actionItems: [{ text: "Confirm the totals", owner: "user" }],
    },
    model: "gemini-3.5-flash-lite",
    tokens: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };

  function summarize(overrides: Record<string, unknown> = {}) {
    return summarizeThread({
      userId: USER_ID,
      threadId: THREAD_ID,
      mailboxAddress: "owner@example.com",
      messages: [message()],
      ...overrides,
    });
  }

  beforeEach(() => {
    callStructured.mockResolvedValue(SUMMARY_OUTPUT);
  });

  it("serves the stored summary when not recomputing", async () => {
    const result = await summarize();

    expect(result.fromCache).toBe(true);
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("re-summarizes when recomputing, and does not fall back to the cache in the lock", async () => {
    /*
     * The subtle one. `summarizeThread` checks the cache twice — once before taking the
     * per-thread lock and once inside it, which is what turns a race into a cache hit. Under
     * a recompute the *second* check would find the very row it was asked to replace, so it
     * has to be skipped too, or forcing would silently do nothing.
     */
    const result = await summarize({ ignoreCache: true });

    expect(summaryFindFirst).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(false);
    expect(result.summary?.headline).toBe(SUMMARY_OUTPUT.data.headline);
  });

  it("replaces the row for this thread state", async () => {
    // Unique on (threadId, contentHash): the same thread state upserts onto one row.
    await summarize({ ignoreCache: true });

    expect(summaryUpsert.mock.calls[0]?.[0].where).toEqual({
      threadId_contentHash: { threadId: THREAD_ID, contentHash: expect.any(String) },
    });
    expect(summaryUpsert.mock.calls[0]?.[0].update.model).toBe("gemini-3.5-flash-lite");
  });

  it("keeps the §5 threshold separate from the cache bypass", async () => {
    /*
     * Two overrides that must not be conflated. `force` answers "is this thread worth
     * summarizing at all"; `ignoreCache` answers "is the stored answer wanted". A short
     * thread being recomputed is still a short thread.
     */
    const result = await summarizeThread({
      userId: USER_ID,
      threadId: THREAD_ID,
      mailboxAddress: "owner@example.com",
      // One short message: below the threshold.
      messages: [message({ bodyText: "Thanks!" })],
      ignoreCache: true,
    });

    expect(result.skipped).toBe("below-threshold");
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("summarizes a short thread when both overrides are given", async () => {
    const result = await summarizeThread({
      userId: USER_ID,
      threadId: THREAD_ID,
      mailboxAddress: "owner@example.com",
      messages: [message({ bodyText: "Thanks!" })],
      force: true,
      ignoreCache: true,
    });

    expect(result.fromCache).toBe(false);
    expect(callStructured).toHaveBeenCalledTimes(1);
  });
});
