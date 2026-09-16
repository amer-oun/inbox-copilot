import { randomUUID } from "node:crypto";
import { dbForUser, prisma } from "@inbox-copilot/db";
import {
  scheduledEmailSchema,
  type ScheduledEmailDto,
  type ScheduleStatus,
} from "@inbox-copilot/shared";
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  scheduleSendJobId,
  scheduleSendQueue,
  type ScheduleSendJob,
} from "../lib/queues.js";
import { assertValidTimeZone, zonedWallTimeToUtc } from "../lib/timezone.js";
import { mailProviderFor } from "../providers/registry.js";
import type { RawAddress } from "../providers/mailProvider.js";
import {
  parseFormattedAddress,
  referencesChain,
  replyRecipients,
  replySubject,
  textToHtml,
  type ReplyTarget,
} from "./send.js";
import { createFollowUpReminder } from "./followUps.js";

/**
 * Scheduled send (§9).
 *
 * The design is one sentence: **the row is the source of truth and the BullMQ job is
 * only a trigger.** Everything else here follows from it.
 *
 *   - The job payload is an id. Subject, body, recipients and status are read fresh
 *     when the job runs, so a job Redis kept across a cancellation finds a CANCELLED
 *     row and does nothing.
 *   - A lost job is not a lost send. `sweepDueScheduledEmails` re-enqueues anything
 *     overdue from one indexed query, which is what makes "recoverable on its own"
 *     true rather than hoped for. A flushed Redis costs at most one sweep interval.
 *   - Two triggers for one row cannot send twice. The claim is a conditional
 *     `updateMany` from SCHEDULED to SENDING; the loser sees zero rows updated and
 *     stops. `idempotencyKey` is the unique constraint under that, and a row already
 *     SENT can never be claimed again.
 *
 * And the rule inherited from phase 6, unchanged and load-bearing: **a send whose
 * outcome is unknown is not retried.** The queue gives this one attempt
 * (`SCHEDULE_SEND_JOB_OPTIONS`), the sweeper only ever looks at SCHEDULED rows, and a
 * row stuck in SENDING — the genuinely ambiguous case — is left alone and surfaced to
 * the user rather than guessed at. Sending the user's mail twice is worse than telling
 * them it may not have gone.
 *
 * Rule 1 also holds on this path: what is scheduled is text the user submitted, and no
 * model is called anywhere in this file.
 */

/**
 * How far ahead of `sendAt` the sweeper will claim a row.
 *
 * Zero would be correct and slightly unlucky: the sweeper runs on a tick, so a row
 * due 200ms after it looks waits a whole interval. A small lead means the send lands
 * on time rather than a minute late, and it is well inside the minute a person means
 * by "9am".
 */
export const SWEEP_LEAD_MS = 30_000;

/** Rows one sweep will claim, so a backlog cannot flood the queue in one tick. */
export const SWEEP_BATCH = 200;

/** The furthest ahead a send may be scheduled. A year is already generous. */
const MAX_HORIZON_MS = 365 * 24 * 3_600_000;

/** How far in the past a requested time may be before it is a mistake, not a nudge. */
const MAX_BACKDATE_MS = 60_000;

/** The columns every DTO here is built from. */
const SCHEDULED_SELECT = {
  id: true,
  threadId: true,
  to: true,
  cc: true,
  subject: true,
  bodyText: true,
  sendAt: true,
  localSendAt: true,
  timezone: true,
  status: true,
  expectsReply: true,
  attempts: true,
  lastError: true,
  sentAt: true,
  createdAt: true,
} as const;

interface ScheduledRow {
  id: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string | null;
  sendAt: Date;
  localSendAt: string | null;
  timezone: string;
  status: ScheduleStatus;
  expectsReply: boolean;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

function toDto(row: ScheduledRow): ScheduledEmailDto {
  return scheduledEmailSchema.parse({
    id: row.id,
    threadId: row.threadId,
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    bodyText: row.bodyText,
    sendAt: row.sendAt.toISOString(),
    sendAtLocal: row.localSendAt,
    timezone: row.timezone,
    status: row.status,
    expectsReply: row.expectsReply,
    attempts: row.attempts,
    lastError: row.lastError,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Resolves the requested wall time, and refuses the times that are mistakes.
 *
 * The bounds are here rather than in the Zod schema because they are relative to
 * *now*: "not in the past" is not a property of a string.
 */
function resolveSendAt(sendAtLocal: string, timezone: string, now: Date): Date {
  assertValidTimeZone(timezone);
  const sendAt = zonedWallTimeToUtc(sendAtLocal, timezone);

  if (sendAt.getTime() < now.getTime() - MAX_BACKDATE_MS) {
    throw new BadRequestError(
      `That time has already passed in ${timezone}. Pick a time in the future.`,
    );
  }
  if (sendAt.getTime() > now.getTime() + MAX_HORIZON_MS) {
    throw new BadRequestError("A send cannot be scheduled more than a year ahead");
  }
  return sendAt;
}

export interface ScheduleReplyInput {
  userId: string;
  threadId: string;
  body: string;
  sendAtLocal: string;
  timezone: string;
  expectsReply?: boolean;
  draftId?: string;
  now?: Date;
}

/**
 * Schedules a reply into an existing thread.
 *
 * The recipients and the threading headers are computed *now*, from the parent
 * message, and frozen onto the row — not recomputed at send time. That is a real
 * choice with a real trade: if the thread gains a message before the send, the reply
 * goes to whoever the user was answering rather than to whoever spoke last. The user
 * saw an address in the composer and pressed schedule; the mail going somewhere else
 * because a stranger replied in the meantime is the worse surprise, and on a thread
 * under §6 assessment it is also how a forged reply could redirect a queued answer.
 */
export async function scheduleReply(input: ScheduleReplyInput): Promise<ScheduledEmailDto> {
  const body = input.body.trim();
  if (body === "") throw new BadRequestError("A scheduled reply needs a body");

  const now = input.now ?? new Date();
  const sendAt = resolveSendAt(input.sendAtLocal, input.timezone, now);
  const db = dbForUser(input.userId);

  const thread = await db.thread.findFirst({
    where: { id: input.threadId },
    select: {
      id: true,
      providerThreadId: true,
      mailAccountId: true,
      mailAccount: { select: { emailAddress: true } },
      messages: {
        orderBy: { sentAt: "desc" },
        take: 1,
        select: {
          id: true,
          subject: true,
          fromName: true,
          fromEmail: true,
          to: true,
          replyTo: true,
          isOutbound: true,
        },
      },
    },
  });

  if (!thread) throw new NotFoundError("Thread not found");

  const parent = thread.messages[0];
  if (parent === undefined) throw new NotFoundError("Thread has no messages");

  const recipients = replyRecipients(parent as ReplyTarget, thread.mailAccount.emailAddress);

  const row = await db.scheduledEmail.create({
    data: {
      userId: input.userId,
      mailAccountId: thread.mailAccountId,
      threadId: thread.id,
      parentMessageId: parent.id,
      to: recipients.map(formatAddress),
      cc: [],
      bcc: [],
      subject: replySubject(parent.subject),
      bodyText: body,
      bodyHtml: textToHtml(body),
      sendAt,
      localSendAt: input.sendAtLocal,
      timezone: input.timezone,
      expectsReply: input.expectsReply ?? false,
      idempotencyKey: randomUUID(),
    },
    select: SCHEDULED_SELECT,
  });

  await enqueueScheduledSend({ scheduledEmailId: row.id, userId: input.userId, sendAt, now });

  logger.info(
    {
      userId: input.userId,
      mailAccountId: thread.mailAccountId,
      threadId: thread.id,
      scheduledEmailId: row.id,
      sendAt: sendAt.toISOString(),
      timezone: input.timezone,
      expectsReply: row.expectsReply,
      recipients: recipients.length,
      bodyChars: body.length,
    },
    "reply scheduled",
  );

  return toDto(row as ScheduledRow);
}

export interface ScheduleNewInput {
  userId: string;
  mailAccountId: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  sendAtLocal: string;
  timezone: string;
  now?: Date;
}

/**
 * Schedules a new message.
 *
 * No `expectsReply`: a reminder is scoped to a thread, and a message that starts one
 * has no thread until the sync engine brings the sent copy back. Offering the tick box
 * here would be offering a reminder that could never be resolved.
 */
export async function scheduleNewMessage(
  input: ScheduleNewInput,
): Promise<ScheduledEmailDto> {
  const body = input.body.trim();
  if (body === "") throw new BadRequestError("A scheduled message needs a body");

  const now = input.now ?? new Date();
  const sendAt = resolveSendAt(input.sendAtLocal, input.timezone, now);
  const db = dbForUser(input.userId);

  // The tenancy read *is* the ownership check: a mailbox belonging to somebody else
  // does not exist for this client.
  const mailAccount = await db.mailAccount.findFirst({
    where: { id: input.mailAccountId },
    select: { id: true, emailAddress: true, syncStatus: true },
  });
  if (!mailAccount) throw new NotFoundError("Mailbox not found");
  if (mailAccount.syncStatus === "REVOKED") {
    throw new ConflictError("Reconnect this mailbox before scheduling mail from it", {
      needsReconnect: true,
    });
  }

  const row = await db.scheduledEmail.create({
    data: {
      userId: input.userId,
      mailAccountId: mailAccount.id,
      to: input.to,
      cc: input.cc ?? [],
      bcc: [],
      subject: input.subject,
      bodyText: body,
      bodyHtml: textToHtml(body),
      sendAt,
      localSendAt: input.sendAtLocal,
      timezone: input.timezone,
      idempotencyKey: randomUUID(),
    },
    select: SCHEDULED_SELECT,
  });

  await enqueueScheduledSend({ scheduledEmailId: row.id, userId: input.userId, sendAt, now });

  logger.info(
    {
      userId: input.userId,
      mailAccountId: mailAccount.id,
      scheduledEmailId: row.id,
      sendAt: sendAt.toISOString(),
      timezone: input.timezone,
      recipients: input.to.length,
      bodyChars: body.length,
    },
    "message scheduled",
  );

  return toDto(row as ScheduledRow);
}

/** `RawAddress` back to the `"Name <addr>"` form `ScheduledEmail.to` stores. */
function formatAddress(address: RawAddress): string {
  return address.name === undefined ? address.email : `${address.name} <${address.email}>`;
}

/**
 * Queues the trigger for a row that already exists.
 *
 * Deliberately after the write, and deliberately never inside a transaction with it.
 * If this throws, the row still stands and the sweeper picks it up within the minute —
 * the same shape as the sync engine's "cursor advances only after the commit" rule
 * (rule 8): the durable thing goes first, and the queue is allowed to be unreliable.
 *
 * Never throws for that reason.
 */
export async function enqueueScheduledSend(input: {
  scheduledEmailId: string;
  userId: string;
  sendAt: Date;
  now?: Date;
}): Promise<{ queued: boolean }> {
  const delay = Math.max(0, input.sendAt.getTime() - (input.now ?? new Date()).getTime());
  const jobId = scheduleSendJobId(input.scheduledEmailId);

  try {
    const queue = scheduleSendQueue();
    /*
     * BullMQ keeps completed jobs for a while and silently refuses to re-add an id it
     * still holds — which here would mean a row the sweeper re-queued after a failed
     * claim never running again. Clearing the finished job first is the same fix the
     * delta queue needed for the same reason.
     */
    const existing = await queue.getJob(jobId);
    if (existing !== undefined) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") await existing.remove();
      else return { queued: false };
    }

    await queue.add(
      "send",
      { scheduledEmailId: input.scheduledEmailId, userId: input.userId },
      { jobId, delay },
    );
    return { queued: true };
  } catch (error) {
    // The row is what matters, and the sweeper is the backstop. A Redis hiccup must
    // not turn a successful schedule into an error the user reads as "not scheduled".
    logger.error(
      { err: error, userId: input.userId, scheduledEmailId: input.scheduledEmailId },
      "could not queue the trigger for a scheduled send; the sweeper will pick it up",
    );
    return { queued: false };
  }
}

/** Everything still pending, soonest first; or one status the caller asked for. */
export async function listScheduledEmails(input: {
  userId: string;
  status?: ScheduleStatus;
}): Promise<ScheduledEmailDto[]> {
  const rows = await dbForUser(input.userId).scheduledEmail.findMany({
    where:
      input.status === undefined
        ? // The default list is "what is still going to happen, and what went wrong" —
          // SENT rows are in the mailbox, which is a better place to read them.
          { status: { in: ["SCHEDULED", "SENDING", "FAILED"] } }
        : { status: input.status },
    orderBy: { sendAt: "asc" },
    select: SCHEDULED_SELECT,
  });

  return (rows as ScheduledRow[]).map(toDto);
}

/**
 * Cancels a pending send.
 *
 * Conditional on the status, in one statement: a row already SENDING is past the point
 * where cancelling means anything, and telling the user "cancelled" about mail that is
 * on its way to Gmail would be a lie. The queue job is removed afterwards as a
 * courtesy — if that fails, the job runs, reads a CANCELLED row and does nothing.
 */
export async function cancelScheduledEmail(input: {
  userId: string;
  scheduledId: string;
}): Promise<ScheduledEmailDto> {
  const db = dbForUser(input.userId);

  const existing = await db.scheduledEmail.findFirst({
    where: { id: input.scheduledId },
    select: { id: true, status: true },
  });
  if (!existing) throw new NotFoundError("Scheduled send not found");

  if (existing.status !== "SCHEDULED") {
    throw new ConflictError(
      existing.status === "SENDING"
        ? "This send is already going out and can no longer be cancelled"
        : `This send is ${existing.status.toLowerCase()} and cannot be cancelled`,
      { status: existing.status },
    );
  }

  const claimed = await db.scheduledEmail.updateMany({
    where: { id: input.scheduledId, status: "SCHEDULED" },
    data: { status: "CANCELLED" },
  });

  if (claimed.count === 0) {
    // Lost the race with the send itself, between the read and the write.
    throw new ConflictError("This send started while you were cancelling it");
  }

  try {
    const job = await scheduleSendQueue().getJob(scheduleSendJobId(input.scheduledId));
    await job?.remove();
  } catch (error) {
    logger.warn(
      { err: error, userId: input.userId, scheduledEmailId: input.scheduledId },
      "cancelled send but could not remove its queue job; the job will find a cancelled row",
    );
  }

  const row = await db.scheduledEmail.findFirstOrThrow({
    where: { id: input.scheduledId },
    select: SCHEDULED_SELECT,
  });

  logger.info(
    { userId: input.userId, scheduledEmailId: input.scheduledId },
    "scheduled send cancelled",
  );

  return toDto(row as ScheduledRow);
}

export interface RunScheduledSendResult {
  status: "sent" | "skipped" | "rescheduled" | "failed";
  /** Why nothing was sent, when nothing was sent. */
  reason?: string;
  providerMessageId?: string;
  reminderId?: string | null;
}

/**
 * Sends one scheduled row, if it is still this job's to send.
 *
 * The ordering is the whole function, so it is worth reading as a list:
 *
 *   1. **Claim.** `SCHEDULED -> SENDING` conditionally. Zero rows updated means
 *      somebody else has it, or the user cancelled, or it already went — every one of
 *      which means stop, not retry.
 *   2. **Re-resolve the time.** `localSendAt` in `timezone` is the truth; `sendAt` is
 *      a derivation that can go stale when a zone's rules change. If the wall time the
 *      user picked is still in the future, put the row back and re-queue rather than
 *      sending an hour early.
 *   3. **Send, once.** `sendMessage` does not retry at the provider layer either.
 *   4. **Record.** SENT plus the provider's id. On a throw, FAILED plus the message,
 *      and no further attempt.
 */
export async function runScheduledSend(
  job: ScheduleSendJob,
  options: { signal?: AbortSignal; now?: Date } = {},
): Promise<RunScheduledSendResult> {
  const now = options.now ?? new Date();
  const db = dbForUser(job.userId);
  const log = logger.child({ userId: job.userId, scheduledEmailId: job.scheduledEmailId });

  const row = await db.scheduledEmail.findFirst({
    where: { id: job.scheduledEmailId },
    select: {
      id: true,
      mailAccountId: true,
      threadId: true,
      parentMessageId: true,
      to: true,
      cc: true,
      bcc: true,
      subject: true,
      bodyText: true,
      bodyHtml: true,
      sendAt: true,
      localSendAt: true,
      timezone: true,
      status: true,
      expectsReply: true,
      mailAccount: { select: { provider: true, emailAddress: true } },
    },
  });

  if (!row) {
    // A deleted mailbox takes its queued sends with it (cascade). Not an error.
    log.info("scheduled send no longer exists");
    return { status: "skipped", reason: "missing" };
  }

  if (row.status !== "SCHEDULED") {
    log.info({ status: row.status }, "scheduled send is not claimable");
    return { status: "skipped", reason: row.status.toLowerCase() };
  }

  /*
   * The wall clock is the truth (§9). If the rules for this zone moved after the row
   * was written, `sendAt` is stale and this is the moment that matters — sending on a
   * stale instant is exactly the "9am survived a DST change" failure the timezone
   * column exists to prevent.
   */
  if (row.localSendAt !== null) {
    const resolved = zonedWallTimeToUtc(row.localSendAt, row.timezone);
    if (resolved.getTime() - now.getTime() > SWEEP_LEAD_MS) {
      await db.scheduledEmail.updateMany({
        where: { id: row.id, status: "SCHEDULED" },
        data: { sendAt: resolved },
      });
      await enqueueScheduledSend({
        scheduledEmailId: row.id,
        userId: job.userId,
        sendAt: resolved,
        now,
      });
      log.warn(
        {
          storedSendAt: row.sendAt.toISOString(),
          resolvedSendAt: resolved.toISOString(),
          timezone: row.timezone,
          localSendAt: row.localSendAt,
        },
        "the zone's rules moved since this was scheduled; corrected sendAt and re-queued",
      );
      return { status: "rescheduled", reason: "timezone-rules-changed" };
    }
  }

  const claim = await db.scheduledEmail.updateMany({
    where: { id: row.id, status: "SCHEDULED" },
    data: { status: "SENDING", attempts: { increment: 1 } },
  });

  if (claim.count === 0) {
    // Another trigger for the same row got there first. This is the sweeper and a
    // surviving delayed job arriving together, and it is the normal, quiet outcome.
    log.info("another trigger claimed this send first");
    return { status: "skipped", reason: "claimed-elsewhere" };
  }

  const recipients = row.to
    .map(parseFormattedAddress)
    .filter((address): address is RawAddress => address !== null);

  if (recipients.length === 0) {
    await markFailed(job, "The stored recipients could not be parsed");
    log.error("scheduled send has no parseable recipients");
    return { status: "failed", reason: "no-recipients" };
  }

  try {
    const provider = mailProviderFor(row.mailAccount.provider, {
      mailAccountId: row.mailAccountId,
      userId: job.userId,
      emailAddress: row.mailAccount.emailAddress,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const threading = await threadingFor(job.userId, row.threadId, row.parentMessageId);

    const sent = await provider.sendMessage({
      to: recipients,
      cc: row.cc
        .map(parseFormattedAddress)
        .filter((address): address is RawAddress => address !== null),
      subject: row.subject,
      ...(row.bodyText === null ? {} : { bodyText: row.bodyText }),
      bodyHtml: row.bodyHtml,
      ...(threading === null ? {} : { inReplyTo: threading }),
    });

    await db.scheduledEmail.update({
      where: { id: row.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        providerMessageId: sent.providerMessageId,
        lastError: null,
      },
    });

    /*
     * The reminder comes after the send, never before: a reminder to chase a reply to
     * mail that never went out is worse than no reminder. It also cannot fail the
     * send — the mail has left the building and no local write can recall it.
     */
    let reminderId: string | null = null;
    if (row.expectsReply && row.threadId !== null) {
      reminderId = await tryCreateReminder({
        userId: job.userId,
        threadId: row.threadId,
        watchedMessageId: sent.providerMessageId,
        reason: row.subject,
      });
    }

    log.info(
      {
        mailAccountId: row.mailAccountId,
        threadId: row.threadId,
        providerMessageId: sent.providerMessageId,
        recipients: recipients.length,
        reminderId,
      },
      "scheduled send delivered",
    );

    return { status: "sent", providerMessageId: sent.providerMessageId, reminderId };
  } catch (error) {
    /*
     * FAILED, once, with the reason on the row — and no retry.
     *
     * This is the phase-6 rule at its sharpest. The provider may have accepted the
     * message before the error (a timeout on the response, a 502 from a proxy in
     * front of a successful call), so trying again could put the user's mail in
     * somebody's inbox twice. A row that says "we do not know" and a user who is told
     * so is the honest outcome; a duplicate send is not recoverable at all.
     */
    const message = error instanceof Error ? error.message : "Send failed";
    await markFailed(job, message);
    log.error({ err: error, mailAccountId: row.mailAccountId }, "scheduled send failed");
    return { status: "failed", reason: message };
  }
}

/** Records the failure. Best effort — the send has already happened or not. */
async function markFailed(job: ScheduleSendJob, message: string): Promise<void> {
  try {
    await dbForUser(job.userId).scheduledEmail.updateMany({
      where: { id: job.scheduledEmailId },
      // Truncated: `lastError` is shown to the user and a provider stack trace is not
      // an explanation.
      data: { status: "FAILED", lastError: message.slice(0, 500) },
    });
  } catch (error) {
    logger.error(
      { err: error, userId: job.userId, scheduledEmailId: job.scheduledEmailId },
      "could not record a failed scheduled send",
    );
  }
}

/** Never lets a bookkeeping failure look like a send failure. */
async function tryCreateReminder(input: {
  userId: string;
  threadId: string;
  watchedMessageId: string;
  reason: string;
}): Promise<string | null> {
  try {
    const reminder = await createFollowUpReminder(input);
    return reminder?.id ?? null;
  } catch (error) {
    logger.error(
      { err: error, userId: input.userId, threadId: input.threadId },
      "sent a scheduled message but could not create its follow-up reminder",
    );
    return null;
  }
}

/**
 * The RFC threading headers for a scheduled reply, read at send time.
 *
 * The *parent* is frozen on the row (so the reply answers what the user was reading),
 * but its `References` chain is read now — the chain is a property of the parent, not
 * of the moment, and reading it here keeps `ScheduledEmail` from carrying a copy of
 * headers that already exist one join away.
 */
async function threadingFor(
  userId: string,
  threadId: string | null,
  parentMessageId: string | null,
): Promise<{ providerThreadId: string; internetMessageId: string; references: string[] } | null> {
  if (threadId === null || parentMessageId === null) return null;

  const db = dbForUser(userId);
  const thread = await db.thread.findFirst({
    where: { id: threadId },
    select: { providerThreadId: true },
  });
  if (!thread) return null;

  const parent = await db.message.findFirst({
    where: { id: parentMessageId },
    select: { internetMessageId: true, headers: true },
  });
  // No parent (or no Message-ID) means Gmail's own threadId is all we have. The reply
  // still groups in this mailbox; it just will not thread in everyone else's client.
  if (!parent || parent.internetMessageId === null) return null;

  return {
    providerThreadId: thread.providerThreadId,
    internetMessageId: parent.internetMessageId,
    references: referencesChain({
      internetMessageId: parent.internetMessageId,
      headers: parent.headers,
    } as Parameters<typeof referencesChain>[0]),
  };
}

export interface SweepResult {
  found: number;
  queued: number;
}

/**
 * The sweeper §9 asks for: find overdue sends and re-enqueue them.
 *
 * This is what makes the DB row recoverable on its own, and it is the only reason it
 * is safe to treat the queue as unreliable everywhere else in this file. Redis loses a
 * delayed job — an eviction, a flush, a restart without persistence, a `FLUSHALL`
 * during development — and a send the user is counting on simply never fires. One
 * indexed query on `(status, sendAt)` makes that a delay of at most a minute instead.
 *
 * Only SCHEDULED rows, never SENDING: see the comment on `SCHEDULE_SEND_JOB_OPTIONS`.
 *
 * Cross-tenant by necessity and narrowly so, on the same terms as the AI sweep: the
 * base client is asked for ids and owners, and every enqueue carries the userId that
 * the job will then act under.
 */
export async function sweepDueScheduledEmails(
  options: { now?: Date; limit?: number } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const due = await prisma.scheduledEmail.findMany({
    where: { status: "SCHEDULED", sendAt: { lte: new Date(now.getTime() + SWEEP_LEAD_MS) } },
    orderBy: { sendAt: "asc" },
    take: options.limit ?? SWEEP_BATCH,
    select: { id: true, userId: true, sendAt: true },
  });

  let queued = 0;
  for (const row of due) {
    const result = await enqueueScheduledSend({
      scheduledEmailId: row.id,
      userId: row.userId,
      sendAt: row.sendAt,
      now,
    });
    if (result.queued) queued += 1;
  }

  if (due.length > 0) {
    logger.info({ found: due.length, queued }, "scheduled-send sweep re-enqueued overdue sends");
  }

  return { found: due.length, queued };
}
