import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `ai.enrich` pipeline, with classification and summarization stubbed: what is
 * under test here is the orchestration — tenancy, denormalization, and which
 * conditions are outcomes rather than failures.
 */

const messageFindFirst = vi.hoisted(() => vi.fn());
const messageFindMany = vi.hoisted(() => vi.fn());
const threadUpdate = vi.hoisted(() => vi.fn());
const settingsFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: (userId: string) => {
    tenantCalls.push(userId);
    return {
      message: { findFirst: messageFindFirst, findMany: messageFindMany },
      thread: { update: threadUpdate },
      userSettings: { findFirst: settingsFindFirst },
    };
  },
  Prisma: {},
}));

const tenantCalls = vi.hoisted(() => [] as string[]);
const classifyMessage = vi.hoisted(() => vi.fn());
const summarizeThread = vi.hoisted(() => vi.fn());
const addBulk = vi.hoisted(() => vi.fn());
const getJob = vi.hoisted(() => vi.fn());

const assessMessageThreat = vi.hoisted(() => vi.fn());
const refreshThreadThreatLevel = vi.hoisted(() => vi.fn());

vi.mock("./classify.js", () => ({ classifyMessage }));
vi.mock("./summarize.js", () => ({ summarizeThread }));
vi.mock("../security/phishing.js", () => ({
  assessMessageThreat,
  refreshThreadThreatLevel,
  THREAT_MESSAGE_SELECT: { authResults: true, attachments: true },
}));
vi.mock("../../lib/queues.js", () => ({
  aiEnrichQueue: () => ({ addBulk, getJob }),
  aiEnrichJobId: (id: string) => `enrich-${id}`,
}));

const { runEnrich, enqueueEnrichment } = await import("./enrich.js");
const { AiCapExceededError, AiDisabledError, NotFoundError } = await import(
  "../../lib/errors.js"
);

const USER_ID = "user_1";
const MAIL_ACCOUNT_ID = "mail_1";
const JOB = { userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID, messageId: "msg_1" };

const ROW = {
  id: "msg_1",
  subject: "Invoice 4471",
  fromName: "Dana",
  fromEmail: "dana@northwind.example",
  to: ["person@example.com"],
  cc: [],
  replyTo: null,
  sentAt: new Date("2026-09-10T09:00:00Z"),
  bodyText: "body",
  bodyHtml: null,
  snippet: "body",
  isOutbound: false,
  hasAttachments: false,
  contentHash: "hash-1",
  threadId: "thread_1",
  authResults: { spf: "pass", dkim: "pass", dmarc: "pass", returnPath: null, displayNameMismatch: false },
  attachments: [],
  mailAccount: { emailAddress: "person@example.com" },
};

const CLASSIFICATION = {
  classification: {
    category: "FINANCE",
    priority: "HIGH",
    priorityScore: 72,
    needsReply: true,
    language: "en",
  },
  fromCache: false,
  model: "claude-haiku-4-5-20251001",
};

beforeEach(() => {
  tenantCalls.length = 0;
  messageFindFirst.mockReset().mockResolvedValue(ROW);
  messageFindMany.mockReset().mockResolvedValue([ROW]);
  threadUpdate.mockReset().mockResolvedValue({});
  settingsFindFirst.mockReset().mockResolvedValue({
    aiEnabled: true,
    autoSummarize: true,
    autoCategorize: true,
    phishingProtection: true,
    dailyAiCallCap: 500,
  });
  classifyMessage.mockReset().mockResolvedValue(CLASSIFICATION);
  assessMessageThreat.mockReset().mockResolvedValue({
    level: "SAFE",
    score: 0,
    reasons: [],
    rules: { score: 0, floor: "SAFE" },
    intent: "BENIGN_MARKETING",
    rulesOnly: false,
    fromCache: false,
    model: "claude-sonnet-5",
  });
  refreshThreadThreatLevel.mockReset().mockResolvedValue("SAFE");
  summarizeThread
    .mockReset()
    .mockResolvedValue({ summary: null, fromCache: false, skipped: "below-threshold" });
  addBulk.mockReset().mockResolvedValue([]);
  getJob.mockReset().mockResolvedValue(null);
});

describe("runEnrich", () => {
  it("classifies and denormalizes onto the thread", async () => {
    const result = await runEnrich(JOB);

    expect(result.classified).toBe(true);
    expect(threadUpdate).toHaveBeenCalledWith({
      where: { id: "thread_1" },
      data: {
        category: "FINANCE",
        priority: "HIGH",
        priorityScore: 72,
        needsReply: true,
        language: "en",
      },
    });
  });

  it("does not denormalize an older message over a newer classification", async () => {
    // The newest message in the thread is a different one, so this message's
    // classification describes history, not the thread's current state.
    messageFindFirst
      .mockResolvedValueOnce(ROW)
      .mockResolvedValueOnce({ id: "msg_newer" });

    await runEnrich(JOB);

    expect(classifyMessage).toHaveBeenCalledTimes(1);
    expect(threadUpdate).not.toHaveBeenCalled();
  });

  it("does not write threatLevel with the classification", async () => {
    /*
     * The threat level is a rollup of every message in the thread rather than a property
     * of its newest one, so it is written by `refreshThreadThreatLevel` and not here. A
     * classification that also set it would clear the banner on an older forged message
     * every time a benign reply arrived.
     */
    await runEnrich(JOB);

    expect(Object.keys(threadUpdate.mock.calls[0]?.[0].data)).not.toContain("threatLevel");
    expect(refreshThreadThreatLevel).toHaveBeenCalledWith(USER_ID, "thread_1");
  });

  it("assesses the message and reports the verdict", async () => {
    const result = await runEnrich(JOB);

    expect(result.threatLevel).toBe("SAFE");
    expect(assessMessageThreat).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        mailAccountId: MAIL_ACCOUNT_ID,
        mailboxAddress: "person@example.com",
      }),
    );
  });

  it("classifies before it assesses", async () => {
    // The classification row has to exist before there is somewhere to put a verdict.
    const order: string[] = [];
    classifyMessage.mockImplementation(async () => {
      order.push("classify");
      return CLASSIFICATION;
    });
    assessMessageThreat.mockImplementation(async () => {
      order.push("assess");
      return { level: "SAFE", score: 0, reasons: [], rules: {}, intent: null, rulesOnly: true, fromCache: false, model: null };
    });

    await runEnrich(JOB);

    expect(order).toEqual(["classify", "assess"]);
  });

  it("does not assess the user's own sent mail", async () => {
    // Scoring outbound mail would put a threat banner on the user's own words.
    messageFindFirst.mockResolvedValue({ ...ROW, isOutbound: true });

    const result = await runEnrich(JOB);

    expect(assessMessageThreat).not.toHaveBeenCalled();
    expect(result.skipped).toContain("threat-outbound");
  });

  it("does not lose the classification when the assessment throws", async () => {
    /*
     * A message that could not be assessed keeps its honest UNKNOWN and the sweep picks it
     * up again. Failing the job would throw away the classification and the summary too,
     * which is a worse outcome than one unassessed message.
     */
    assessMessageThreat.mockRejectedValue(new Error("link parse blew up"));

    const result = await runEnrich(JOB);

    expect(result.classified).toBe(true);
    expect(result.skipped).toContain("threat-failed");
    expect(result.threatLevel).toBeUndefined();
  });

  it("reports a spent cap as an outcome, not as a threat failure", async () => {
    // A cap belongs to the pipeline as a whole and is handled by the existing cap path —
    // it is not something the threat stage should swallow into "failed", where the
    // distinction between "we could not" and "we ran out of budget" would be lost.
    assessMessageThreat.mockRejectedValue(new AiCapExceededError("cap", { used: 500, cap: 500 }));

    const result = await runEnrich(JOB);

    expect(result.skipped).toContain("cap");
    expect(result.skipped).not.toContain("threat-failed");
  });

  it("skips the whole layer when phishing protection is off", async () => {
    settingsFindFirst.mockResolvedValue({
      aiEnabled: true,
      autoSummarize: true,
      autoCategorize: true,
      phishingProtection: false,
      dailyAiCallCap: 500,
    });

    const result = await runEnrich(JOB);

    expect(assessMessageThreat).not.toHaveBeenCalled();
    expect(refreshThreadThreatLevel).not.toHaveBeenCalled();
    expect(result.skipped).toContain("threat-off");
  });

  it("summarizes the thread with its messages oldest first", async () => {
    summarizeThread.mockResolvedValue({
      summary: { headline: "h", summary: "s", keyPoints: [], actionItems: [] },
      fromCache: false,
    });

    const result = await runEnrich(JOB);

    expect(result.summarized).toBe(true);
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { sentAt: "asc" } }),
    );
  });

  it("reports a below-threshold thread as skipped, not summarized", async () => {
    const result = await runEnrich(JOB);

    expect(result.summarized).toBe(false);
    expect(result.skipped).toContain("below-threshold");
  });

  it("reads everything through the tenancy client", async () => {
    // Rule 4: the AI rows are reached through relations, so this read is the
    // ownership check the writes rely on.
    await runEnrich(JOB);

    expect(tenantCalls.length).toBeGreaterThan(0);
    expect(new Set(tenantCalls)).toEqual(new Set([USER_ID]));
    expect(messageFindFirst.mock.calls[0]?.[0].where).toEqual({
      id: "msg_1",
      mailAccountId: MAIL_ACCOUNT_ID,
    });
  });

  it("fails with NotFound for a message belonging to another user", async () => {
    // The tenancy filter makes another user's message simply not exist.
    messageFindFirst.mockResolvedValue(null);

    await expect(runEnrich(JOB)).rejects.toThrow(NotFoundError);
    expect(classifyMessage).not.toHaveBeenCalled();
  });
});

describe("runEnrich settings and limits", () => {
  it("does nothing when the user has AI disabled", async () => {
    settingsFindFirst.mockResolvedValue({
      aiEnabled: false,
      autoSummarize: true,
      autoCategorize: true,
      dailyAiCallCap: 500,
    });

    const result = await runEnrich(JOB);

    expect(result.skipped).toEqual(["disabled"]);
    expect(messageFindFirst).not.toHaveBeenCalled();
    expect(classifyMessage).not.toHaveBeenCalled();
  });

  it("honours autoCategorize off while still summarizing", async () => {
    settingsFindFirst.mockResolvedValue({
      aiEnabled: true,
      autoSummarize: true,
      autoCategorize: false,
      dailyAiCallCap: 500,
    });

    const result = await runEnrich(JOB);

    expect(classifyMessage).not.toHaveBeenCalled();
    expect(summarizeThread).toHaveBeenCalledTimes(1);
    expect(result.skipped).toContain("categorize-off");
  });

  it("honours autoSummarize off while still classifying", async () => {
    settingsFindFirst.mockResolvedValue({
      aiEnabled: true,
      autoSummarize: false,
      autoCategorize: true,
      dailyAiCallCap: 500,
    });

    const result = await runEnrich(JOB);

    expect(result.classified).toBe(true);
    expect(summarizeThread).not.toHaveBeenCalled();
    expect(result.skipped).toContain("summarize-off");
  });

  it("completes rather than failing when the cap is hit", async () => {
    // A retry cannot clear a daily cap, so throwing here would burn three attempts
    // to rediscover the same thing.
    classifyMessage.mockRejectedValue(
      new AiCapExceededError("Daily AI call cap reached", { used: 500, cap: 500 }),
    );

    const result = await runEnrich(JOB);

    expect(result.skipped).toContain("cap");
    expect(result.classified).toBe(false);
    expect(summarizeThread).not.toHaveBeenCalled();
  });

  it("keeps the classification when the cap is hit during summarization", async () => {
    summarizeThread.mockRejectedValue(new AiCapExceededError("Daily AI call cap reached"));

    const result = await runEnrich(JOB);

    expect(result.classified).toBe(true);
    expect(result.summarized).toBe(false);
    expect(result.skipped).toContain("cap");
  });

  it("completes when AI is disabled mid-run", async () => {
    classifyMessage.mockRejectedValue(new AiDisabledError("AI features are disabled"));

    const result = await runEnrich(JOB);
    expect(result.skipped).toContain("disabled");
  });

  it("propagates a real failure so BullMQ retries it", async () => {
    classifyMessage.mockRejectedValue(new Error("anthropic 529"));

    await expect(runEnrich(JOB)).rejects.toThrow("anthropic 529");
  });

  it("reports a cache hit without claiming a call was made", async () => {
    classifyMessage.mockResolvedValue({ ...CLASSIFICATION, fromCache: true });

    const result = await runEnrich(JOB);

    expect(result.classified).toBe(true);
    expect(result.skipped).toContain("classify-cache");
  });
});

describe("enqueueEnrichment", () => {
  it("queues one job per message, keyed by message id", async () => {
    const queued = await enqueueEnrichment({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      messageIds: ["msg_1", "msg_2"],
    });

    expect(queued).toBe(2);
    expect(addBulk).toHaveBeenCalledWith([
      {
        name: "enrich",
        data: { messageId: "msg_1", mailAccountId: MAIL_ACCOUNT_ID, userId: USER_ID },
        opts: { jobId: "enrich-msg_1" },
      },
      {
        name: "enrich",
        data: { messageId: "msg_2", mailAccountId: MAIL_ACCOUNT_ID, userId: USER_ID },
        opts: { jobId: "enrich-msg_2" },
      },
    ]);
  });

  it("does not touch the queue for an empty list", async () => {
    expect(
      await enqueueEnrichment({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID, messageIds: [] }),
    ).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it("leaves a job that is still pending alone", async () => {
    getJob.mockResolvedValue({ getState: async () => "waiting", remove: vi.fn() });

    const queued = await enqueueEnrichment({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      messageIds: ["msg_1"],
    });

    expect(queued).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it("clears a finished job's id so the message can be enriched again", async () => {
    /*
     * The bug this pins: BullMQ retains completed jobs, and an id it still holds it
     * silently refuses to re-add. Without the removal the cap sweep would do nothing
     * for the ten minutes after a capped run — precisely when it is needed.
     */
    const remove = vi.fn().mockResolvedValue(undefined);
    getJob.mockResolvedValue({ getState: async () => "completed", remove });

    const queued = await enqueueEnrichment({
      userId: USER_ID,
      mailAccountId: MAIL_ACCOUNT_ID,
      messageIds: ["msg_1"],
    });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(queued).toBe(1);
    expect(addBulk).toHaveBeenCalledWith([
      expect.objectContaining({ opts: { jobId: "enrich-msg_1" } }),
    ]);
  });

  it("clears a failed job's id too", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    getJob.mockResolvedValue({ getState: async () => "failed", remove });

    expect(
      await enqueueEnrichment({
        userId: USER_ID,
        mailAccountId: MAIL_ACCOUNT_ID,
        messageIds: ["msg_1"],
      }),
    ).toBe(1);
    expect(remove).toHaveBeenCalled();
  });

  it("skips a job it cannot remove rather than failing the batch", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("job is locked"));
    getJob.mockResolvedValue({ getState: async () => "completed", remove });

    expect(
      await enqueueEnrichment({
        userId: USER_ID,
        mailAccountId: MAIL_ACCOUNT_ID,
        messageIds: ["msg_1"],
      }),
    ).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it("swallows a queue failure rather than failing a committed sync", async () => {
    // The mail is already on disk. Losing the follow-up work is recoverable;
    // failing the backfill that stored it is not.
    addBulk.mockRejectedValue(new Error("redis down"));

    await expect(
      enqueueEnrichment({
        userId: USER_ID,
        mailAccountId: MAIL_ACCOUNT_ID,
        messageIds: ["msg_1"],
      }),
    ).resolves.toBe(0);
  });
});
