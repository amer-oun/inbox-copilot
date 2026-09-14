import { dbForUser } from "@inbox-copilot/db";
import type { SendResultDto } from "@inbox-copilot/shared";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { mailProviderFor } from "../providers/registry.js";
import type { RawAddress } from "../providers/mailProvider.js";

/**
 * Sending (rule 1, and the reason the rest of the AI layer is shaped the way it is).
 *
 * This function is the only path in the application that puts mail on the wire, and
 * everything about its signature is deliberate:
 *
 *   - it takes `body` — the text the user read in the composer and submitted. It
 *     does not take a draft id to look up and send, does not take a tone, and has no
 *     access to the model. There is no code path from "generate" to "send" that does
 *     not pass through a person;
 *   - the recipients are computed here, from the parent message's own headers. No
 *     caller supplies them, so nothing a model or an email body says can add one;
 *   - `draftId` is feedback only. If it does not match the thread it is ignored
 *     rather than trusted, and it never influences what is sent.
 */

/**
 * The fields that decide who a reply goes to.
 *
 * Narrower than the whole parent message, and exported, because the thread read uses
 * it too: the composer shows the recipient *before* the user presses send, and it must
 * be the same answer this file will act on rather than a second guess at it.
 */
export interface ReplyTarget {
  fromName: string | null;
  fromEmail: string;
  to: string[];
  replyTo: string | null;
  isOutbound: boolean;
}

/** Threading and recipient facts about the message being replied to. */
interface ParentMessage extends ReplyTarget {
  id: string;
  internetMessageId: string | null;
  subject: string | null;
  cc: string[];
  headers: unknown;
}

export interface SendReplyInput {
  userId: string;
  threadId: string;
  /** Exactly what the user submitted. Plain text. */
  body: string;
  /** Which offered draft this came from, for `wasUsed`/`editedBody`. */
  draftId?: string;
  signal?: AbortSignal;
}

/**
 * Parses `"Ada Lovelace <ada@example.com>"` back into parts.
 *
 * `Message.to`/`cc` store the formatted form, so replying means undoing that. The
 * last `<…>` wins: a display name is allowed to contain an address, and taking the
 * first match would let `"billing@bank.example <attacker@evil.example>"` be read as
 * the bank.
 */
export function parseFormattedAddress(value: string): RawAddress | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const angle = trimmed.lastIndexOf("<");
  if (angle !== -1 && trimmed.endsWith(">")) {
    const email = trimmed.slice(angle + 1, -1).trim();
    const name = trimmed.slice(0, angle).trim().replace(/^"|"$/g, "");
    if (email === "") return null;
    return name === "" ? { email } : { name, email };
  }

  return { email: trimmed };
}

/**
 * Who a reply goes to.
 *
 * The narrow choice on purpose: the sender of the message being answered, and
 * nobody else. Not reply-all — silently copying a mailing list is the kind of
 * mistake an assistant should not make on the user's behalf, and the widest thing
 * this code can do wrong is add a recipient. `Reply-To` is honoured because that is
 * what it is for, even though it is also how a phishing mail redirects an answer;
 * the user sees the address in the composer before they send.
 *
 * When the parent is the user's own message (the user replying to their own last
 * word in a thread), the answer goes to whoever that message was addressed to.
 */
export function replyRecipients(
  parent: ReplyTarget,
  mailboxAddress: string,
): RawAddress[] {
  const mailbox = mailboxAddress.toLowerCase();

  if (parent.isOutbound) {
    const recipients = parent.to
      .map(parseFormattedAddress)
      .filter((address): address is RawAddress => address !== null)
      .filter((address) => address.email.toLowerCase() !== mailbox);
    if (recipients.length > 0) return recipients;
  }

  const replyTo = parent.replyTo === null ? null : parseFormattedAddress(parent.replyTo);
  if (replyTo !== null && replyTo.email.toLowerCase() !== mailbox) return [replyTo];

  const from = parent.fromName
    ? { name: parent.fromName, email: parent.fromEmail }
    : { email: parent.fromEmail };

  if (from.email.toLowerCase() === mailbox) {
    // The only message in the thread is the user's own, sent to nobody we can read.
    throw new BadRequestError("Cannot work out who to reply to in this thread");
  }

  return [from];
}

/** `Re: ` once, however many times the thread has already been round. */
export function replySubject(subject: string | null): string {
  const base = (subject ?? "").trim();
  if (base === "") return "Re:";
  return /^re\s*:/i.test(base) ? base : `Re: ${base}`;
}

/**
 * The `References` chain for the reply: the parent's chain, then the parent itself.
 *
 * Read out of the stored `headers` blob, which the sync engine keeps for exactly
 * this (`map.ts:HEADERS_WORTH_KEEPING`). Bounded at 20 entries — RFC 5322 allows a
 * 998-character line, long threads exceed it, and receivers that truncate an
 * over-long header break threading for everyone in the conversation. Keeping the
 * oldest and the newest is what clients do, because the first message is what most
 * of them thread on.
 */
export function referencesChain(parent: ParentMessage): string[] {
  const headers =
    typeof parent.headers === "object" && parent.headers !== null
      ? (parent.headers as Record<string, unknown>)
      : {};

  const raw = headers["references"];
  const existing =
    typeof raw === "string" ? raw.split(/\s+/).filter((id) => id.startsWith("<")) : [];

  const chain = [...existing];
  if (parent.internetMessageId !== null) chain.push(parent.internetMessageId);

  if (chain.length <= 20) return chain;
  return [...chain.slice(0, 3), ...chain.slice(-17)];
}

/** The user's plain text as HTML. Escaped, not rendered: this is text, not markup. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
    .join("\n");

  return `<div dir="auto">${paragraphs}</div>`;
}

/**
 * Sends a reply the user wrote.
 *
 * There is no transaction around the send, because there cannot be one: the mail
 * leaves the building at the provider, and no local rollback can recall it. So the
 * ordering is chosen for what is recoverable — send first, then record. A send that
 * succeeds while the feedback write fails loses a `wasUsed` flag; the reverse would
 * record a send that never happened.
 *
 * The sent message itself is not written to `Message` here. The sync engine owns
 * that table, and the next delta brings the real row with the provider's own ids,
 * `Message-ID` and timestamp. A row fabricated here would be a second source of
 * truth that disagrees with Gmail about what was sent.
 */
export async function sendReply(input: SendReplyInput): Promise<SendResultDto> {
  const body = input.body.trim();
  if (body === "") throw new BadRequestError("A reply needs a body");

  const db = dbForUser(input.userId);

  const thread = await db.thread.findFirst({
    where: { id: input.threadId },
    select: {
      id: true,
      providerThreadId: true,
      mailAccountId: true,
      mailAccount: { select: { emailAddress: true, provider: true } },
      messages: {
        orderBy: { sentAt: "desc" },
        take: 1,
        select: {
          id: true,
          internetMessageId: true,
          subject: true,
          fromName: true,
          fromEmail: true,
          to: true,
          cc: true,
          replyTo: true,
          headers: true,
          isOutbound: true,
        },
      },
    },
  });

  if (!thread) throw new NotFoundError("Thread not found");

  const parent = thread.messages[0] as ParentMessage | undefined;
  if (parent === undefined) throw new NotFoundError("Thread has no messages");

  const mailboxAddress = thread.mailAccount.emailAddress;
  const to = replyRecipients(parent, mailboxAddress);

  const log = logger.child({
    userId: input.userId,
    mailAccountId: thread.mailAccountId,
    threadId: thread.id,
  });

  const provider = mailProviderFor(thread.mailAccount.provider, {
    mailAccountId: thread.mailAccountId,
    userId: input.userId,
    emailAddress: mailboxAddress,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const references = referencesChain(parent);

  const sent = await provider.sendMessage({
    to,
    // No Cc and no Bcc: see `replyRecipients`.
    subject: replySubject(parent.subject),
    bodyText: body,
    bodyHtml: textToHtml(body),
    ...(parent.internetMessageId === null
      ? {}
      : {
          inReplyTo: {
            providerThreadId: thread.providerThreadId,
            internetMessageId: parent.internetMessageId,
            references,
          },
        }),
  });

  const feedback = await recordDraftFeedback({
    userId: input.userId,
    threadId: thread.id,
    body,
    ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
  });

  log.info(
    {
      providerMessageId: sent.providerMessageId,
      recipients: to.length,
      threadedOn: parent.internetMessageId === null ? "threadId-only" : "in-reply-to",
      references: references.length,
      usedDraftId: feedback.usedDraftId,
      edited: feedback.edited,
      bodyChars: body.length,
    },
    "reply sent",
  );

  return {
    providerMessageId: sent.providerMessageId,
    providerThreadId: sent.providerThreadId,
    sentAt: new Date().toISOString(),
    usedDraftId: feedback.usedDraftId,
    edited: feedback.edited,
  };
}

/**
 * Records that a draft was used, and how far it was edited (§5's feedback signal).
 *
 * Never throws. This runs *after* the mail has gone out, and a failed bookkeeping
 * write must not turn a successful send into an error the user will read as "it did
 * not send" — the one thing worse than losing the signal is the user sending twice.
 */
async function recordDraftFeedback(input: {
  userId: string;
  threadId: string;
  body: string;
  draftId?: string;
}): Promise<{ usedDraftId: string | null; edited: boolean }> {
  if (input.draftId === undefined) return { usedDraftId: null, edited: false };

  try {
    const db = dbForUser(input.userId);

    // Scoped to the thread as well as the id: a draft id from another thread is a
    // caller bug or a probe, and either way it is not evidence about this send.
    const draft = await db.replyDraft.findFirst({
      where: { id: input.draftId, threadId: input.threadId },
      select: { id: true, body: true },
    });

    if (!draft) {
      logger.warn(
        { userId: input.userId, threadId: input.threadId, draftId: input.draftId },
        "send referenced a draft that does not belong to this thread; ignoring it",
      );
      return { usedDraftId: null, edited: false };
    }

    const edited = draft.body.trim() !== input.body;

    await db.replyDraft.update({
      where: { id: draft.id },
      data: {
        wasUsed: true,
        // Only when it differs: `editedBody` answers "what did the user change",
        // and storing an identical copy would make every send look edited.
        ...(edited ? { editedBody: input.body } : {}),
      },
    });

    return { usedDraftId: draft.id, edited };
  } catch (error) {
    logger.error(
      { err: error, userId: input.userId, threadId: input.threadId },
      "could not record reply draft feedback after a successful send",
    );
    return { usedDraftId: null, edited: false };
  }
}
