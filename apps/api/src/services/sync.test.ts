import { beforeEach, describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "googleapis";
import invoiceThread from "../providers/gmail/__fixtures__/thread-invoice.json" with { type: "json" };
import { ConflictError, NotFoundError } from "../lib/errors.js";

/**
 * The sync engine's contract (§4), with Prisma and the provider both stubbed.
 *
 * The assertions that matter most are about *ordering*: status transitions, and the
 * rule that the delta cursor advances only after the rows it covers are committed.
 * A cursor that moves early is a silent data gap, which is why it gets its own
 * tests rather than being implied by a happy path.
 */

const findFirst = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const threadCount = vi.hoisted(() => vi.fn());
const messageCount = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());
const writes = vi.hoisted(() => [] as { field: string; value: unknown }[]);
/** Each mailAccount.update() call as one group: lets a test assert "same write". */
const updateGroups = vi.hoisted(() => [] as Record<string, unknown>[]);

const threadUpsert = vi.hoisted(() => vi.fn());
const messageUpsert = vi.hoisted(() => vi.fn());
const attachmentDeleteMany = vi.hoisted(() => vi.fn());
const attachmentCreateMany = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    mailAccount: {
      findFirst,
      update: (args: { data: Record<string, unknown> }) => {
        // Record the order of status/cursor writes; ordering is the contract.
        for (const [field, value] of Object.entries(args.data)) {
          writes.push({ field, value });
        }
        updateGroups.push(args.data);
        return update(args);
      },
    },
    thread: { count: threadCount },
    message: { count: messageCount },
    $transaction: transaction,
  }),
  Prisma: {},
}));

const getJob = vi.hoisted(() => vi.fn());
const add = vi.hoisted(() => vi.fn());
/** Enrichment is queued after each page commits; §5's ai.enrich pipeline. */
const enrichAddBulk = vi.hoisted(() => vi.fn());

vi.mock("../lib/queues.js", () => ({
  syncBackfillQueue: () => ({ getJob, add }),
  backfillJobId: (id: string) => `backfill-${id}`,
  aiEnrichQueue: () => ({ addBulk: enrichAddBulk }),
  aiEnrichJobId: (id: string) => `enrich-${id}`,
  QUEUE_NAMES: { syncBackfill: "sync.backfill", aiEnrich: "ai.enrich" },
}));

const listThreadIds = vi.hoisted(() => vi.fn());
const getThread = vi.hoisted(() => vi.fn());
const getProfile = vi.hoisted(() => vi.fn());

const providerContexts = vi.hoisted(() => [] as { signal?: AbortSignal }[]);

vi.mock("../providers/registry.js", () => ({
  mailProviderFor: (_type: string, context: { signal?: AbortSignal }) => {
    providerContexts.push(context);
    return { providerType: "GMAIL", getProfile, listThreadIds, getThread };
  },
}));

const { getSyncStatus, runBackfill, startBackfill, riskFlagFor, persistThread } = await import(
  "./sync.js"
);
const { mapThread } = await import("../providers/gmail/map.js");

const USER_ID = "cldd4kzai000008l3a1b2c3d4";
const MAIL_ACCOUNT_ID = "cldd4kzai000108l3a1b2c3d4";

const MAILBOX = {
  id: MAIL_ACCOUNT_ID,
  userId: USER_ID,
  provider: "GMAIL" as const,
  emailAddress: "person@example.com",
  syncStatus: "PENDING",
  syncCursor: null,
  backfillPageToken: null,
  backfillCursor: null,
};

const THREAD = mapThread(invoiceThread as gmail_v1.Schema$Thread, {
  mailboxAddress: "person@example.com",
});

/** A transaction stub that records what the thread/message upserts were given. */
function stubTransaction(): void {
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      thread: { upsert: threadUpsert },
      message: { upsert: messageUpsert },
      attachment: { deleteMany: attachmentDeleteMany, createMany: attachmentCreateMany },
    }),
  );
}

function statusWrites(): unknown[] {
  return writes.filter((write) => write.field === "syncStatus").map((write) => write.value);
}

describe("startBackfill", () => {
  beforeEach(() => {
    writes.length = 0;
    updateGroups.length = 0;
    findFirst.mockReset().mockResolvedValue(MAILBOX);
    update.mockReset().mockResolvedValue({});
    getJob.mockReset().mockResolvedValue(null);
    add.mockReset().mockResolvedValue({ id: `backfill-${MAIL_ACCOUNT_ID}` });
  });

  it("queues a job keyed on the mailbox", async () => {
    const result = await startBackfill({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });

    expect(result).toEqual({
      enqueued: true,
      jobId: `backfill-${MAIL_ACCOUNT_ID}`,
      syncStatus: "PENDING",
    });
    expect(add).toHaveBeenCalledWith(
      "backfill",
      { mailAccountId: MAIL_ACCOUNT_ID, userId: USER_ID, windowDays: 90 },
      { jobId: `backfill-${MAIL_ACCOUNT_ID}` },
    );
  });

  it("does not queue a second pass while one is already running", async () => {
    // Pressing "Sync now" twice must not cost twice the Gmail quota.
    getJob.mockResolvedValue({ getState: async () => "active", remove: vi.fn() });

    const result = await startBackfill({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });

    expect(result.enqueued).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it("replaces a finished job so the mailbox can be re-synced", async () => {
    const remove = vi.fn();
    getJob.mockResolvedValue({ getState: async () => "completed", remove });

    const result = await startBackfill({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });

    expect(remove).toHaveBeenCalled();
    expect(result.enqueued).toBe(true);
  });

  it("refuses a revoked mailbox instead of queueing work that cannot succeed", async () => {
    findFirst.mockResolvedValue({ ...MAILBOX, syncStatus: "REVOKED" });

    await expect(
      startBackfill({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID }),
    ).rejects.toThrow(ConflictError);
    expect(add).not.toHaveBeenCalled();
  });

  it("404s for a mailbox that is not the caller's", async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      startBackfill({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("runBackfill", () => {
  beforeEach(() => {
    writes.length = 0;
    updateGroups.length = 0;
    findFirst.mockReset().mockResolvedValue(MAILBOX);
    update.mockReset().mockResolvedValue({});
    getProfile.mockReset().mockResolvedValue({
      emailAddress: "person@example.com",
      providerAccountId: "person@example.com",
      historyId: "555000",
    });
    listThreadIds.mockReset();
    getThread.mockReset().mockResolvedValue(THREAD);
    threadUpsert.mockReset().mockResolvedValue({ id: "thread-row-1" });
    messageUpsert.mockReset().mockResolvedValue({ id: "message-row-1" });
    attachmentDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    attachmentCreateMany.mockReset().mockResolvedValue({ count: 0 });
    enrichAddBulk.mockReset().mockResolvedValue([]);
    stubTransaction();
  });

  const job = { userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID, windowDays: 90 };

  it("queues ai enrichment for the messages a page wrote", async () => {
    listThreadIds.mockResolvedValue({ items: ["t1"], nextPageToken: null });

    await runBackfill(job);

    expect(enrichAddBulk).toHaveBeenCalledTimes(1);
    const queued = enrichAddBulk.mock.calls[0]?.[0] as { data: { messageId: string } }[];
    expect(queued).toHaveLength(2);
    expect(queued[0]?.data).toMatchObject({
      messageId: "message-row-1",
      mailAccountId: MAIL_ACCOUNT_ID,
      userId: USER_ID,
    });
  });

  it("queues nothing for a page whose transaction failed", async () => {
    // Enrichment must never be pointed at rows that were not committed.
    listThreadIds.mockResolvedValue({ items: ["t1"], nextPageToken: null });
    transaction.mockRejectedValue(new Error("deadlock"));

    await expect(runBackfill(job)).rejects.toThrow("deadlock");
    expect(enrichAddBulk).not.toHaveBeenCalled();
  });

  it("queues per page rather than once at the end", async () => {
    // A long backfill should start enriching while it is still paging.
    listThreadIds
      .mockResolvedValueOnce({ items: ["t1"], nextPageToken: "page-2" })
      .mockResolvedValueOnce({ items: ["t2"], nextPageToken: null });

    await runBackfill(job);

    expect(enrichAddBulk).toHaveBeenCalledTimes(2);
  });

  it("pages until the provider reports no next page", async () => {
    listThreadIds
      .mockResolvedValueOnce({ items: ["t1", "t2"], nextPageToken: "p2" })
      .mockResolvedValueOnce({ items: ["t3"], nextPageToken: null });

    const progress = await runBackfill(job);

    expect(listThreadIds).toHaveBeenCalledTimes(2);
    expect(progress.threadsProcessed).toBe(3);
    expect(progress.pagesRead).toBe(2);
  });

  it("asks for 50 threads per batch across a 90-day window", async () => {
    listThreadIds.mockResolvedValue({ items: [], nextPageToken: null });

    await runBackfill(job);

    const [options] = listThreadIds.mock.calls[0] as [{ limit: number; after: Date }];
    expect(options.limit).toBe(50);
    const days = (Date.now() - options.after.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it("moves PENDING → BACKFILLING → ACTIVE", async () => {
    listThreadIds.mockResolvedValue({ items: ["t1"], nextPageToken: null });

    await runBackfill(job);

    expect(statusWrites()).toEqual(["BACKFILLING", "ACTIVE"]);
  });

  it("reads the history pointer before paging, so nothing arriving mid-run is skipped", async () => {
    const order: string[] = [];
    getProfile.mockImplementation(async () => {
      order.push("getProfile");
      return { emailAddress: "p@e.test", providerAccountId: "p", historyId: "555000" };
    });
    listThreadIds.mockImplementation(async () => {
      order.push("listThreadIds");
      return { items: [], nextPageToken: null };
    });

    await runBackfill(job);

    expect(order).toEqual(["getProfile", "listThreadIds"]);
  });

  it("advances the cursor only in the final write, after the rows are committed", async () => {
    listThreadIds.mockResolvedValue({ items: ["t1"], nextPageToken: null });

    await runBackfill(job);

    // The cursor moves exactly once, in the same update that flips to ACTIVE and
    // clears the checkpoint — i.e. after every thread transaction has committed.
    const cursorWrites = updateGroups.filter((data) => "syncCursor" in data);
    expect(cursorWrites).toHaveLength(1);
    expect(cursorWrites[0]).toMatchObject({
      syncCursor: "555000",
      syncStatus: "ACTIVE",
      backfillCursor: null,
      backfillPageToken: null,
    });

    // And it is the last write of the run.
    expect(updateGroups.at(-1)).toBe(cursorWrites[0]);
    expect(transaction).toHaveBeenCalled();
  });

  it("leaves the cursor untouched when a page fails, so the next run replays", async () => {
    listThreadIds.mockRejectedValue(new Error("gmail exploded"));

    await expect(runBackfill(job)).rejects.toThrow("gmail exploded");

    expect(writes.some((write) => write.field === "syncCursor")).toBe(false);
    expect(statusWrites()).toEqual(["BACKFILLING", "ERROR"]);
  });

  it("records a short failure reason on the mailbox", async () => {
    listThreadIds.mockRejectedValue(new Error("x".repeat(900)));

    await expect(runBackfill(job)).rejects.toThrow();

    const errorWrite = writes.find((write) => write.field === "syncError" && write.value);
    expect(String(errorWrite?.value).length).toBeLessThanOrEqual(500);
  });

  it("reports progress per page", async () => {
    listThreadIds
      .mockResolvedValueOnce({ items: ["t1"], nextPageToken: "p2" })
      .mockResolvedValueOnce({ items: ["t2"], nextPageToken: null });
    const onProgress = vi.fn();

    await runBackfill(job, { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[1]?.[0]).toMatchObject({ threadsProcessed: 2 });
  });

  it("records how far back it has reached", async () => {
    listThreadIds.mockResolvedValue({ items: ["t1"], nextPageToken: null });

    await runBackfill(job);

    const backfilled = writes.find((write) => write.field === "backfilledUntil");
    expect(backfilled?.value).toEqual(THREAD.messages[0]?.sentAt);
  });

  it("refuses to run for a revoked mailbox", async () => {
    findFirst.mockResolvedValue({ ...MAILBOX, syncStatus: "REVOKED" });

    await expect(runBackfill(job)).rejects.toThrow(ConflictError);
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("skips a thread that came back with no messages", async () => {
    listThreadIds.mockResolvedValue({ items: ["t1"], nextPageToken: null });
    getThread.mockResolvedValue({ providerThreadId: "t1", historyId: null, messages: [] });

    const progress = await runBackfill(job);

    expect(progress.threadsProcessed).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("runBackfill resumption", () => {
  beforeEach(() => {
    writes.length = 0;
    updateGroups.length = 0;
    update.mockReset().mockResolvedValue({});
    getProfile.mockReset().mockResolvedValue({
      emailAddress: "person@example.com",
      providerAccountId: "person@example.com",
      historyId: "555000",
    });
    listThreadIds.mockReset().mockResolvedValue({ items: [], nextPageToken: null });
    getThread.mockReset().mockResolvedValue(THREAD);
    threadUpsert.mockReset().mockResolvedValue({ id: "thread-row-1" });
    messageUpsert.mockReset().mockResolvedValue({ id: "message-row-1" });
    attachmentDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    attachmentCreateMany.mockReset().mockResolvedValue({ count: 0 });
    stubTransaction();
  });

  const job = { userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID, windowDays: 90 };

  it("checkpoints the history pointer and next page token when starting fresh", async () => {
    findFirst.mockResolvedValue(MAILBOX);
    listThreadIds
      .mockResolvedValueOnce({ items: ["t1"], nextPageToken: "page-2" })
      .mockResolvedValueOnce({ items: ["t2"], nextPageToken: null });

    await runBackfill(job);

    const cursorCheckpoint = writes.find((w) => w.field === "backfillCursor");
    expect(cursorCheckpoint?.value).toBe("555000");
    // The token stored after page one is the token for page two.
    const tokens = writes.filter((w) => w.field === "backfillPageToken").map((w) => w.value);
    expect(tokens).toContain("page-2");
  });

  it("resumes from the checkpoint without calling getProfile again", async () => {
    // The whole point: a run that already wrote 50 threads must not start over.
    findFirst.mockResolvedValue({
      ...MAILBOX,
      syncStatus: "ERROR",
      backfillCursor: "555000",
      backfillPageToken: "page-7",
    });

    await runBackfill(job);

    expect(getProfile).not.toHaveBeenCalled();
    expect(listThreadIds).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "page-7" }),
    );
  });

  it("reuses the ORIGINAL history pointer on resume, not a fresh one", async () => {
    // A fresh pointer would skip everything that arrived during the failed attempt.
    findFirst.mockResolvedValue({
      ...MAILBOX,
      backfillCursor: "111000",
      backfillPageToken: "page-3",
    });
    getProfile.mockResolvedValue({
      emailAddress: "person@example.com",
      providerAccountId: "person@example.com",
      historyId: "999999",
    });

    await runBackfill(job);

    const cursorWrite = writes.find((w) => w.field === "syncCursor");
    expect(cursorWrite?.value).toBe("111000");
  });

  it("clears the checkpoint once the backfill completes", async () => {
    findFirst.mockResolvedValue({
      ...MAILBOX,
      backfillCursor: "555000",
      backfillPageToken: "page-9",
    });

    await runBackfill(job);

    const finalTokenWrite = [...writes].reverse().find((w) => w.field === "backfillPageToken");
    const finalCursorWrite = [...writes].reverse().find((w) => w.field === "backfillCursor");
    expect(finalTokenWrite?.value).toBeNull();
    expect(finalCursorWrite?.value).toBeNull();
  });

  it("keeps the checkpoint when a page fails, so the retry resumes", async () => {
    findFirst.mockResolvedValue(MAILBOX);
    listThreadIds
      .mockResolvedValueOnce({ items: ["t1"], nextPageToken: "page-2" })
      .mockRejectedValueOnce(new Error("rate limited"));

    await expect(runBackfill(job)).rejects.toThrow("rate limited");

    // The last checkpoint written is page two — retained, not cleared, so the retry
    // starts there instead of re-reading page one.
    const tokenWrites = writes.filter((w) => w.field === "backfillPageToken");
    expect(tokenWrites.at(-1)?.value).toBe("page-2");
    expect(updateGroups.some((data) => data["backfillCursor"] === null)).toBe(false);
    expect(statusWrites()).toEqual(["BACKFILLING", "ERROR"]);
  });
});

describe("runBackfill cancellation", () => {
  beforeEach(() => {
    writes.length = 0;
    updateGroups.length = 0;
    findFirst.mockReset().mockResolvedValue(MAILBOX);
    update.mockReset().mockResolvedValue({});
    getProfile.mockReset().mockResolvedValue({
      emailAddress: "person@example.com",
      providerAccountId: "person@example.com",
      historyId: "555000",
    });
    getThread.mockReset().mockResolvedValue(THREAD);
    listThreadIds.mockReset();
    threadUpsert.mockReset().mockResolvedValue({ id: "thread-row-1" });
    messageUpsert.mockReset().mockResolvedValue({ id: "message-row-1" });
    attachmentDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    attachmentCreateMany.mockReset().mockResolvedValue({ count: 0 });
    providerContexts.length = 0;
    stubTransaction();
  });

  const job = { userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID, windowDays: 90 };

  it("stops paging when the signal aborts", async () => {
    const controller = new AbortController();
    listThreadIds.mockImplementation(async () => {
      controller.abort();
      return { items: [], nextPageToken: "next-page" };
    });

    await expect(runBackfill(job, { signal: controller.signal })).rejects.toThrow(
      /cancelled|aborted/i,
    );
    // One page attempted, then it stops rather than continuing beside the retry.
    expect(listThreadIds).toHaveBeenCalledTimes(1);
  });

  it("does not start at all if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    listThreadIds.mockResolvedValue({ items: [], nextPageToken: null });

    await expect(runBackfill(job, { signal: controller.signal })).rejects.toThrow();
    expect(listThreadIds).not.toHaveBeenCalled();
  });

  it("leaves a cancelled mailbox PENDING, not ERROR", async () => {
    // Cancellation is not a failure of the mailbox: the retry is already scheduled.
    const controller = new AbortController();
    controller.abort();
    listThreadIds.mockResolvedValue({ items: [], nextPageToken: null });

    await expect(runBackfill(job, { signal: controller.signal })).rejects.toThrow();

    expect(statusWrites()).toEqual(["BACKFILLING", "PENDING"]);
    expect(writes.some((w) => w.field === "syncError" && w.value !== null)).toBe(false);
  });

  it("passes the signal to the provider it creates", async () => {
    const controller = new AbortController();
    listThreadIds.mockResolvedValue({ items: [], nextPageToken: null });

    await runBackfill(job, { signal: controller.signal });

    expect(providerContexts.at(-1)?.signal).toBe(controller.signal);
  });
});

describe("persistThread", () => {
  beforeEach(() => {
    threadUpsert.mockReset().mockResolvedValue({ id: "thread-row-1" });
    messageUpsert.mockReset().mockResolvedValue({ id: "message-row-1" });
    attachmentDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    attachmentCreateMany.mockReset().mockResolvedValue({ count: 0 });
    stubTransaction();
  });

  async function persist() {
    const { dbForUser } = await import("@inbox-copilot/db");
    return persistThread(dbForUser(USER_ID), MAIL_ACCOUNT_ID, THREAD);
  }

  it("upserts the thread on (mailAccountId, providerThreadId)", async () => {
    await persist();

    expect(threadUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          mailAccountId_providerThreadId: {
            mailAccountId: MAIL_ACCOUNT_ID,
            providerThreadId: "18f0a1b2c3d4e5f0",
          },
        },
      }),
    );
  });

  it("upserts each message on (mailAccountId, providerMessageId)", async () => {
    const written = await persist();

    // The ids, not a count: the caller queues enrichment for exactly these rows.
    expect(written).toEqual(["message-row-1", "message-row-1"]);
    expect(messageUpsert).toHaveBeenCalledTimes(2);
    expect(messageUpsert.mock.calls[0]?.[0]).toMatchObject({
      where: {
        mailAccountId_providerMessageId: {
          mailAccountId: MAIL_ACCOUNT_ID,
          providerMessageId: "18f0a1b2c3d4e5f6",
        },
      },
    });
  });

  it("sets messageCount, firstMessageAt and lastMessageAt from the thread", async () => {
    await persist();

    const args = threadUpsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(args.update["messageCount"]).toBe(2);
    expect(args.update["firstMessageAt"]).toEqual(THREAD.messages[0]?.sentAt);
    expect(args.update["lastMessageAt"]).toEqual(THREAD.messages[1]?.sentAt);
  });

  it("marks the thread unread when any message is unread", async () => {
    await persist();

    const args = threadUpsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(args.update["isRead"]).toBe(false);
    expect(args.update["isArchived"]).toBe(false);
  });

  it("replaces attachment rows rather than duplicating them on replay", async () => {
    await persist();

    // Idempotency: the same thread written twice must not grow its attachments.
    expect(attachmentDeleteMany).toHaveBeenCalledWith({ where: { messageId: "message-row-1" } });
    const created = attachmentCreateMany.mock.calls[0]?.[0] as { data: unknown[] };
    expect(created.data).toHaveLength(2);
  });

  it("writes the content hash and auth results onto the message", async () => {
    await persist();

    const args = messageUpsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(args.update["contentHash"]).toBe(THREAD.messages[0]?.contentHash);
    expect(args.update["authResults"]).toMatchObject({ spf: "pass", dmarc: "pass" });
  });
});

describe("riskFlagFor", () => {
  it("flags executables, macro documents and archives by extension", () => {
    // Extension, not MIME type: the sender controls the MIME type.
    expect(riskFlagFor("update.exe", "application/octet-stream")).toBe("executable");
    expect(riskFlagFor("invoice.docm", "application/msword")).toBe("macro");
    expect(riskFlagFor("bundle.zip", "application/zip")).toBe("archive");
    expect(riskFlagFor("report.pdf", "application/pdf")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(riskFlagFor("UPDATE.EXE", "text/plain")).toBe("executable");
  });
});

describe("getSyncStatus", () => {
  beforeEach(() => {
    findFirst.mockReset().mockResolvedValue({
      id: MAIL_ACCOUNT_ID,
      syncStatus: "ACTIVE",
      syncError: null,
      syncCursor: "555000",
      lastSyncedAt: new Date("2025-03-05T10:00:00Z"),
      backfilledUntil: new Date("2024-12-05T10:00:00Z"),
    });
    threadCount.mockReset().mockResolvedValue(12);
    messageCount.mockReset().mockResolvedValue(48);
    getJob.mockReset().mockResolvedValue(null);
  });

  it("reports counts and cursor state", async () => {
    const status = await getSyncStatus({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });

    expect(status).toMatchObject({
      syncStatus: "ACTIVE",
      hasCursor: true,
      threadCount: 12,
      messageCount: 48,
      job: null,
    });
  });

  it("includes the job snapshot with progress when one exists", async () => {
    getJob.mockResolvedValue({
      getState: async () => "active",
      progress: { threadsProcessed: 7, messagesWritten: 20, pagesRead: 1 },
      attemptsMade: 1,
      failedReason: null,
    });

    const status = await getSyncStatus({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });

    expect(status.job).toEqual({
      state: "active",
      threadsProcessed: 7,
      attemptsMade: 1,
      failedReason: null,
    });
  });

  it("truncates a long failure reason", async () => {
    getJob.mockResolvedValue({
      getState: async () => "failed",
      progress: 0,
      attemptsMade: 5,
      failedReason: "y".repeat(900),
    });

    const status = await getSyncStatus({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID });
    expect(status.job?.failedReason?.length).toBe(300);
  });

  it("404s for a mailbox that is not the caller's", async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      getSyncStatus({ userId: USER_ID, mailAccountId: MAIL_ACCOUNT_ID }),
    ).rejects.toThrow(NotFoundError);
  });
});
