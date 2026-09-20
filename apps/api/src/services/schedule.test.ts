import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scheduled send (§9), with Prisma, BullMQ and the provider stubbed.
 *
 * What is pinned here is the property the whole design exists for: **the row is the
 * truth and the job is only a trigger.** So the interesting tests are the ones where
 * the queue and the database disagree —
 *
 *   - Redis lost the job, and the sweeper recovers the send from the row alone;
 *   - the job survived a cancellation, and finds a row that says no;
 *   - two triggers arrive for one row, and exactly one send happens;
 *   - the send fails, and nothing tries again.
 *
 * Plus the §9 timezone property end to end: a row whose zone rules moved since it was
 * written is corrected and re-queued rather than sent an hour early.
 */

const scheduledFindFirst = vi.hoisted(() => vi.fn());
const scheduledFindFirstOrThrow = vi.hoisted(() => vi.fn());
const scheduledFindMany = vi.hoisted(() => vi.fn());
const scheduledCreate = vi.hoisted(() => vi.fn());
const scheduledUpdate = vi.hoisted(() => vi.fn());
const scheduledUpdateMany = vi.hoisted(() => vi.fn());
const threadFindFirst = vi.hoisted(() => vi.fn());
const messageFindFirst = vi.hoisted(() => vi.fn());
const mailAccountFindFirst = vi.hoisted(() => vi.fn());
/** The base client, for the cross-tenant sweeper query only. */
const rawScheduledFindMany = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => {
  const client = {
    scheduledEmail: {
      findFirst: scheduledFindFirst,
      findFirstOrThrow: scheduledFindFirstOrThrow,
      findMany: scheduledFindMany,
      create: scheduledCreate,
      update: scheduledUpdate,
      updateMany: scheduledUpdateMany,
    },
    thread: { findFirst: threadFindFirst },
    message: { findFirst: messageFindFirst },
    mailAccount: { findFirst: mailAccountFindFirst },
  };

  return {
    dbForUser: () => client,
    prisma: { scheduledEmail: { findMany: rawScheduledFindMany } },
    Prisma: {},
  };
});

/** The BullMQ surface `enqueueScheduledSend` touches. */
const queueAdd = vi.hoisted(() => vi.fn());
const queueGetJob = vi.hoisted(() => vi.fn());
const jobRemove = vi.hoisted(() => vi.fn());

vi.mock("../lib/queues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/queues.js")>();
  return {
    ...actual,
    scheduleSendQueue: () => ({ add: queueAdd, getJob: queueGetJob }),
  };
});

const sendMessage = vi.hoisted(() => vi.fn());

vi.mock("../providers/registry.js", () => ({
  mailProviderFor: () => ({ sendMessage }),
}));

const createFollowUpReminder = vi.hoisted(() => vi.fn());

vi.mock("./followUps.js", () => ({ createFollowUpReminder }));

const {
  cancelScheduledEmail,
  listScheduledEmails,
  runScheduledSend,
  scheduleNewMessage,
  scheduleReply,
  sweepDueScheduledEmails,
  SWEEP_LEAD_MS,
} = await import("./schedule.js");
const { BadRequestError, ConflictError, NotFoundError } =
  await import("../lib/errors.js");

const USER_ID = "user_1";
const SCHEDULED_ID = "cldd4kzai000108l3a1b2c3d4";
const THREAD_ID = "cldd4kzai000208l3a1b2c3d4";
const MAIL_ACCOUNT_ID = "cldd4kzai000308l3a1b2c3d4";
const PARENT_ID = "cldd4kzai000408l3a1b2c3d4";

/** "Now" for every test: a fixed instant, well clear of any DST boundary. */
const NOW = new Date("2026-09-16T08:00:00Z");

function scheduledRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULED_ID,
    threadId: THREAD_ID,
    to: ["Dana <dana@northwind.example>"],
    cc: [],
    subject: "Re: Invoice 4471",
    bodyText: "Sending the revised invoice today.",
    sendAt: new Date("2026-09-17T08:00:00Z"),
    localSendAt: "2026-09-17T09:00",
    timezone: "Africa/Tunis",
    status: "SCHEDULED",
    expectsReply: false,
    attempts: 0,
    lastError: null,
    sentAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** The wider row shape `runScheduledSend` selects. */
function sendableRow(overrides: Record<string, unknown> = {}) {
  return {
    ...scheduledRow(),
    mailAccountId: MAIL_ACCOUNT_ID,
    parentMessageId: PARENT_ID,
    bcc: [],
    bodyHtml: "<div>Sending the revised invoice today.</div>",
    mailAccount: { provider: "GMAIL", emailAddress: "owner@example.com" },
    ...overrides,
  };
}

function threadRow() {
  return {
    id: THREAD_ID,
    providerThreadId: "gmail_thread_1",
    mailAccountId: MAIL_ACCOUNT_ID,
    mailAccount: { emailAddress: "owner@example.com" },
    messages: [
      {
        id: PARENT_ID,
        subject: "Invoice 4471",
        fromName: "Dana",
        fromEmail: "dana@northwind.example",
        to: ["owner@example.com"],
        replyTo: null,
        isOutbound: false,
      },
    ],
  };
}

beforeEach(() => {
  scheduledFindFirst.mockReset();
  scheduledFindFirstOrThrow.mockReset().mockResolvedValue(scheduledRow());
  scheduledFindMany.mockReset().mockResolvedValue([]);
  scheduledCreate.mockReset().mockResolvedValue(scheduledRow());
  scheduledUpdate.mockReset().mockResolvedValue({});
  scheduledUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  threadFindFirst.mockReset().mockResolvedValue(threadRow());
  messageFindFirst.mockReset().mockResolvedValue({
    internetMessageId: "<parent@northwind.example>",
    headers: { references: "<older@northwind.example>" },
  });
  mailAccountFindFirst.mockReset().mockResolvedValue({
    id: MAIL_ACCOUNT_ID,
    emailAddress: "owner@example.com",
    syncStatus: "ACTIVE",
  });
  rawScheduledFindMany.mockReset().mockResolvedValue([]);
  queueAdd.mockReset().mockResolvedValue({ id: "schedsend-x" });
  queueGetJob.mockReset().mockResolvedValue(undefined);
  jobRemove.mockReset().mockResolvedValue(undefined);
  sendMessage.mockReset().mockResolvedValue({
    providerMessageId: "sent_1",
    providerThreadId: "gmail_thread_1",
  });
  createFollowUpReminder
    .mockReset()
    .mockResolvedValue({ id: "cldd4kzai000508l3a1b2c3d4" });
});

describe("scheduling a reply", () => {
  it("stores the wall clock and the zone, not just the resolved instant", async () => {
    await scheduleReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "Sending the revised invoice today.",
      sendAtLocal: "2026-09-17T09:00",
      timezone: "Africa/Tunis",
      now: NOW,
    });

    const data = scheduledCreate.mock.calls[0]?.[0].data;
    // All three, and the pair is what makes a DST change recoverable: `sendAt` is a
    // derivation, and without the other two there would be nothing to re-derive it from.
    expect(data.localSendAt).toBe("2026-09-17T09:00");
    expect(data.timezone).toBe("Africa/Tunis");
    expect(data.sendAt.toISOString()).toBe("2026-09-17T08:00:00.000Z");
  });

  it("freezes the recipient computed from the parent, so nothing can be added later", async () => {
    await scheduleReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      sendAtLocal: "2026-09-17T09:00",
      timezone: "Africa/Tunis",
      now: NOW,
    });

    // The same `replyRecipients` the immediate send uses, resolved now and written to
    // the row. A message that lands in the thread before the send cannot redirect it.
    expect(scheduledCreate.mock.calls[0]?.[0].data.to).toEqual([
      "Dana <dana@northwind.example>",
    ]);
  });

  it("queues a delayed trigger, and only after the row exists", async () => {
    await scheduleReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      sendAtLocal: "2026-09-17T09:00",
      timezone: "Africa/Tunis",
      now: NOW,
    });

    expect(scheduledCreate).toHaveBeenCalled();
    const [name, payload, options] = queueAdd.mock.calls[0] ?? [];
    expect(name).toBe("send");
    // An id, and nothing else. The body is not in the job, so the job cannot disagree
    // with the row about what goes out or whether it should.
    expect(payload).toEqual({ scheduledEmailId: SCHEDULED_ID, userId: USER_ID });
    expect(options.delay).toBe(
      new Date("2026-09-17T08:00:00Z").getTime() - NOW.getTime(),
    );
  });

  it("still reports success when the queue is unreachable", async () => {
    /*
     * Rule 8's shape: the durable write goes first and the queue is allowed to fail.
     * The row is scheduled, the sweeper will find it within the minute, and the user is
     * not told their send failed when it did not.
     */
    queueAdd.mockRejectedValue(new Error("redis is down"));

    const result = await scheduleReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      sendAtLocal: "2026-09-17T09:00",
      timezone: "Africa/Tunis",
      now: NOW,
    });

    expect(result.status).toBe("SCHEDULED");
  });

  it("refuses a time that has already passed", async () => {
    await expect(
      scheduleReply({
        userId: USER_ID,
        threadId: THREAD_ID,
        body: "ok",
        sendAtLocal: "2020-01-01T09:00",
        timezone: "Africa/Tunis",
        now: NOW,
      }),
    ).rejects.toThrow(BadRequestError);
    expect(scheduledCreate).not.toHaveBeenCalled();
  });

  it("refuses an offset where a zone is required", async () => {
    // The §9 rule, enforced at the boundary: an offset cannot reach the column.
    await expect(
      scheduleReply({
        userId: USER_ID,
        threadId: THREAD_ID,
        body: "ok",
        sendAtLocal: "2026-09-17T09:00",
        timezone: "+01:00",
        now: NOW,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it("refuses a thread that is not this user's", async () => {
    // The tenancy read is the ownership check: somebody else's thread does not exist.
    threadFindFirst.mockResolvedValue(null);

    await expect(
      scheduleReply({
        userId: USER_ID,
        threadId: THREAD_ID,
        body: "ok",
        sendAtLocal: "2026-09-17T09:00",
        timezone: "Africa/Tunis",
        now: NOW,
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("scheduling a new message", () => {
  it("refuses a revoked mailbox rather than queueing a send that cannot happen", async () => {
    mailAccountFindFirst.mockResolvedValue({
      id: MAIL_ACCOUNT_ID,
      emailAddress: "owner@example.com",
      syncStatus: "REVOKED",
    });

    await expect(
      scheduleNewMessage({
        userId: USER_ID,
        mailAccountId: MAIL_ACCOUNT_ID,
        to: ["dana@northwind.example"],
        subject: "Quote",
        body: "Here it is.",
        sendAtLocal: "2026-09-17T09:00",
        timezone: "Africa/Tunis",
        now: NOW,
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("the sweeper", () => {
  it("recovers a send whose job Redis lost", async () => {
    /*
     * The case §9 asks for by name, and the reason the row is the source of truth.
     *
     * Nothing is in the queue — `getJob` finds nothing, because the delayed job was
     * evicted, flushed, or written while the worker was down. The row alone is enough:
     * one indexed query on `(status, sendAt)` finds it overdue and re-queues the
     * trigger. Without this the user's 9am mail would simply never go out, with no
     * error anywhere to say so.
     */
    rawScheduledFindMany.mockResolvedValue([
      { id: SCHEDULED_ID, userId: USER_ID, sendAt: new Date("2026-09-16T07:59:00Z") },
    ]);

    const result = await sweepDueScheduledEmails({ now: NOW });

    expect(result).toEqual({ found: 1, queued: 1 });
    expect(queueAdd).toHaveBeenCalledWith(
      "send",
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      // Already overdue, so no delay: run it now.
      expect.objectContaining({ delay: 0, jobId: `schedsend-${SCHEDULED_ID}` }),
    );
  });

  it("asks only for SCHEDULED rows, and only for ones that are due", async () => {
    await sweepDueScheduledEmails({ now: NOW });

    const where = rawScheduledFindMany.mock.calls[0]?.[0].where;
    /*
     * SENDING is deliberately absent. A row stuck in SENDING is the unknown-outcome
     * case — the provider may have accepted the message before we lost contact — and
     * re-enqueueing it would be exactly the automatic retry phase 6 refuses.
     */
    expect(where.status).toBe("SCHEDULED");
    expect(where.sendAt.lte.getTime()).toBe(NOW.getTime() + SWEEP_LEAD_MS);
  });

  it("does not double up on a job that is still waiting", async () => {
    // The row is due and a delayed job for it is still in Redis. The sweeper must not
    // add a second trigger.
    rawScheduledFindMany.mockResolvedValue([
      { id: SCHEDULED_ID, userId: USER_ID, sendAt: new Date("2026-09-16T07:59:00Z") },
    ]);
    queueGetJob.mockResolvedValue({
      getState: async () => "delayed",
      remove: jobRemove,
    });

    const result = await sweepDueScheduledEmails({ now: NOW });

    expect(result).toEqual({ found: 1, queued: 0 });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("clears a finished job of the same id so a re-queue is not silently refused", async () => {
    /*
     * BullMQ keeps completed jobs and refuses to re-add an id it still holds. A row
     * whose first trigger completed without claiming it (lost the race, then the winner
     * died) would otherwise be unrecoverable — the sweeper would "queue" it every
     * minute and nothing would run.
     */
    rawScheduledFindMany.mockResolvedValue([
      { id: SCHEDULED_ID, userId: USER_ID, sendAt: new Date("2026-09-16T07:59:00Z") },
    ]);
    queueGetJob.mockResolvedValue({
      getState: async () => "completed",
      remove: jobRemove,
    });

    await sweepDueScheduledEmails({ now: NOW });

    expect(jobRemove).toHaveBeenCalled();
    expect(queueAdd).toHaveBeenCalled();
  });
});

describe("running a scheduled send", () => {
  it("claims the row, sends once, and records the provider id", async () => {
    scheduledFindFirst.mockResolvedValue(sendableRow());

    const result = await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T08:00:00Z") },
    );

    expect(result.status).toBe("sent");
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // The claim is conditional on the row still being SCHEDULED: that predicate is the
    // whole idempotency mechanism.
    const claim = scheduledUpdateMany.mock.calls.find(
      (call) => call[0]?.data?.status === "SENDING",
    );
    expect(claim?.[0].where).toEqual({ id: SCHEDULED_ID, status: "SCHEDULED" });

    expect(scheduledUpdate.mock.calls[0]?.[0].data).toMatchObject({
      status: "SENT",
      providerMessageId: "sent_1",
      lastError: null,
    });
  });

  it("threads the reply on the parent's Message-ID and chain", async () => {
    scheduledFindFirst.mockResolvedValue(sendableRow());

    await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T08:00:00Z") },
    );

    expect(sendMessage.mock.calls[0]?.[0].inReplyTo).toEqual({
      providerThreadId: "gmail_thread_1",
      internetMessageId: "<parent@northwind.example>",
      // The parent's own chain, then the parent — the same shape `services/send.ts`
      // produces, so a scheduled reply threads exactly like an immediate one.
      references: ["<older@northwind.example>", "<parent@northwind.example>"],
    });
  });

  it("does nothing when the user cancelled it after the job was queued", async () => {
    /*
     * The job survived the cancellation, which is the normal case: cancelling removes
     * the BullMQ job on a best-effort basis only. The row says CANCELLED, so the
     * trigger reads it and stops. This is why the job payload is an id.
     */
    scheduledFindFirst.mockResolvedValue(sendableRow({ status: "CANCELLED" }));

    const result = await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T08:00:00Z") },
    );

    expect(result).toEqual({ status: "skipped", reason: "cancelled" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends nothing when another trigger claimed the row first", async () => {
    // The sweeper and a surviving delayed job arriving together: the loser's
    // conditional update matches zero rows, and it stops rather than sending a second
    // copy of the user's mail.
    scheduledFindFirst.mockResolvedValue(sendableRow());
    scheduledUpdateMany.mockResolvedValue({ count: 0 });

    const result = await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T08:00:00Z") },
    );

    expect(result).toEqual({ status: "skipped", reason: "claimed-elsewhere" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("records a failure and does not retry it", async () => {
    /*
     * The phase-6 rule, unchanged: a send whose outcome is unknown is not retried. A
     * 502 may have arrived after the provider accepted the message, so a second attempt
     * could deliver twice — and mail delivered twice is not recoverable, while a row
     * that says "we do not know" is.
     *
     * The function *returns* rather than throwing, so BullMQ records a completed job
     * and never re-runs it. The status is FAILED, which the sweeper does not look at.
     */
    scheduledFindFirst.mockResolvedValue(sendableRow());
    sendMessage.mockRejectedValue(new Error("502 Bad Gateway"));

    const result = await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T08:00:00Z") },
    );

    expect(result.status).toBe("failed");
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const failure = scheduledUpdateMany.mock.calls.find(
      (call) => call[0]?.data?.status === "FAILED",
    );
    expect(failure?.[0].data.lastError).toContain("502");
  });

  it("corrects the instant and re-queues when the zone's rules moved", async () => {
    /*
     * The DST property, end to end (§9).
     *
     * The row was written when someone believed 9am Tunis was 08:00Z. Suppose the rules
     * changed and 9am is now 07:00Z — modelled here by a stale `sendAt` an hour behind
     * what the wall clock actually resolves to. The trigger fires early, notices that
     * the *wall time the user chose* has not arrived, corrects `sendAt`, re-queues, and
     * sends nothing.
     *
     * Without `localSendAt` there would be nothing to re-derive from, and the mail would
     * go out an hour early with nothing anywhere recording that it was wrong.
     */
    scheduledFindFirst.mockResolvedValue(
      sendableRow({
        localSendAt: "2026-09-17T09:00",
        timezone: "Africa/Tunis",
        sendAt: new Date("2026-09-17T07:00:00Z"),
      }),
    );

    const result = await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T07:00:00Z") },
    );

    expect(result).toEqual({ status: "rescheduled", reason: "timezone-rules-changed" });
    expect(sendMessage).not.toHaveBeenCalled();

    // The row is corrected to the instant the wall clock actually resolves to, and the
    // trigger is queued again for then.
    const correction = scheduledUpdateMany.mock.calls.find(
      (call) => call[0]?.data?.sendAt !== undefined,
    );
    expect(correction?.[0].data.sendAt.toISOString()).toBe("2026-09-17T08:00:00.000Z");
    expect(queueAdd).toHaveBeenCalled();
  });

  it("creates the follow-up reminder only after the send succeeded", async () => {
    scheduledFindFirst.mockResolvedValue(sendableRow({ expectsReply: true }));

    const result = await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T08:00:00Z") },
    );

    expect(result.status).toBe("sent");
    expect(createFollowUpReminder).toHaveBeenCalledWith({
      userId: USER_ID,
      threadId: THREAD_ID,
      // The provider's id: the sent message has no `Message` row until the next sync.
      watchedMessageId: "sent_1",
      reason: "Re: Invoice 4471",
    });
  });

  it("creates no reminder when the send failed", async () => {
    // A reminder to chase a reply to mail that never went out is worse than none.
    scheduledFindFirst.mockResolvedValue(sendableRow({ expectsReply: true }));
    sendMessage.mockRejectedValue(new Error("nope"));

    await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T08:00:00Z") },
    );

    expect(createFollowUpReminder).not.toHaveBeenCalled();
  });

  it("still reports the send as sent when the reminder write fails", async () => {
    // Bookkeeping after the mail has gone must never be able to report failure for a
    // successful send.
    scheduledFindFirst.mockResolvedValue(sendableRow({ expectsReply: true }));
    createFollowUpReminder.mockRejectedValue(new Error("db blip"));

    const result = await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: new Date("2026-09-17T08:00:00Z") },
    );

    expect(result.status).toBe("sent");
    expect(result.reminderId).toBeNull();
  });

  it("skips a row whose mailbox has been disconnected", async () => {
    // The cascade takes queued sends with the mailbox. Not an error.
    scheduledFindFirst.mockResolvedValue(null);

    const result = await runScheduledSend(
      { scheduledEmailId: SCHEDULED_ID, userId: USER_ID },
      { now: NOW },
    );

    expect(result).toEqual({ status: "skipped", reason: "missing" });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("cancelling", () => {
  it("moves the row to CANCELLED and removes the trigger", async () => {
    scheduledFindFirst.mockResolvedValue({ id: SCHEDULED_ID, status: "SCHEDULED" });
    scheduledFindFirstOrThrow.mockResolvedValue(scheduledRow({ status: "CANCELLED" }));
    queueGetJob.mockResolvedValue({ getState: async () => "delayed", remove: jobRemove });

    const result = await cancelScheduledEmail({
      userId: USER_ID,
      scheduledId: SCHEDULED_ID,
    });

    expect(result.status).toBe("CANCELLED");
    expect(scheduledUpdateMany.mock.calls[0]?.[0]).toEqual({
      // Conditional, so a send that started between the read and the write wins.
      where: { id: SCHEDULED_ID, status: "SCHEDULED" },
      data: { status: "CANCELLED" },
    });
    expect(jobRemove).toHaveBeenCalled();
  });

  it("refuses to cancel a send that is already going out", async () => {
    // "Cancelled" about mail on its way to Gmail would be a lie.
    scheduledFindFirst.mockResolvedValue({ id: SCHEDULED_ID, status: "SENDING" });

    await expect(
      cancelScheduledEmail({ userId: USER_ID, scheduledId: SCHEDULED_ID }),
    ).rejects.toThrow(ConflictError);
  });

  it("still cancels when the queue job cannot be removed", async () => {
    // The row is what decides. A job that survives finds a CANCELLED row and stops.
    scheduledFindFirst.mockResolvedValue({ id: SCHEDULED_ID, status: "SCHEDULED" });
    scheduledFindFirstOrThrow.mockResolvedValue(scheduledRow({ status: "CANCELLED" }));
    queueGetJob.mockRejectedValue(new Error("redis is down"));

    const result = await cancelScheduledEmail({
      userId: USER_ID,
      scheduledId: SCHEDULED_ID,
    });
    expect(result.status).toBe("CANCELLED");
  });

  it("refuses a row that is not this user's", async () => {
    scheduledFindFirst.mockResolvedValue(null);
    await expect(
      cancelScheduledEmail({ userId: USER_ID, scheduledId: SCHEDULED_ID }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("listing", () => {
  it("includes failures by default, because nothing else will tell the user", async () => {
    await listScheduledEmails({ userId: USER_ID });

    expect(scheduledFindMany.mock.calls[0]?.[0].where).toEqual({
      status: { in: ["SCHEDULED", "SENDING", "FAILED"] },
    });
  });

  it("returns the wall clock the user picked, not only the instant", async () => {
    scheduledFindMany.mockResolvedValue([scheduledRow()]);

    const [item] = await listScheduledEmails({ userId: USER_ID });

    expect(item?.sendAtLocal).toBe("2026-09-17T09:00");
    expect(item?.timezone).toBe("Africa/Tunis");
  });
});
