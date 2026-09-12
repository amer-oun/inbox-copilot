import { dbForUser, type Prisma } from "@inbox-copilot/db";
import {
  syncStatusResponseSchema,
  type StartSyncResponse,
  type SyncJobState,
  type SyncStatusResponse,
} from "@inbox-copilot/shared";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  backfillJobId,
  syncBackfillQueue,
  type BackfillJob,
} from "../lib/queues.js";
import { fetchThreads } from "../providers/gmail/client.js";
import { mailProviderFor } from "../providers/registry.js";
import { threadParticipants } from "../providers/gmail/map.js";
import type { RawMessage, RawThread } from "../providers/mailProvider.js";

/**
 * The sync engine (ARCHITECTURE §4).
 *
 * Two invariants drive everything here:
 *   1. Every write is idempotent on `(mailAccountId, providerMessageId)` and
 *      `(mailAccountId, providerThreadId)`, so a replay is a no-op rather than a
 *      duplicate.
 *   2. The delta cursor advances only after the rows it covers are committed. A
 *      crash mid-backfill therefore costs a repeat, never a gap.
 */

/** §4: the last 90 days, 50 threads per batch. */
export const BACKFILL_WINDOW_DAYS = 90;
export const BACKFILL_BATCH_SIZE = 50;

interface MailboxRow {
  id: string;
  userId: string;
  provider: "GMAIL" | "OUTLOOK";
  emailAddress: string;
  syncStatus: string;
  syncCursor: string | null;
}

const MAILBOX_SELECT = {
  id: true,
  userId: true,
  provider: true,
  emailAddress: true,
  syncStatus: true,
  syncCursor: true,
} as const;

async function loadMailbox(userId: string, mailAccountId: string): Promise<MailboxRow> {
  const row = (await dbForUser(userId).mailAccount.findFirst({
    where: { id: mailAccountId },
    select: MAILBOX_SELECT,
  })) as MailboxRow | null;

  if (!row) throw new NotFoundError("Mailbox not found");
  return row;
}

/**
 * Queues a backfill. The job id is derived from the mailbox, so a second request
 * while one is in flight is reported as "already running" rather than doubling the
 * work — pressing the button twice must not cost twice the quota.
 */
export async function startBackfill(input: {
  userId: string;
  mailAccountId: string;
}): Promise<StartSyncResponse> {
  const mailbox = await loadMailbox(input.userId, input.mailAccountId);

  if (mailbox.syncStatus === "REVOKED") {
    throw new ConflictError("Mailbox access was revoked; reconnect it before syncing", {
      mailAccountId: mailbox.id,
      needsReconnect: true,
    });
  }

  const queue = syncBackfillQueue();
  const jobId = backfillJobId(mailbox.id);

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "active" || state === "delayed") {
      return { enqueued: false, jobId, syncStatus: asSyncStatus(mailbox.syncStatus) };
    }
    // A finished or failed job keeps the id occupied; clear it so this request
    // actually queues something.
    await existing.remove();
  }

  const payload: BackfillJob = {
    mailAccountId: mailbox.id,
    userId: input.userId,
    windowDays: BACKFILL_WINDOW_DAYS,
  };

  await queue.add("backfill", payload, { jobId });

  // PENDING is the honest state until the worker picks it up: nothing has been
  // read yet, and the worker is what moves it to BACKFILLING.
  await dbForUser(input.userId).mailAccount.update({
    where: { id: mailbox.id },
    data: { syncStatus: "PENDING", syncError: null },
  });

  logger
    .child({ userId: input.userId, mailAccountId: mailbox.id })
    .info({ jobId }, "queued mailbox backfill");

  return { enqueued: true, jobId, syncStatus: "PENDING" };
}

function asSyncStatus(value: string): SyncStatusResponse["syncStatus"] {
  return value as SyncStatusResponse["syncStatus"];
}

export async function getSyncStatus(input: {
  userId: string;
  mailAccountId: string;
}): Promise<SyncStatusResponse> {
  const db = dbForUser(input.userId);

  const row = (await db.mailAccount.findFirst({
    where: { id: input.mailAccountId },
    select: {
      id: true,
      syncStatus: true,
      syncError: true,
      syncCursor: true,
      lastSyncedAt: true,
      backfilledUntil: true,
    },
  })) as {
    id: string;
    syncStatus: string;
    syncError: string | null;
    syncCursor: string | null;
    lastSyncedAt: Date | null;
    backfilledUntil: Date | null;
  } | null;

  if (!row) throw new NotFoundError("Mailbox not found");

  const [threadCount, messageCount] = await Promise.all([
    db.thread.count({ where: { mailAccountId: row.id } }),
    db.message.count({ where: { mailAccountId: row.id } }),
  ]);

  return syncStatusResponseSchema.parse({
    mailAccountId: row.id,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    backfilledUntil: row.backfilledUntil?.toISOString() ?? null,
    hasCursor: row.syncCursor !== null,
    threadCount,
    messageCount,
    job: await jobSnapshot(row.id),
  });
}

async function jobSnapshot(mailAccountId: string): Promise<SyncStatusResponse["job"]> {
  const job = await syncBackfillQueue().getJob(backfillJobId(mailAccountId));
  if (!job) return null;

  const state = (await job.getState()) as SyncJobState;
  const progress = job.progress;

  return {
    state: state satisfies string as SyncJobState,
    threadsProcessed:
      typeof progress === "object" && progress !== null && "threadsProcessed" in progress
        ? Number((progress as { threadsProcessed: unknown }).threadsProcessed)
        : null,
    attemptsMade: job.attemptsMade,
    // `failedReason` is our own error message (the provider's body never reaches
    // it — see lib/retry.ts), but truncate anyway: this is user-visible.
    failedReason: job.failedReason ? job.failedReason.slice(0, 300) : null,
  };
}

export interface BackfillProgress {
  threadsProcessed: number;
  messagesWritten: number;
  pagesRead: number;
}

/**
 * Runs a full backfill for one mailbox. This is the worker's job body; it is
 * exported so it can be driven directly from tests with a stubbed provider.
 *
 * `onProgress` exists so the queue can surface progress without this function
 * knowing what a BullMQ job is.
 */
export async function runBackfill(
  job: BackfillJob,
  hooks: { onProgress?: (progress: BackfillProgress) => Promise<void> } = {},
): Promise<BackfillProgress> {
  const { userId, mailAccountId } = job;
  const log = logger.child({ userId, mailAccountId });
  const db = dbForUser(userId);

  const mailbox = await loadMailbox(userId, mailAccountId);
  if (mailbox.syncStatus === "REVOKED") {
    throw new ConflictError("Mailbox access was revoked; reconnect it before syncing", {
      mailAccountId,
      needsReconnect: true,
    });
  }

  const provider = mailProviderFor(mailbox.provider, {
    mailAccountId,
    userId,
    emailAddress: mailbox.emailAddress,
  });

  await db.mailAccount.update({
    where: { id: mailAccountId },
    data: { syncStatus: "BACKFILLING", syncError: null },
  });

  /*
   * Read the history pointer BEFORE paging, not after.
   *
   * Anything that arrives while the backfill runs gets a higher history id, so a
   * cursor taken at the start replays those few messages on the first delta. A
   * cursor taken at the end would skip everything that landed during the run —
   * silently, which is the worst kind of gap.
   */
  const profile = await provider.getProfile();

  const since = new Date(Date.now() - job.windowDays * 24 * 60 * 60 * 1_000);
  const progress: BackfillProgress = { threadsProcessed: 0, messagesWritten: 0, pagesRead: 0 };

  let pageToken = job.pageToken;
  let oldestSeen: Date | null = null;

  try {
    do {
      const page = await provider.listThreadIds({
        limit: BACKFILL_BATCH_SIZE,
        after: since,
        ...(pageToken === undefined ? {} : { pageToken }),
      });

      const threads = await fetchThreads(provider, page.items);
      progress.pagesRead += 1;

      for (const thread of threads) {
        if (thread.messages.length === 0) continue;

        const written = await persistThread(db, mailAccountId, thread);
        progress.threadsProcessed += 1;
        progress.messagesWritten += written;

        const first = thread.messages[0]?.sentAt ?? null;
        if (first && (oldestSeen === null || first < oldestSeen)) oldestSeen = first;
      }

      // Per-page progress so a long backfill is observable, and so a crash leaves
      // a truthful record of how far it got.
      if (oldestSeen !== null) {
        await db.mailAccount.update({
          where: { id: mailAccountId },
          data: { backfilledUntil: oldestSeen },
        });
      }
      await hooks.onProgress?.({ ...progress });

      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken !== undefined);

    /*
     * Only now does the cursor advance (§4). Every thread above is committed, so
     * the next delta starts from a point we have genuinely caught up to.
     */
    await db.mailAccount.update({
      where: { id: mailAccountId },
      data: {
        syncStatus: "ACTIVE",
        syncError: null,
        lastSyncedAt: new Date(),
        ...(profile.historyId === null ? {} : { syncCursor: profile.historyId }),
      },
    });

    log.info(
      { ...progress, cursor: profile.historyId },
      "backfill complete; mailbox is active",
    );
    return progress;
  } catch (error) {
    // The cursor is deliberately left untouched: a failed backfill must resume
    // from where it was, and an unchanged cursor means the next attempt replays.
    await db.mailAccount.update({
      where: { id: mailAccountId },
      data: {
        syncStatus: "ERROR",
        syncError: errorSummary(error),
      },
    });
    log.error({ err: error, ...progress }, "backfill failed");
    throw error;
  }
}

/** A short, safe description for `syncError`, which is shown to the user. */
function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown sync failure";
  return message.slice(0, 500);
}

/**
 * Writes one thread and its messages in a single transaction.
 *
 * A thread is the atomic unit on purpose: small transactions keep locks short over
 * a run of thousands, and a half-written thread is never visible to a reader.
 */
export async function persistThread(
  db: ReturnType<typeof dbForUser>,
  mailAccountId: string,
  thread: RawThread,
): Promise<number> {
  const messages = thread.messages;
  const last = messages[messages.length - 1] as RawMessage;
  const first = messages[0] as RawMessage;

  const labels = [...new Set(messages.flatMap((message) => message.labels))];
  const threadFields = {
    subject: last.subject,
    snippet: last.snippet,
    participants: threadParticipants(messages) as unknown as Prisma.InputJsonValue,
    messageCount: messages.length,
    firstMessageAt: first.sentAt,
    lastMessageAt: last.sentAt,
    // A thread is unread if any message in it is.
    isRead: messages.every((message) => message.isRead),
    isStarred: labels.includes("STARRED"),
    // Gmail models "archived" as absence of INBOX rather than a label of its own.
    isArchived: !labels.includes("INBOX") && !labels.includes("TRASH"),
    isTrashed: labels.includes("TRASH"),
    providerLabels: labels,
  };

  return db.$transaction(async (tx) => {
    const row = await tx.thread.upsert({
      where: {
        mailAccountId_providerThreadId: {
          mailAccountId,
          providerThreadId: thread.providerThreadId,
        },
      },
      create: {
        mailAccountId,
        providerThreadId: thread.providerThreadId,
        ...threadFields,
      },
      update: threadFields,
      select: { id: true },
    });

    for (const message of messages) {
      const messageFields = {
        threadId: row.id,
        mailAccountId,
        internetMessageId: message.internetMessageId,
        fromName: message.from.name ?? null,
        fromEmail: message.from.email,
        to: message.to.map(formatAddress),
        cc: message.cc.map(formatAddress),
        bcc: message.bcc.map(formatAddress),
        replyTo: message.replyTo ? formatAddress(message.replyTo) : null,
        subject: message.subject,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
        snippet: message.snippet,
        sentAt: message.sentAt,
        isRead: message.isRead,
        isOutbound: message.isOutbound,
        isDraft: message.isDraft,
        hasAttachments: message.hasAttachments,
        headers: message.headers as unknown as Prisma.InputJsonValue,
        authResults: message.authResults as unknown as Prisma.InputJsonValue,
        contentHash: message.contentHash,
      };

      const saved = await tx.message.upsert({
        where: {
          mailAccountId_providerMessageId: {
            mailAccountId,
            providerMessageId: message.providerMessageId,
          },
        },
        create: { providerMessageId: message.providerMessageId, ...messageFields },
        update: messageFields,
        select: { id: true },
      });

      // Attachment metadata has no natural key of its own, so it is replaced
      // wholesale — cheaper than diffing, and idempotent either way.
      await tx.attachment.deleteMany({ where: { messageId: saved.id } });
      if (message.attachments.length > 0) {
        await tx.attachment.createMany({
          data: message.attachments.map((attachment) => ({
            messageId: saved.id,
            providerAttachmentId: attachment.providerAttachmentId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            isInline: attachment.isInline,
            riskFlag: riskFlagFor(attachment.filename, attachment.mimeType),
          })),
        });
      }
    }

    return messages.length;
  });
}

function formatAddress(address: { name?: string; email: string }): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

/**
 * Deterministic attachment risk tag (§6, layer 1). Extension-based on purpose:
 * the MIME type is supplied by the sender and lies, the extension is what the
 * user's OS will act on.
 */
const EXECUTABLE_EXTENSIONS = /\.(exe|scr|com|pif|bat|cmd|js|jse|vbs|vbe|wsf|hta|jar|msi|ps1|lnk|apk|dmg)$/i;
const MACRO_EXTENSIONS = /\.(docm|xlsm|pptm|dotm|xltm|xlam)$/i;
const ARCHIVE_EXTENSIONS = /\.(zip|rar|7z|tar|gz|bz2|iso|cab)$/i;

export function riskFlagFor(filename: string, _mimeType: string): string | null {
  if (EXECUTABLE_EXTENSIONS.test(filename)) return "executable";
  if (MACRO_EXTENSIONS.test(filename)) return "macro";
  if (ARCHIVE_EXTENSIONS.test(filename)) return "archive";
  return null;
}
