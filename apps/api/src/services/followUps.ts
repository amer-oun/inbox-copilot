import { dbForUser, prisma } from "@inbox-copilot/db";
import {
  followUpReminderSchema,
  type FollowUpReminderDto,
  type ReminderStatus,
} from "@inbox-copilot/shared";
import { NotFoundError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { sendFollowUpDigest } from "./digest.js";

/**
 * Follow-up reminders (§9).
 *
 * "You sent this and nobody answered." The feature is small; what makes it usable is
 * how aggressively it *cancels itself*, because the failure mode of a reminder system
 * is not missing a reminder, it is nagging about something already dealt with. One
 * reminder to chase a colleague who replied an hour ago teaches the user to ignore the
 * whole list.
 *
 * So the check job (`runFollowUpCheck`) resolves before it triggers, the delta sync
 * queues a check as soon as it writes inbound mail, and anything inbound on the thread
 * counts — not just a message that threads correctly on `In-Reply-To`.
 *
 * **What `watchedMessageId` holds, and why it is not a foreign key.** The reminder is
 * created the moment a send succeeds, and at that moment the sent message does not
 * exist in `Message`: the sync engine owns that table and the next delta brings the
 * real row (see `services/send.ts`). So this column holds the *provider's* message id,
 * the only identifier that exists at creation time, and the schema leaves it a plain
 * String. The consequence is that "has anybody replied" is judged against the
 * reminder's own `createdAt` rather than against the watched message's `sentAt` —
 * which is the same question asked a second later, and is answerable without waiting
 * for a sync.
 */

/** Fallback when a user has no `UserSettings` row (the schema default). */
export const DEFAULT_FOLLOW_UP_DAYS = 3;

/** Reminders one check will look at, so a large backlog cannot stall the tick. */
export const CHECK_BATCH = 500;

const REMINDER_SELECT = {
  id: true,
  threadId: true,
  reason: true,
  dueAt: true,
  snoozedUntil: true,
  status: true,
  createdAt: true,
  thread: { select: { subject: true } },
} as const;

interface ReminderRow {
  id: string;
  threadId: string;
  reason: string | null;
  dueAt: Date;
  snoozedUntil: Date | null;
  status: ReminderStatus;
  createdAt: Date;
  thread: { subject: string | null } | null;
}

function toDto(row: ReminderRow, recipients: string[] = []): FollowUpReminderDto {
  return followUpReminderSchema.parse({
    id: row.id,
    threadId: row.threadId,
    subject: row.thread?.subject ?? null,
    recipients,
    dueAt: row.dueAt.toISOString(),
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  });
}

export interface CreateReminderInput {
  userId: string;
  threadId: string;
  /** The provider's id for the message just sent — see the note above. */
  watchedMessageId: string;
  /** Usually the subject, so the list reads as mail. */
  reason?: string;
  now?: Date;
}

/**
 * Creates a reminder for a message the user has just sent.
 *
 * Returns null rather than throwing when there is already a pending reminder on this
 * thread. Sending three messages into a silent thread is one act of chasing somebody,
 * and three reminders about it would be three rows the user has to dismiss separately
 * — so the existing one stands, still due at its original date. The *first* unanswered
 * message is the one worth being reminded about.
 */
export async function createFollowUpReminder(
  input: CreateReminderInput,
): Promise<{ id: string; dueAt: Date } | null> {
  const now = input.now ?? new Date();
  const db = dbForUser(input.userId);

  const existing = await db.followUpReminder.findFirst({
    where: { threadId: input.threadId, status: { in: ["PENDING", "TRIGGERED", "SNOOZED"] } },
    select: { id: true, dueAt: true },
  });

  if (existing) {
    logger.debug(
      { userId: input.userId, threadId: input.threadId, reminderId: existing.id },
      "thread already has an open follow-up reminder; keeping it",
    );
    return null;
  }

  const days = await followUpDaysFor(input.userId);
  const dueAt = new Date(now.getTime() + days * 24 * 3_600_000);

  const row = await db.followUpReminder.create({
    data: {
      userId: input.userId,
      threadId: input.threadId,
      watchedMessageId: input.watchedMessageId,
      ...(input.reason === undefined ? {} : { reason: input.reason.slice(0, 300) }),
      dueAt,
    },
    select: { id: true, dueAt: true },
  });

  logger.info(
    {
      userId: input.userId,
      threadId: input.threadId,
      reminderId: row.id,
      dueAt: dueAt.toISOString(),
      followUpDays: days,
    },
    "follow-up reminder created",
  );

  return row;
}

/** `UserSettings.followUpDays`, or the schema default when there is no row. */
export async function followUpDaysFor(userId: string): Promise<number> {
  const settings = await dbForUser(userId).userSettings.findFirst({
    where: { userId },
    select: { followUpDays: true },
  });
  return settings?.followUpDays ?? DEFAULT_FOLLOW_UP_DAYS;
}

/**
 * Reminders the user should see: due now, or already triggered, and not snoozed past
 * this moment.
 *
 * Snoozed rows are filtered by time rather than by status transition, so "snoozed for
 * three days" needs nothing to wake it up.
 */
export async function listDueReminders(input: {
  userId: string;
  now?: Date;
}): Promise<FollowUpReminderDto[]> {
  const now = input.now ?? new Date();
  const db = dbForUser(input.userId);

  const rows = await db.followUpReminder.findMany({
    where: {
      status: { in: ["PENDING", "TRIGGERED", "SNOOZED"] },
      dueAt: { lte: now },
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
    orderBy: { dueAt: "asc" },
    select: REMINDER_SELECT,
  });

  return withRecipients(input.userId, rows as ReminderRow[]);
}

/**
 * Fills in who the user was waiting on.
 *
 * Read from the thread's newest *outbound* message rather than stored on the reminder:
 * the reminder is created before the sent copy has synced, so at creation time there is
 * no recipient list to copy. One query for the whole page.
 */
async function withRecipients(
  userId: string,
  rows: readonly ReminderRow[],
): Promise<FollowUpReminderDto[]> {
  if (rows.length === 0) return [];

  const threadIds = rows.map((row) => row.threadId);
  const outbound = await dbForUser(userId).message.findMany({
    where: { threadId: { in: threadIds }, isOutbound: true },
    orderBy: { sentAt: "desc" },
    select: { threadId: true, to: true },
  });

  const byThread = new Map<string, string[]>();
  for (const message of outbound) {
    // Newest first, so the first one seen for a thread is the one that counts.
    if (!byThread.has(message.threadId)) byThread.set(message.threadId, message.to);
  }

  return rows.map((row) => toDto(row, byThread.get(row.threadId) ?? []));
}

/** "I have dealt with this." Terminal — nothing re-opens a dismissed reminder. */
export async function dismissReminder(input: {
  userId: string;
  reminderId: string;
  now?: Date;
}): Promise<FollowUpReminderDto> {
  const db = dbForUser(input.userId);

  const updated = await db.followUpReminder.updateMany({
    where: { id: input.reminderId, status: { not: "DISMISSED" } },
    data: { status: "DISMISSED", resolvedAt: input.now ?? new Date() },
  });

  if (updated.count === 0) {
    // Either it does not exist for this user, or it was already dismissed. The
    // tenancy filter makes both indistinguishable from here, which is correct: a 404
    // must not confirm that somebody else's reminder id is real.
    const row = await db.followUpReminder.findFirst({
      where: { id: input.reminderId },
      select: REMINDER_SELECT,
    });
    if (!row) throw new NotFoundError("Reminder not found");
    return toDto(row as ReminderRow);
  }

  const row = await db.followUpReminder.findFirstOrThrow({
    where: { id: input.reminderId },
    select: REMINDER_SELECT,
  });

  logger.info(
    { userId: input.userId, reminderId: input.reminderId },
    "follow-up reminder dismissed",
  );
  return toDto(row as ReminderRow);
}

/** "Not yet." Pushes `snoozedUntil` out; `dueAt` is left as the historical fact. */
export async function snoozeReminder(input: {
  userId: string;
  reminderId: string;
  days: number;
  now?: Date;
}): Promise<FollowUpReminderDto> {
  const now = input.now ?? new Date();
  const db = dbForUser(input.userId);

  const existing = await db.followUpReminder.findFirst({
    where: { id: input.reminderId },
    select: { id: true, status: true },
  });
  if (!existing) throw new NotFoundError("Reminder not found");

  await db.followUpReminder.updateMany({
    where: { id: input.reminderId },
    data: {
      status: "SNOOZED",
      snoozedUntil: new Date(now.getTime() + input.days * 24 * 3_600_000),
      // A snooze un-triggers it, so the next digest treats it as new again.
      digestSentAt: null,
    },
  });

  const row = await db.followUpReminder.findFirstOrThrow({
    where: { id: input.reminderId },
    select: REMINDER_SELECT,
  });

  logger.info(
    { userId: input.userId, reminderId: input.reminderId, days: input.days },
    "follow-up reminder snoozed",
  );
  return toDto(row as ReminderRow);
}

export interface FollowUpCheckResult {
  examined: number;
  resolved: number;
  triggered: number;
  digestsSent: number;
}

/**
 * The `followup.check` job (§9).
 *
 * Resolve first, then trigger. The order is not cosmetic: a reminder whose reply
 * arrived an hour before it came due must never appear as due, and doing it the other
 * way round would show it for one tick — which for a daily digest means one email
 * chasing somebody who already answered.
 *
 * "Any inbound message on the thread" is the cancellation condition §9 asks for, taken
 * literally. Not "a message that threads on our Message-ID", not "a message from the
 * original recipient": a colleague answering from a different address, an assistant
 * replying on their behalf, or a client that mangles `In-Reply-To` all mean the user
 * has heard back. The cost of being generous here is occasionally clearing a reminder
 * on an unrelated inbound message in the same thread; the cost of being strict is
 * nagging, and nagging is what kills the feature.
 */
export async function runFollowUpCheck(
  options: { now?: Date; userId?: string } = {},
): Promise<FollowUpCheckResult> {
  const now = options.now ?? new Date();

  /*
   * Cross-tenant, narrowly: ids and owners only, no mail, on the same terms as the AI
   * sweep. Every subsequent query goes through `dbForUser`.
   */
  const open = await prisma.followUpReminder.findMany({
    where: {
      status: { in: ["PENDING", "SNOOZED", "TRIGGERED"] },
      ...(options.userId === undefined ? {} : { userId: options.userId }),
    },
    orderBy: { dueAt: "asc" },
    take: CHECK_BATCH,
    select: { id: true, userId: true, threadId: true, dueAt: true, status: true, createdAt: true },
  });

  const result: FollowUpCheckResult = {
    examined: open.length,
    resolved: 0,
    triggered: 0,
    digestsSent: 0,
  };

  const touchedUsers = new Set<string>();

  for (const reminder of open) {
    try {
      const db = dbForUser(reminder.userId);

      /*
       * Did anything inbound land on this thread since we started waiting?
       *
       * `sentAt` rather than `createdAt` on the message, so a reply that arrives in a
       * sync minutes later still counts by when it was *sent*. A one-minute grace
       * before the reminder's own creation absorbs clock skew between Gmail's stamp
       * and ours on a reply that crossed with the send.
       */
      const reply = await db.message.findFirst({
        where: {
          threadId: reminder.threadId,
          isOutbound: false,
          sentAt: { gte: new Date(reminder.createdAt.getTime() - 60_000) },
        },
        orderBy: { sentAt: "asc" },
        select: { id: true, sentAt: true },
      });

      if (reply) {
        const updated = await db.followUpReminder.updateMany({
          where: { id: reminder.id, status: { in: ["PENDING", "SNOOZED", "TRIGGERED"] } },
          data: { status: "RESOLVED", resolvedAt: reply.sentAt },
        });
        if (updated.count > 0) {
          result.resolved += 1;
          logger.info(
            {
              userId: reminder.userId,
              threadId: reminder.threadId,
              reminderId: reminder.id,
              repliedAt: reply.sentAt.toISOString(),
            },
            "follow-up reminder resolved by an inbound reply",
          );
        }
        continue;
      }

      if (reminder.status === "PENDING" && reminder.dueAt.getTime() <= now.getTime()) {
        const updated = await db.followUpReminder.updateMany({
          where: { id: reminder.id, status: "PENDING" },
          data: { status: "TRIGGERED" },
        });
        if (updated.count > 0) {
          result.triggered += 1;
          touchedUsers.add(reminder.userId);
        }
      } else if (reminder.status === "TRIGGERED") {
        touchedUsers.add(reminder.userId);
      }
    } catch (error) {
      // One reminder must not stop the rest: this runs on a schedule, and a check that
      // aborts halfway leaves an arbitrary subset examined.
      logger.error(
        { err: error, userId: reminder.userId, reminderId: reminder.id },
        "follow-up check failed for one reminder",
      );
    }
  }

  for (const userId of touchedUsers) {
    try {
      const sent = await sendFollowUpDigest({ userId, now });
      if (sent.sent) result.digestsSent += 1;
    } catch (error) {
      logger.error({ err: error, userId }, "could not send the follow-up digest");
    }
  }

  if (result.resolved > 0 || result.triggered > 0 || result.digestsSent > 0) {
    logger.info(result, "follow-up check finished");
  }

  return result;
}
