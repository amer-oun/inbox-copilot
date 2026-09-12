import { htmlToText } from "../../lib/html.js";
import type { UntrustedEmailInput } from "./prompts.js";

/**
 * Turning a stored message into prompt input.
 *
 * Two jobs: pick the text (plain body, or text extracted from the HTML part — never
 * raw HTML, §7 rule 5) and bound its size. Nothing here neutralizes delimiters; that
 * happens once, in `untrustedEmailBlock`, so there is a single place where it can be
 * verified rather than several that each have to remember.
 */

/**
 * Per-message ceiling. Long enough for real correspondence, short enough that one
 * pathological message cannot dominate a bill — a 2MB newsletter is not 2MB of
 * signal, and the fields we extract are decided in the first screenful.
 */
export const MAX_BODY_CHARS = 12_000;

/** Whole-thread ceiling, applied oldest-first so recent messages survive. */
export const MAX_THREAD_CHARS = 40_000;

/** §5: the threshold at which a thread is worth summarizing. */
export const SUMMARY_MIN_MESSAGES = 3;
export const SUMMARY_MIN_BODY_CHARS = 1_500;

export interface MessageForPrompt {
  id: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string;
  to: string[];
  cc: string[];
  replyTo: string | null;
  sentAt: Date;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  isOutbound: boolean;
  hasAttachments: boolean;
  contentHash: string;
}

/** Truncates with a visible marker, so the model knows the text is cut off. */
export function truncateForPrompt(text: string, maxChars: number = MAX_BODY_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated, ${text.length - maxChars} more characters]`;
}

/**
 * The best plain text available for a message.
 *
 * `bodyText` is already normalized by the sync engine; the HTML path is a fallback
 * for rows written before that, and the snippet is a last resort so a body-less
 * message still classifies as *something* rather than failing the job.
 */
export function promptBody(message: MessageForPrompt): string {
  const text =
    message.bodyText ??
    (message.bodyHtml === null ? null : htmlToText(message.bodyHtml)) ??
    message.snippet ??
    "";

  return truncateForPrompt(text.trim());
}

/**
 * Envelope facts worth giving the model.
 *
 * Chosen for classification value, and kept small because every field is billed:
 * who sent it, who it was sent to, when, whether the user sent it, and whether the
 * `Reply-To` disagrees with the `From` — a signal the model should weigh even
 * before §6's deterministic checks land in phase 9.
 */
export function promptMetadata(
  message: MessageForPrompt,
  mailboxAddress: string,
): UntrustedEmailInput["metadata"] {
  const replyToDiffers =
    message.replyTo !== null &&
    !message.replyTo.toLowerCase().includes(message.fromEmail.toLowerCase());

  return {
    from: message.fromName
      ? `${message.fromName} <${message.fromEmail}>`
      : message.fromEmail,
    to: message.to.join(", "),
    cc: message.cc.join(", "),
    subject: message.subject ?? "(no subject)",
    sent_at: message.sentAt.toISOString(),
    mailbox_owner: mailboxAddress,
    sent_by_mailbox_owner: message.isOutbound,
    has_attachments: message.hasAttachments,
    ...(replyToDiffers ? { reply_to_differs_from_from: message.replyTo } : {}),
  };
}

export function messageForPrompt(
  message: MessageForPrompt,
  mailboxAddress: string,
): UntrustedEmailInput {
  return {
    metadata: promptMetadata(message, mailboxAddress),
    body: promptBody(message),
  };
}

/**
 * Whether a thread is worth summarizing (§5): three or more messages, or a single
 * body long enough that a reader wants the short version.
 */
export function needsSummary(messages: readonly MessageForPrompt[]): boolean {
  if (messages.length >= SUMMARY_MIN_MESSAGES) return true;
  return messages.some(
    (message) => (message.bodyText ?? message.snippet ?? "").length > SUMMARY_MIN_BODY_CHARS,
  );
}

/**
 * Thread text for the summarizer, trimmed to the whole-thread budget.
 *
 * When a thread is too long, the *oldest* messages are dropped rather than the
 * newest: a summary that misses how a conversation started is imperfect, one that
 * misses how it currently stands is wrong.
 */
export function threadForPrompt(
  messages: readonly MessageForPrompt[],
  mailboxAddress: string,
): UntrustedEmailInput[] {
  const blocks: UntrustedEmailInput[] = [];
  let budget = MAX_THREAD_CHARS;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as MessageForPrompt;
    const block = messageForPrompt(message, mailboxAddress);
    const cost = block.body.length;

    if (cost > budget && blocks.length > 0) break;
    budget -= cost;
    blocks.unshift(block);
  }

  return blocks;
}
