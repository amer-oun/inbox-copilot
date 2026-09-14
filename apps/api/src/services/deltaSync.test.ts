import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Incremental sync.
 *
 * The tests that matter here are about ordering and recovery rather than about
 * plumbing: when does the cursor move, what is enriched, and what happens when the
 * cursor is too old to use. Each of those is a way to lose mail silently.
 */

const syncDelta = vi.hoisted(() => vi.fn());
const getThread = vi.hoisted(() => vi.fn());
const mailProviderFor = vi.hoisted(() => vi.fn());
vi.mock("../providers/registry.js", () => ({ mailProviderFor }));

const persistThread = vi.hoisted(() => vi.fn());
const startBackfill = vi.hoisted(() => vi.fn());
vi.mock("./sync.js", () => ({ persistThread, startBackfill }));

const enqueueEnrichment = vi.hoisted(() => vi.fn());
vi.mock("./ai/enrich.js", () => ({ enqueueEnrichment }));

const queueAdd = vi.hoisted(() => vi.fn());
const queueGetJob = vi.hoisted(() => vi.fn());
vi.mock("../lib/queues.js", () => ({
  DELTA_DEBOUNCE_MS: 2_000,
  deltaJobId: (id: string) => `delta-${id}`,
  syncDeltaQueue: () => ({ add: queueAdd, getJob: queueGetJob }),
}));

const accountFindFirst = vi.hoisted(() => vi.fn());
const accountUpdate = vi.hoisted(() => vi.fn());
const messageFindMany = vi.hoisted(() => vi.fn());
const messageDeleteMany = vi.hoisted(() => vi.fn());
const threadDeleteMany = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    mailAccount: { findFirst: accountFindFirst, update: accountUpdate },
    message: { findMany: messageFindMany, deleteMany: messageDeleteMany },
    thread: { deleteMany: threadDeleteMany },
  }),
  Prisma: {},
}));

const { enqueueDelta, foldChanges, runDelta } = await import("./deltaSync.js");
const { SyncCursorExpiredError } = await import("../lib/errors.js");

const USER_ID = "user_1";
const ACCOUNT_ID = "mail_1";
const MAILBOX = "person@example.com";

function mailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    userId: USER_ID,
    provider: "GMAIL",
    emailAddress: MAILBOX,
    syncStatus: "ACTIVE",
    syncCursor: "1000",
    ...overrides,
  };
}

function rawMessage(providerMessageId: string, overrides: Record<string, unknown> = {}) {
  return {
    providerMessageId,
    providerThreadId: "t_1",
    internetMessageId: `<${providerMessageId}@mail.example>`,
    from: { email: "dana@northwind.example" },
    to: [{ email: MAILBOX }],
    cc: [],
    bcc: [],
    replyTo: null,
    subject: "Invoice 4471",
    bodyText: "Body",
    bodyHtml: null,
    snippet: "Body",
    sentAt: new Date("2026-09-14T09:00:00Z"),
    isRead: false,
    isOutbound: false,
    isDraft: false,
    hasAttachments: false,
    headers: {},
    authResults: { spf: null, dkim: null, dmarc: null, returnPath: null, displayNameMismatch: false },
    contentHash: `hash-${providerMessageId}`,
    attachments: [],
    labels: ["INBOX"],
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    mailAccountId: ACCOUNT_ID,
    userId: USER_ID,
    reason: "webhook" as const,
    ...overrides,
  };
}

beforeEach(() => {
  mailProviderFor.mockReset().mockReturnValue({ syncDelta, getThread });
  syncDelta.mockReset().mockResolvedValue({
    changes: [{ kind: "upserted", providerThreadId: "t_1", providerMessageId: "m_2" }],
    cursor: "2000",
  });
  getThread.mockReset().mockResolvedValue({
    providerThreadId: "t_1",
    historyId: "2000",
    messages: [rawMessage("m_1"), rawMessage("m_2")],
  });
  persistThread.mockReset().mockResolvedValue(["local_1", "local_2"]);
  startBackfill.mockReset().mockResolvedValue({ enqueued: true, jobId: "backfill-mail_1" });
  enqueueEnrichment.mockReset().mockImplementation(({ messageIds }: { messageIds: string[] }) =>
    Promise.resolve(messageIds.length),
  );
  accountFindFirst.mockReset().mockResolvedValue(mailbox());
  accountUpdate.mockReset().mockResolvedValue({});
  // "m_1 already known, m_2 is new".
  messageFindMany.mockReset().mockResolvedValue([{ providerMessageId: "m_1" }]);
  messageDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  threadDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  queueAdd.mockReset().mockResolvedValue({ id: "delta-mail_1" });
  queueGetJob.mockReset().mockResolvedValue(null);
});

describe("foldChanges", () => {
  it("collapses many changes into the set of threads to re-read", () => {
    const folded = foldChanges([
      { kind: "upserted", providerThreadId: "t_1", providerMessageId: "m_1" },
      { kind: "upserted", providerThreadId: "t_1", providerMessageId: "m_2" },
      { kind: "labelsChanged", providerThreadId: "t_2", providerMessageId: "m_3", labelsAdded: ["STARRED"], labelsRemoved: [] },
    ]);

    expect(folded.threadIds).toEqual(["t_1", "t_2"]);
    expect(folded.deletedMessageIds).toEqual([]);
  });

  it("keeps a deleted message's thread in the refetch set", () => {
    // The thread's count, snippet and last message all change when one leaves.
    const folded = foldChanges([
      { kind: "deleted", providerThreadId: "t_9", providerMessageId: "m_9" },
    ]);

    expect(folded.deletedMessageIds).toEqual(["m_9"]);
    expect(folded.threadIds).toEqual(["t_9"]);
  });
});

describe("runDelta", () => {
  it("reads from the stored cursor, never from anything a caller supplied", async () => {
    await runDelta(job());
    expect(syncDelta).toHaveBeenCalledWith("1000");
  });

  it("advances the cursor only after the threads have been written", async () => {
    const order: string[] = [];
    persistThread.mockImplementation(() => {
      order.push("persist");
      return Promise.resolve(["local_1", "local_2"]);
    });
    accountUpdate.mockImplementation(() => {
      order.push("cursor");
      return Promise.resolve({});
    });

    const result = await runDelta(job());

    expect(order).toEqual(["persist", "cursor"]);
    expect(result.cursor).toBe("2000");
    expect(accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ syncCursor: "2000" }) }),
    );
  });

  it("leaves the cursor alone when a thread fetch fails", async () => {
    // The whole safety rail: an unadvanced cursor means the next delta covers this
    // window again. Advancing first would lose these messages permanently.
    getThread.mockRejectedValue(new Error("gmail exploded"));

    await expect(runDelta(job())).rejects.toThrow(/gmail exploded/);
    expect(accountUpdate).not.toHaveBeenCalled();
  });

  it("enriches new inbound messages only", async () => {
    await runDelta(job());

    // m_1 was already stored, so only m_2 is new.
    expect(enqueueEnrichment).toHaveBeenCalledWith({
      userId: USER_ID,
      mailAccountId: ACCOUNT_ID,
      messageIds: ["local_2"],
    });
  });

  it("does not enrich the user's own sent mail", async () => {
    getThread.mockResolvedValue({
      providerThreadId: "t_1",
      historyId: "2000",
      messages: [rawMessage("m_1"), rawMessage("m_2", { isOutbound: true })],
    });

    const result = await runDelta(job());

    expect(enqueueEnrichment).not.toHaveBeenCalled();
    expect(result.enriched).toBe(0);
  });

  it("does not re-enrich a message it already had", async () => {
    // A label change re-fetches the whole thread; paying to classify it again would be
    // a bill for answers already in the database.
    messageFindMany.mockResolvedValue([
      { providerMessageId: "m_1" },
      { providerMessageId: "m_2" },
    ]);

    const result = await runDelta(job());

    expect(enqueueEnrichment).not.toHaveBeenCalled();
    expect(result.messages).toBe(2);
  });

  it("asks which messages are known before writing them, not after", async () => {
    const order: string[] = [];
    messageFindMany.mockImplementation(() => {
      order.push("read");
      return Promise.resolve([{ providerMessageId: "m_1" }]);
    });
    persistThread.mockImplementation(() => {
      order.push("write");
      return Promise.resolve(["local_1", "local_2"]);
    });

    await runDelta(job());

    // Afterwards every message exists and "new" is unanswerable.
    expect(order).toEqual(["read", "write"]);
  });

  it("removes messages that are gone provider-side", async () => {
    syncDelta.mockResolvedValue({
      changes: [{ kind: "deleted", providerThreadId: "t_1", providerMessageId: "m_1" }],
      cursor: "2000",
    });
    messageDeleteMany.mockResolvedValue({ count: 1 });

    const result = await runDelta(job());

    expect(messageDeleteMany).toHaveBeenCalledWith({
      where: { mailAccountId: ACCOUNT_ID, providerMessageId: { in: ["m_1"] } },
    });
    expect(result.deleted).toBe(1);
  });

  it("removes a thread that no longer exists provider-side", async () => {
    getThread.mockRejectedValue(
      Object.assign(new Error("not found"), { response: { status: 404 } }),
    );
    threadDeleteMany.mockResolvedValue({ count: 1 });

    const result = await runDelta(job());

    expect(threadDeleteMany).toHaveBeenCalledWith({
      where: { mailAccountId: ACCOUNT_ID, providerThreadId: "t_1" },
    });
    expect(result.threads).toBe(0);
    // Still a successful delta, so the cursor moves past this change.
    expect(result.cursor).toBe("2000");
  });

  it("advances the cursor on an empty change list", async () => {
    // Gmail publishes for changes we do not model, and a debounced burst often lands
    // after the sync that covered it. Holding the cursor would re-read forever.
    syncDelta.mockResolvedValue({ changes: [], cursor: "2500" });

    const result = await runDelta(job());

    expect(result.skipped).toBe("no-changes");
    expect(result.cursor).toBe("2500");
    expect(getThread).not.toHaveBeenCalled();
  });

  it("falls back to a full backfill when the cursor has expired", async () => {
    syncDelta.mockRejectedValue(new SyncCursorExpiredError("too old"));

    const result = await runDelta(job());

    expect(result.recovered).toBe("backfill");
    expect(startBackfill).toHaveBeenCalledWith({ userId: USER_ID, mailAccountId: ACCOUNT_ID });
    // The stale cursor is cleared, so nothing tries to be incremental from it again.
    expect(accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ syncCursor: null }) }),
    );
  });

  it("leaves a mailbox with no cursor to the backfill", async () => {
    accountFindFirst.mockResolvedValue(mailbox({ syncCursor: null }));

    const result = await runDelta(job());

    expect(result.skipped).toBe("no-cursor");
    expect(syncDelta).not.toHaveBeenCalled();
    expect(startBackfill).toHaveBeenCalled();
  });

  it("refuses a revoked mailbox permanently rather than retrying", async () => {
    accountFindFirst.mockResolvedValue(mailbox({ syncStatus: "REVOKED" }));

    await expect(runDelta(job())).rejects.toThrow(/reconnect/i);
    expect(syncDelta).not.toHaveBeenCalled();
  });

  it("is a 404 for a mailbox the user does not own", async () => {
    accountFindFirst.mockResolvedValue(null);
    await expect(runDelta(job())).rejects.toThrow(/Mailbox not found/);
  });

  it("clears an earlier ERROR status once a delta succeeds", async () => {
    accountFindFirst.mockResolvedValue(mailbox({ syncStatus: "ERROR" }));

    await runDelta(job());

    expect(accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ syncStatus: "ACTIVE" }) }),
    );
  });

  it("holds the cursor and re-queues when there are more threads than one run takes", async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      kind: "upserted" as const,
      providerThreadId: `t_${index}`,
      providerMessageId: `m_${index}`,
    }));
    syncDelta.mockResolvedValue({ changes: many, cursor: "9000" });
    getThread.mockImplementation((id: string) =>
      Promise.resolve({
        providerThreadId: id,
        historyId: "9000",
        messages: [rawMessage("m_x", { providerThreadId: id })],
      }),
    );

    const result = await runDelta(job());

    expect(result.threads).toBe(40);
    // The deferred threads' changes are inside this window: advancing past them would
    // drop the ten we did not fetch.
    expect(accountUpdate).not.toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalled();
  });
});

describe("enqueueDelta", () => {
  it("queues one delayed job keyed on the mailbox", async () => {
    const result = await enqueueDelta({ userId: USER_ID, mailAccountId: ACCOUNT_ID });

    expect(result).toEqual({ queued: true, jobId: "delta-mail_1" });
    expect(queueAdd).toHaveBeenCalledWith(
      "delta",
      { mailAccountId: ACCOUNT_ID, userId: USER_ID, reason: "webhook" },
      { jobId: "delta-mail_1", delay: 2_000 },
    );
  });

  it("collapses a burst onto the job already waiting", async () => {
    // Gmail publishes one notification per change: a four-message thread arrives as
    // four pushes, and this is what makes them one sync.
    queueGetJob.mockResolvedValue({ getState: async () => "delayed" });

    const result = await enqueueDelta({ userId: USER_ID, mailAccountId: ACCOUNT_ID });

    expect(result.queued).toBe(false);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("clears a finished job's id, which BullMQ would otherwise refuse to reuse", async () => {
    // Without this the *next* notification after a sync is silently dropped and the
    // mailbox goes quiet until the hourly keeper notices.
    const remove = vi.fn().mockResolvedValue(undefined);
    queueGetJob.mockResolvedValue({ getState: async () => "completed", remove });

    const result = await enqueueDelta({ userId: USER_ID, mailAccountId: ACCOUNT_ID });

    expect(remove).toHaveBeenCalled();
    expect(result.queued).toBe(true);
  });

  it("never throws: a webhook still has to answer Pub/Sub", async () => {
    queueGetJob.mockRejectedValue(new Error("redis is down"));

    const result = await enqueueDelta({ userId: USER_ID, mailAccountId: ACCOUNT_ID });
    expect(result.queued).toBe(false);
  });
});
