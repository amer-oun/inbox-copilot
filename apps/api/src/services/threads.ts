import { dbForUser } from "@inbox-copilot/db";
import {
  threadDetailSchema,
  threadListSchema,
  type AddressDto,
  type MessageDto,
  type ThreadCategoryFilter,
  type ThreadDetailDto,
  type ThreadListDto,
} from "@inbox-copilot/shared";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { sanitizeEmailHtml } from "./security/sanitize.js";
import { threatAssessmentFor, THREAT_READ_SELECT } from "./security/read.js";
import { replyRecipients, type ReplyTarget } from "./send.js";

/**
 * Inbox reads (ARCHITECTURE §1). Every query goes through `dbForUser`, so the
 * tenancy extension puts `mailAccount.userId` into the `where` for us (rule 4).
 *
 * The ordering — priority score first, then recency — is the product decision that
 * makes this an assistant rather than a mail client. It is also what makes
 * pagination interesting: see `decodeCursor`.
 */

/** Threads per page when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * A keyset cursor: the sort key of the last row of the previous page.
 *
 * Offset pagination would be wrong here, not just slow — the list is sorted by a
 * score the enrichment worker is still writing, so rows move between requests and
 * `skip` would drop or repeat threads. A keyset cursor describes a *position in the
 * ordering*, which stays meaningful while neighbours change.
 *
 * `score` is nullable because an unenriched thread has no priority yet, and those
 * sort last.
 */
interface Cursor {
  score: number | null;
  lastMessageAt: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decodes a cursor, rejecting anything malformed.
 *
 * Cursors come from the browser, so this is untrusted input: a bad one must be a
 * 400 rather than a crash or — worse — a silently unfiltered query.
 */
export function decodeCursor(value: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestError("Invalid cursor");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new BadRequestError("Invalid cursor");
  }

  const { score, lastMessageAt, id } = parsed as Record<string, unknown>;
  const scoreOk = score === null || (typeof score === "number" && Number.isInteger(score));
  const dateOk = typeof lastMessageAt === "string" && !Number.isNaN(Date.parse(lastMessageAt));

  if (!scoreOk || !dateOk || typeof id !== "string" || id === "") {
    throw new BadRequestError("Invalid cursor");
  }

  return { score: score as number | null, lastMessageAt, id };
}

/**
 * "Strictly after this cursor" in `(priorityScore DESC NULLS LAST, lastMessageAt
 * DESC, id DESC)` order, as a Prisma filter.
 *
 * Written out rather than expressed as raw SQL so the tenancy extension still
 * injects the owner filter. The null handling is the fiddly half: with NULLS LAST,
 * a row with no score comes after every scored row, so
 *   - from a scored cursor, the next page is lower scores, later ties, *and* every
 *     unscored row;
 *   - from an unscored cursor, only unscored rows remain.
 */
function afterCursor(cursor: Cursor): object {
  const tieBreak = [
    { lastMessageAt: { lt: new Date(cursor.lastMessageAt) } },
    { lastMessageAt: new Date(cursor.lastMessageAt), id: { lt: cursor.id } },
  ];

  if (cursor.score === null) {
    return { priorityScore: null, OR: tieBreak };
  }

  return {
    OR: [
      { priorityScore: { lt: cursor.score } },
      { priorityScore: cursor.score, OR: tieBreak },
      // Unscored threads sort after all scored ones.
      { priorityScore: null },
    ],
  };
}

const LIST_SELECT = {
  id: true,
  subject: true,
  snippet: true,
  messageCount: true,
  lastMessageAt: true,
  isRead: true,
  isStarred: true,
  category: true,
  priority: true,
  priorityScore: true,
  needsReply: true,
  language: true,
  threatLevel: true,
  /*
   * The newest inbound message supplies the row's sender and attachment flag —
   * the row should say who wrote to *you*, not echo your own last reply.
   * `take: 1` per thread, which Prisma issues as one extra query for the page.
   */
  messages: {
    where: { isOutbound: false },
    orderBy: { sentAt: "desc" as const },
    take: 1,
    select: { fromName: true, fromEmail: true, hasAttachments: true },
  },
  /** Newest summary; the list only needs its headline. */
  summaries: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: { headline: true },
  },
} as const;

interface ListThreadsInput {
  userId: string;
  category: ThreadCategoryFilter;
  cursor?: string;
  limit?: number;
}

export async function listThreads(input: ListThreadsInput): Promise<ThreadListDto> {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);

  const rows = await dbForUser(input.userId).thread.findMany({
    where: {
      ...(input.category === "ALL" ? {} : { category: input.category }),
      // Trash is not "a category with nothing in it"; it is mail the user threw away.
      isTrashed: false,
      ...(cursor === null ? {} : afterCursor(cursor)),
    },
    orderBy: [
      { priorityScore: { sort: "desc", nulls: "last" } },
      { lastMessageAt: "desc" },
      { id: "desc" },
    ],
    // One extra row is how we know whether a next page exists without counting.
    take: limit + 1,
    select: LIST_SELECT,
  });

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return threadListSchema.parse({
    items: page.map((row) => {
      const newest = row.messages[0];
      return {
        id: row.id,
        subject: row.subject,
        snippet: row.snippet,
        from: newest
          ? { name: newest.fromName, email: newest.fromEmail }
          : null,
        messageCount: row.messageCount,
        lastMessageAt: row.lastMessageAt.toISOString(),
        isRead: row.isRead,
        isStarred: row.isStarred,
        hasAttachments: newest?.hasAttachments ?? false,
        category: row.category,
        priority: row.priority,
        priorityScore: row.priorityScore,
        needsReply: row.needsReply,
        language: row.language,
        threatLevel: row.threatLevel,
        summaryHeadline: row.summaries[0]?.headline ?? null,
      };
    }),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            score: last.priorityScore,
            lastMessageAt: last.lastMessageAt.toISOString(),
            id: last.id,
          })
        : null,
  });
}

function addressOf(name: string | null, email: string): AddressDto {
  return { name, email };
}

/**
 * One thread with its messages and summary.
 *
 * Bodies are sanitized here, on the way out, rather than at write time: the stored
 * row keeps what the sender actually sent (needed for the content hash, for
 * forwarding, and for re-checking against a better sanitizer later), and the
 * browser only ever receives cleaned HTML.
 */
export async function getThread(input: {
  userId: string;
  threadId: string;
}): Promise<ThreadDetailDto> {
  const row = await dbForUser(input.userId).thread.findFirst({
    where: { id: input.threadId },
    select: {
      id: true,
      subject: true,
      participants: true,
      messageCount: true,
      firstMessageAt: true,
      lastMessageAt: true,
      isRead: true,
      isStarred: true,
      category: true,
      priority: true,
      priorityScore: true,
      needsReply: true,
      language: true,
      threatLevel: true,
      mailAccount: { select: { emailAddress: true } },
      messages: {
        orderBy: { sentAt: "asc" },
        select: {
          id: true,
          fromName: true,
          fromEmail: true,
          to: true,
          cc: true,
          replyTo: true,
          subject: true,
          sentAt: true,
          isRead: true,
          isOutbound: true,
          bodyText: true,
          bodyHtml: true,
          ...THREAT_READ_SELECT,
          attachments: {
            select: {
              id: true,
              filename: true,
              mimeType: true,
              sizeBytes: true,
              isInline: true,
              riskFlag: true,
            },
          },
        },
      },
      summaries: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          headline: true,
          summary: true,
          keyPoints: true,
          actionItems: true,
          model: true,
          createdAt: true,
        },
      },
    },
  });

  if (!row) throw new NotFoundError("Thread not found");

  /*
   * One extra indexed read for the language control's default (§9). Deliberately not
   * folded into the thread query as a relation: `UserSettings` hangs off `User`, not off
   * the thread, and joining it through the mailbox to save a round trip would make the
   * thread read depend on a table it has no business knowing about.
   */
  const settings = await dbForUser(input.userId).userSettings.findFirst({
    where: { userId: input.userId },
    select: { translationLang: true },
  });

  const messages: MessageDto[] = row.messages.map((message) => {
    const sanitized = sanitizeEmailHtml(message.bodyHtml);
    return {
      id: message.id,
      from: addressOf(message.fromName, message.fromEmail),
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      sentAt: message.sentAt.toISOString(),
      isRead: message.isRead,
      isOutbound: message.isOutbound,
      bodyText: message.bodyText,
      bodyHtmlSanitized: sanitized?.html ?? null,
      blockedRemoteImages: sanitized?.blockedRemoteImages ?? 0,
      attachments: message.attachments,
    };
  });

  const summary = row.summaries[0];

  return threadDetailSchema.parse({
    replyRecipients: replyTargetsFor(row.messages, row.mailAccount.emailAddress),
    threat: threatAssessmentFor(row.messages),
    id: row.id,
    subject: row.subject,
    participants: parseParticipants(row.participants),
    messageCount: row.messageCount,
    firstMessageAt: row.firstMessageAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    isRead: row.isRead,
    isStarred: row.isStarred,
    category: row.category,
    priority: row.priority,
    priorityScore: row.priorityScore,
    needsReply: row.needsReply,
    language: row.language,
    threatLevel: row.threatLevel,
    defaultTranslationLang: settings?.translationLang ?? null,
    summary: summary
      ? {
          headline: summary.headline,
          summary: summary.summary,
          keyPoints: summary.keyPoints,
          actionItems: summary.actionItems,
          model: summary.model,
          createdAt: summary.createdAt.toISOString(),
        }
      : null,
    messages,
  });
}

/**
 * Who a reply to this thread would go to.
 *
 * Delegated to the send path's own function so the address shown in the composer is
 * the address that will actually be used. A thread with nobody to answer is an empty
 * list rather than an error: the user came here to read it.
 */
function replyTargetsFor(
  messages: readonly ReplyTarget[],
  mailboxAddress: string,
): AddressDto[] {
  const newest = messages.at(-1);
  if (newest === undefined) return [];

  try {
    return replyRecipients(newest, mailboxAddress).map((address) => ({
      name: address.name ?? null,
      email: address.email,
    }));
  } catch {
    return [];
  }
}

/**
 * `Thread.participants` is a JSON column written by the sync engine. It is our own
 * data, but it is shaped from sender-supplied headers, so it is read defensively:
 * a malformed row yields no participants rather than a 500 on a thread the user
 * just wanted to read.
 */
function parseParticipants(value: unknown): AddressDto[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, email } = entry as Record<string, unknown>;
    if (typeof email !== "string" || email === "") return [];
    return [{ name: typeof name === "string" && name !== "" ? name : null, email }];
  });
}
