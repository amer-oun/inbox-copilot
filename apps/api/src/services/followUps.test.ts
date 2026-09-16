import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Follow-up reminders (§9), with Prisma stubbed.
 *
 * The behaviour worth pinning is the *cancellation*, not the creation. A reminder
 * system's failure mode is not missing a reminder, it is nagging — one reminder to
 * chase somebody who replied an hour ago teaches the user to ignore the list for ever.
 * So the tests here are mostly about reminders disappearing: on any inbound message,
 * before anything is triggered, and without waiting for the due date to matter.
 */

const reminderFindFirst = vi.hoisted(() => vi.fn());
const reminderFindFirstOrThrow = vi.hoisted(() => vi.fn());
const reminderFindMany = vi.hoisted(() => vi.fn());
const reminderCreate = vi.hoisted(() => vi.fn());
const reminderUpdateMany = vi.hoisted(() => vi.fn());
const messageFindFirst = vi.hoisted(() => vi.fn());
const messageFindMany = vi.hoisted(() => vi.fn());
const settingsFindFirst = vi.hoisted(() => vi.fn());
/** The base client: the cross-tenant scan for open reminders. */
const rawReminderFindMany = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => {
  const client = {
    followUpReminder: {
      findFirst: reminderFindFirst,
      findFirstOrThrow: reminderFindFirstOrThrow,
      findMany: reminderFindMany,
      create: reminderCreate,
      updateMany: reminderUpdateMany,
    },
    message: { findFirst: messageFindFirst, findMany: messageFindMany },
    userSettings: { findFirst: settingsFindFirst },
  };

  return {
    dbForUser: () => client,
    prisma: { followUpReminder: { findMany: rawReminderFindMany } },
    Prisma: {},
  };
});

const sendFollowUpDigest = vi.hoisted(() => vi.fn());

vi.mock("./digest.js", () => ({ sendFollowUpDigest }));

const {
  createFollowUpReminder,
  dismissReminder,
  listDueReminders,
  runFollowUpCheck,
  snoozeReminder,
  DEFAULT_FOLLOW_UP_DAYS,
} = await import("./followUps.js");
const { NotFoundError } = await import("../lib/errors.js");

const USER_ID = "user_1";
const THREAD_ID = "cldd4kzai000108l3a1b2c3d4";
const REMINDER_ID = "cldd4kzai000208l3a1b2c3d4";

const NOW = new Date("2026-09-16T08:00:00Z");

function reminderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REMINDER_ID,
    threadId: THREAD_ID,
    reason: "Re: Invoice 4471",
    dueAt: new Date("2026-09-15T08:00:00Z"),
    snoozedUntil: null,
    status: "TRIGGERED",
    createdAt: new Date("2026-09-12T08:00:00Z"),
    thread: { subject: "Invoice 4471" },
    ...overrides,
  };
}

/** The narrow shape the cross-tenant scan selects. */
function openRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REMINDER_ID,
    userId: USER_ID,
    threadId: THREAD_ID,
    dueAt: new Date("2026-09-15T08:00:00Z"),
    status: "PENDING",
    createdAt: new Date("2026-09-12T08:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  reminderFindFirst.mockReset().mockResolvedValue(null);
  reminderFindFirstOrThrow.mockReset().mockResolvedValue(reminderRow());
  reminderFindMany.mockReset().mockResolvedValue([]);
  reminderCreate
    .mockReset()
    .mockResolvedValue({ id: REMINDER_ID, dueAt: new Date("2026-09-19T08:00:00Z") });
  reminderUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  messageFindFirst.mockReset().mockResolvedValue(null);
  messageFindMany.mockReset().mockResolvedValue([]);
  settingsFindFirst.mockReset().mockResolvedValue({ followUpDays: 3 });
  rawReminderFindMany.mockReset().mockResolvedValue([]);
  sendFollowUpDigest.mockReset().mockResolvedValue({ sent: false, reason: "opt-out" });
});

describe("creating a reminder", () => {
  it("uses the user's followUpDays to set the due date", async () => {
    settingsFindFirst.mockResolvedValue({ followUpDays: 5 });

    await createFollowUpReminder({
      userId: USER_ID,
      threadId: THREAD_ID,
      watchedMessageId: "sent_1",
      now: NOW,
    });

    expect(reminderCreate.mock.calls[0]?.[0].data.dueAt.toISOString()).toBe(
      "2026-09-21T08:00:00.000Z",
    );
  });

  it("falls back to the schema default when the user has no settings row", async () => {
    settingsFindFirst.mockResolvedValue(null);

    await createFollowUpReminder({
      userId: USER_ID,
      threadId: THREAD_ID,
      watchedMessageId: "sent_1",
      now: NOW,
    });

    const dueAt = reminderCreate.mock.calls[0]?.[0].data.dueAt as Date;
    expect(dueAt.getTime() - NOW.getTime()).toBe(DEFAULT_FOLLOW_UP_DAYS * 24 * 3_600_000);
  });

  it("stores the provider's message id, because ours does not exist yet", async () => {
    /*
     * The reminder is created the instant a send succeeds, and at that instant the sent
     * message has no `Message` row: the sync engine owns that table and the next delta
     * brings the real row. The provider's id is the only identifier that exists, which
     * is why the column is not a foreign key.
     */
    await createFollowUpReminder({
      userId: USER_ID,
      threadId: THREAD_ID,
      watchedMessageId: "gmail_msg_abc",
      now: NOW,
    });

    expect(reminderCreate.mock.calls[0]?.[0].data.watchedMessageId).toBe("gmail_msg_abc");
  });

  it("does not stack a second reminder on a thread that already has one open", async () => {
    /*
     * Sending three messages into a silent thread is one act of chasing somebody.
     * Three reminders would be three rows to dismiss separately, and the *first*
     * unanswered message is the one worth being reminded about — so the existing
     * reminder stands, at its original due date.
     */
    reminderFindFirst.mockResolvedValue({
      id: "cldd4kzai000908l3a1b2c3d4",
      dueAt: new Date("2026-09-14T08:00:00Z"),
    });

    const result = await createFollowUpReminder({
      userId: USER_ID,
      threadId: THREAD_ID,
      watchedMessageId: "sent_2",
      now: NOW,
    });

    expect(result).toBeNull();
    expect(reminderCreate).not.toHaveBeenCalled();
  });
});

describe("the check job", () => {
  it("cancels a reminder when an inbound reply arrives on the thread", async () => {
    /*
     * The case §9 asks for by name.
     *
     * Note how loosely "a reply" is defined: any inbound message on the thread since we
     * started waiting. Not one that threads correctly on our Message-ID, and not one
     * from the original recipient — a colleague answering from another address, an
     * assistant replying for them, or a client that mangles `In-Reply-To` all mean the
     * user has heard back. Being generous here occasionally clears a reminder early;
     * being strict means nagging, and nagging is what kills the feature.
     */
    rawReminderFindMany.mockResolvedValue([openRow()]);
    messageFindFirst.mockResolvedValue({
      id: "cldd4kzai000308l3a1b2c3d4",
      sentAt: new Date("2026-09-13T10:00:00Z"),
    });

    const result = await runFollowUpCheck({ now: NOW });

    expect(result).toMatchObject({ examined: 1, resolved: 1, triggered: 0 });

    const update = reminderUpdateMany.mock.calls[0]?.[0];
    expect(update.data.status).toBe("RESOLVED");
    // Stamped with when the reply was actually sent, not when we noticed.
    expect(update.data.resolvedAt.toISOString()).toBe("2026-09-13T10:00:00.000Z");
  });

  it("looks only for inbound mail, never for the user's own follow-up", async () => {
    // Chasing somebody twice must not clear the reminder to chase them.
    rawReminderFindMany.mockResolvedValue([openRow()]);

    await runFollowUpCheck({ now: NOW });

    expect(messageFindFirst.mock.calls[0]?.[0].where).toMatchObject({
      threadId: THREAD_ID,
      isOutbound: false,
    });
  });

  it("resolves a reminder that came due before the reply, rather than triggering it", async () => {
    /*
     * Resolve before trigger, and this is why the order is not cosmetic: this reminder
     * is past its due date *and* has a reply. Triggering it even for one tick would put
     * it in the digest, which would mail the user about a thread they have already
     * heard back on.
     */
    rawReminderFindMany.mockResolvedValue([
      openRow({ dueAt: new Date("2026-09-15T08:00:00Z"), status: "PENDING" }),
    ]);
    messageFindFirst.mockResolvedValue({
      id: "cldd4kzai000308l3a1b2c3d4",
      sentAt: new Date("2026-09-15T09:00:00Z"),
    });

    const result = await runFollowUpCheck({ now: NOW });

    expect(result.resolved).toBe(1);
    expect(result.triggered).toBe(0);
    expect(sendFollowUpDigest).not.toHaveBeenCalled();
  });

  it("resolves a reminder even after it has already been triggered", async () => {
    // A late reply must still clear it: the reminder is on screen, and leaving it there
    // is the nagging case.
    rawReminderFindMany.mockResolvedValue([openRow({ status: "TRIGGERED" })]);
    messageFindFirst.mockResolvedValue({
      id: "cldd4kzai000308l3a1b2c3d4",
      sentAt: new Date("2026-09-16T07:00:00Z"),
    });

    const result = await runFollowUpCheck({ now: NOW });
    expect(result.resolved).toBe(1);
  });

  it("allows a minute of grace for a reply that crossed with the send", async () => {
    // Gmail's timestamp and ours are not the same clock, and a reply written seconds
    // before our send is still an answer.
    rawReminderFindMany.mockResolvedValue([openRow()]);

    await runFollowUpCheck({ now: NOW });

    const since = messageFindFirst.mock.calls[0]?.[0].where.sentAt.gte as Date;
    expect(since.getTime()).toBe(openRow().createdAt.getTime() - 60_000);
  });

  it("triggers a due reminder with no reply", async () => {
    rawReminderFindMany.mockResolvedValue([openRow({ status: "PENDING" })]);
    messageFindFirst.mockResolvedValue(null);

    const result = await runFollowUpCheck({ now: NOW });

    expect(result).toMatchObject({ resolved: 0, triggered: 1 });
    expect(reminderUpdateMany.mock.calls[0]?.[0]).toEqual({
      // Conditional on PENDING, so two concurrent checks cannot trigger it twice.
      where: { id: REMINDER_ID, status: "PENDING" },
      data: { status: "TRIGGERED" },
    });
  });

  it("does not trigger a reminder that is not due yet", async () => {
    rawReminderFindMany.mockResolvedValue([
      openRow({ status: "PENDING", dueAt: new Date("2026-09-20T08:00:00Z") }),
    ]);

    const result = await runFollowUpCheck({ now: NOW });

    expect(result).toMatchObject({ resolved: 0, triggered: 0 });
    expect(reminderUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps going when one reminder's check fails", async () => {
    // Scheduled work that aborts halfway leaves an arbitrary subset done.
    rawReminderFindMany.mockResolvedValue([
      openRow({ id: "cldd4kzai000708l3a1b2c3d4" }),
      openRow({ status: "PENDING" }),
    ]);
    messageFindFirst
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce(null);

    const result = await runFollowUpCheck({ now: NOW });

    expect(result.examined).toBe(2);
    expect(result.triggered).toBe(1);
  });

  it("offers the digest only for users whose reminders are actually waiting", async () => {
    rawReminderFindMany.mockResolvedValue([openRow({ status: "PENDING" })]);
    sendFollowUpDigest.mockResolvedValue({ sent: true, items: 1 });

    const result = await runFollowUpCheck({ now: NOW });

    expect(sendFollowUpDigest).toHaveBeenCalledWith({ userId: USER_ID, now: NOW });
    expect(result.digestsSent).toBe(1);
  });

  it("does not fail the check when the digest cannot be sent", async () => {
    rawReminderFindMany.mockResolvedValue([openRow({ status: "PENDING" })]);
    sendFollowUpDigest.mockRejectedValue(new Error("resend is down"));

    const result = await runFollowUpCheck({ now: NOW });

    expect(result.triggered).toBe(1);
    expect(result.digestsSent).toBe(0);
  });
});

describe("listing what is due", () => {
  it("asks only for reminders that are due and not snoozed past now", async () => {
    await listDueReminders({ userId: USER_ID, now: NOW });

    const where = reminderFindMany.mock.calls[0]?.[0].where;
    expect(where.dueAt.lte).toEqual(NOW);
    // Filtered by time rather than by a status transition, so "snoozed three days"
    // needs nothing to wake it up.
    expect(where.OR).toEqual([{ snoozedUntil: null }, { snoozedUntil: { lte: NOW } }]);
  });

  it("names who the user was waiting on, read from the thread's newest sent message", async () => {
    reminderFindMany.mockResolvedValue([reminderRow()]);
    messageFindMany.mockResolvedValue([
      { threadId: THREAD_ID, to: ["dana@northwind.example"] },
      // Older, and must not win: the query orders newest first.
      { threadId: THREAD_ID, to: ["someone-else@northwind.example"] },
    ]);

    const [item] = await listDueReminders({ userId: USER_ID, now: NOW });

    expect(item?.recipients).toEqual(["dana@northwind.example"]);
    expect(item?.subject).toBe("Invoice 4471");
  });

  it("does not query for recipients when there is nothing due", async () => {
    await listDueReminders({ userId: USER_ID, now: NOW });
    expect(messageFindMany).not.toHaveBeenCalled();
  });
});

describe("dismiss and snooze", () => {
  it("dismisses terminally", async () => {
    await dismissReminder({ userId: USER_ID, reminderId: REMINDER_ID, now: NOW });

    expect(reminderUpdateMany.mock.calls[0]?.[0].data).toEqual({
      status: "DISMISSED",
      resolvedAt: NOW,
    });
  });

  it("404s a reminder that is not this user's", async () => {
    // The tenancy filter makes it not exist, and this must not confirm the id is real.
    reminderUpdateMany.mockResolvedValue({ count: 0 });
    reminderFindFirst.mockResolvedValue(null);

    await expect(
      dismissReminder({ userId: USER_ID, reminderId: REMINDER_ID, now: NOW }),
    ).rejects.toThrow(NotFoundError);
  });

  it("snoozes by pushing snoozedUntil out and clearing the digest stamp", async () => {
    reminderFindFirst.mockResolvedValue({ id: REMINDER_ID, status: "TRIGGERED" });

    await snoozeReminder({ userId: USER_ID, reminderId: REMINDER_ID, days: 3, now: NOW });

    const data = reminderUpdateMany.mock.calls[0]?.[0].data;
    expect(data.status).toBe("SNOOZED");
    expect(data.snoozedUntil.toISOString()).toBe("2026-09-19T08:00:00.000Z");
    // A snooze un-triggers it, so the digest may name it again when it comes back.
    expect(data.digestSentAt).toBeNull();
  });

  it("leaves dueAt alone when snoozing", async () => {
    // `dueAt` is the historical fact about when the reply was expected; `snoozedUntil`
    // is the user's request. Overwriting the first would lose how long this has run.
    reminderFindFirst.mockResolvedValue({ id: REMINDER_ID, status: "TRIGGERED" });

    await snoozeReminder({ userId: USER_ID, reminderId: REMINDER_ID, days: 3, now: NOW });

    expect(reminderUpdateMany.mock.calls[0]?.[0].data.dueAt).toBeUndefined();
  });
});
