import { createHash } from "node:crypto";
import { htmlToText } from "../../lib/html.js";
import type { gmail_v1 } from "googleapis";
import type {
  AuthVerdict,
  RawAddress,
  RawAttachment,
  RawAuthResults,
  RawMessage,
  RawThread,
} from "../mailProvider.js";

/**
 * Gmail payload → our rows. Pure functions only: no network, no Prisma, no clock
 * beyond what the payload carries, so every branch is testable from a fixture.
 *
 * Gmail's message shape is a MIME tree whose leaves hold base64url bodies, and
 * whose headers are an unordered array. Everything awkward about it is confined
 * to this file — §3: the AI layer and UI never branch on provider.
 */

/** Header lookup is case-insensitive per RFC 5322, and Gmail's casing varies. */
function headerMap(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers ?? []) {
    if (!header.name || header.value == null) continue;
    const key = header.name.toLowerCase();
    // First wins: a trace header like Received appears many times, and for the
    // headers we care about the topmost is the one added last (most recent hop).
    if (!map.has(key)) map.set(key, header.value);
  }
  return map;
}

/** Gmail uses base64url with padding stripped. */
export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Parses an address list. Deliberately hand-rolled rather than regex-per-address:
 * display names may contain commas and quoted strings ("Doe, Jane" <j@x>), so the
 * split has to respect quotes and angle brackets.
 */
export function parseAddressList(value: string | undefined): RawAddress[] {
  if (!value) return [];

  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngles = false;

  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "<" && !inQuotes) inAngles = true;
    else if (char === ">" && !inQuotes) inAngles = false;

    if (char === "," && !inQuotes && !inAngles) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts
    .map((part) => parseAddress(part))
    .filter((address): address is RawAddress => address !== null);
}

export function parseAddress(value: string | undefined): RawAddress | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const angled = /^(.*)<([^>]+)>\s*$/.exec(trimmed);
  if (angled) {
    const rawName = (angled[1] ?? "")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    const email = (angled[2] ?? "").trim().toLowerCase();
    if (email.length === 0) return null;
    return rawName.length > 0 ? { name: rawName, email } : { email };
  }

  // Bare address, possibly wrapped in quotes or followed by a (comment).
  const bare = trimmed
    .replace(/\(.*\)/g, "")
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return bare.length > 0 ? { email: bare.toLowerCase() } : null;
}

const VERDICTS: readonly AuthVerdict[] = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
];

function verdictFor(
  header: string,
  method: "spf" | "dkim" | "dmarc",
): AuthVerdict | null {
  // e.g. "mx.google.com; spf=pass (google.com: domain of ...) smtp.mailfrom=a@b;
  //       dkim=pass header.i=@b; dmarc=pass (p=REJECT sp=REJECT dis=NONE)"
  const match = new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, "i").exec(header);
  if (!match) return null;
  const value = (match[1] ?? "").toLowerCase();
  return (VERDICTS as readonly string[]).includes(value) ? (value as AuthVerdict) : null;
}

/**
 * Reads SPF/DKIM/DMARC out of `Authentication-Results`.
 *
 * Only the receiver's own header can be trusted — a forged copy can be added by
 * anyone upstream — so we read the first (topmost) instance, which Gmail adds, and
 * treat a missing verdict as `null`, never as a pass. Phase 9 turns these into a
 * threat score; here we only record them.
 */
export function parseAuthResults(
  headers: Map<string, string>,
  from: RawAddress | null,
): RawAuthResults {
  const header =
    headers.get("authentication-results") ??
    headers.get("arc-authentication-results") ??
    "";

  const returnPathHeader = headers.get("return-path");
  const returnPath = parseAddress(returnPathHeader)?.email ?? smtpMailFrom(header);

  return {
    spf: verdictFor(header, "spf"),
    dkim: verdictFor(header, "dkim"),
    dmarc: verdictFor(header, "dmarc"),
    returnPath: returnPath ?? null,
    displayNameMismatch: hasDisplayNameMismatch(from),
  };
}

function smtpMailFrom(header: string): string | null {
  const match = /smtp\.mailfrom=([^\s;()]+)/i.exec(header);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * A display name that itself contains an email address different from the real
 * From address — "billing@paypal.com" <attacker@evil.tld>. Cheap, deterministic,
 * and one of the highest-signal phishing tells (§6).
 */
export function hasDisplayNameMismatch(from: RawAddress | null): boolean {
  if (!from?.name) return false;
  const embedded = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(from.name);
  if (!embedded) return false;
  return embedded[0].toLowerCase() !== from.email.toLowerCase();
}

interface WalkResult {
  text: string | null;
  html: string | null;
  attachments: RawAttachment[];
}

/**
 * Depth-first walk of the MIME tree collecting the first text/plain and text/html
 * bodies plus every attachment.
 *
 * "First" is the right choice for multipart/alternative, where parts are ordered
 * simplest-first and later parts are the same content in richer form. Nested
 * multiparts (mixed wrapping alternative wrapping related) are why this recurses
 * rather than looking one level down.
 */
export function walkParts(payload: gmail_v1.Schema$MessagePart | undefined): WalkResult {
  const result: WalkResult = { text: null, html: null, attachments: [] };
  if (!payload) return result;

  const visit = (part: gmail_v1.Schema$MessagePart): void => {
    const mimeType = (part.mimeType ?? "").toLowerCase();
    const filename = part.filename ?? "";
    const body = part.body;
    const attachmentId = body?.attachmentId ?? null;
    const disposition = (
      headerMap(part.headers).get("content-disposition") ?? ""
    ).toLowerCase();

    // An attachment is anything with a filename, or any part Gmail stored
    // separately (attachmentId) that is not the body we are looking for.
    const isAttachment =
      filename.length > 0 || (attachmentId !== null && !mimeType.startsWith("text/"));

    if (isAttachment) {
      result.attachments.push({
        providerAttachmentId: attachmentId,
        filename: filename.length > 0 ? filename : `unnamed-${mimeType || "part"}`,
        mimeType: mimeType || "application/octet-stream",
        sizeBytes: body?.size ?? 0,
        // `inline` disposition, or a cid: reference target — a signature image
        // is not something to show the user as an attachment.
        isInline:
          disposition.includes("inline") ||
          part.headers?.some((header) => header.name?.toLowerCase() === "content-id") ===
            true,
      });
      // An inline part can still be a container (multipart/related); keep walking.
    } else if (mimeType === "text/plain" && result.text === null && body?.data) {
      result.text = decodeBase64Url(body.data);
    } else if (mimeType === "text/html" && result.html === null && body?.data) {
      result.html = decodeBase64Url(body.data);
    }

    for (const child of part.parts ?? []) visit(child);
  };

  visit(payload);
  return result;
}

/**
 * Normalizes a body for hashing: CRLF → LF, trailing whitespace stripped, runs of
 * blank lines collapsed.
 *
 * The hash is the AI cache key (rule 7), so it must be stable across the cosmetic
 * differences Gmail introduces between a message fetched twice (quoted-printable
 * re-wrapping, trailing newlines) or the cache will miss and we will pay twice.
 */
export function normalizeForHash(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** sha256 of the normalized plain-text body. */
export function computeContentHash(bodyText: string | null, fallback: string): string {
  const basis = normalizeForHash(bodyText ?? fallback);
  return createHash("sha256").update(basis, "utf8").digest("hex");
}

/** Re-exported from lib/html.ts, where both the sync and AI layers can reach it. */
export { htmlToText } from "../../lib/html.js";

const HEADERS_WORTH_KEEPING = new Set([
  "message-id",
  "in-reply-to",
  "references",
  "date",
  "subject",
  "from",
  "to",
  "cc",
  "reply-to",
  "return-path",
  "authentication-results",
  "received-spf",
  "list-unsubscribe",
  "precedence",
  "auto-submitted",
  "x-mailer",
]);

/**
 * Gmail's `internalDate` (ms since epoch, when Gmail received it) beats the `Date`
 * header, which is attacker-controlled and frequently wrong or absent.
 */
function sentAtOf(message: gmail_v1.Schema$Message, headers: Map<string, string>): Date {
  if (message.internalDate) {
    const ms = Number(message.internalDate);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms);
  }
  const dateHeader = headers.get("date");
  if (dateHeader) {
    const parsed = Date.parse(dateHeader);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  // Nothing usable: epoch would sort this to the top of the mailbox forever, so
  // use "now" and let a later delta correct it.
  return new Date();
}

export interface MapMessageContext {
  /** The mailbox's own address, for `isOutbound`. */
  mailboxAddress: string;
}

export function mapMessage(
  message: gmail_v1.Schema$Message,
  context: MapMessageContext,
): RawMessage {
  const headers = headerMap(message.payload?.headers);
  const from = parseAddress(headers.get("from")) ?? { email: "unknown@invalid" };
  const walked = walkParts(message.payload);
  const labels = message.labelIds ?? [];

  // Fall back to text extracted from the HTML part: a plain-text body is what the
  // content hash and every AI prompt are built from, so "no text/plain" cannot
  // mean "no text".
  const bodyText = walked.text ?? (walked.html === null ? null : htmlToText(walked.html));

  const mailbox = context.mailboxAddress.toLowerCase();

  return {
    providerMessageId: message.id ?? "",
    providerThreadId: message.threadId ?? "",
    internetMessageId: headers.get("message-id") ?? null,
    from,
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    bcc: parseAddressList(headers.get("bcc")),
    replyTo: parseAddress(headers.get("reply-to")),
    subject: headers.get("subject") ?? null,
    bodyText,
    bodyHtml: walked.html,
    snippet: message.snippet ?? null,
    sentAt: sentAtOf(message, headers),
    isRead: !labels.includes("UNREAD"),
    // SENT is authoritative for mail this mailbox sent; the address comparison
    // also catches messages copied in by a filter or imported from elsewhere.
    isOutbound: labels.includes("SENT") || from.email.toLowerCase() === mailbox,
    isDraft: labels.includes("DRAFT"),
    hasAttachments: walked.attachments.some((attachment) => !attachment.isInline),
    headers: Object.fromEntries(
      [...headers].filter(([name]) => HEADERS_WORTH_KEEPING.has(name)),
    ),
    authResults: parseAuthResults(headers, from),
    // `message.id` as the fallback basis keeps two empty-bodied messages from
    // colliding on one cache entry.
    contentHash: computeContentHash(bodyText, message.id ?? ""),
    attachments: walked.attachments,
    labels,
  };
}

export function mapThread(
  thread: gmail_v1.Schema$Thread,
  context: MapMessageContext,
): RawThread {
  const messages = (thread.messages ?? [])
    .map((message) => mapMessage(message, context))
    .filter((message) => message.providerMessageId.length > 0)
    // Gmail returns messages in order, but a delta-assembled thread may not be.
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  return {
    providerThreadId: thread.id ?? messages[0]?.providerThreadId ?? "",
    historyId: thread.historyId ?? null,
    messages,
  };
}

/** Participant list for `Thread.participants`, deduped by address. */
export function threadParticipants(
  messages: readonly RawMessage[],
): { name: string | null; email: string; role: "from" | "to" | "cc" }[] {
  const seen = new Map<
    string,
    { name: string | null; email: string; role: "from" | "to" | "cc" }
  >();

  const add = (address: RawAddress, role: "from" | "to" | "cc"): void => {
    const existing = seen.get(address.email);
    if (existing) {
      // Keep a name if we learn one later; "from" outranks the others.
      if (existing.name === null && address.name) existing.name = address.name;
      if (role === "from") existing.role = "from";
      return;
    }
    seen.set(address.email, { name: address.name ?? null, email: address.email, role });
  };

  for (const message of messages) {
    add(message.from, "from");
    for (const to of message.to) add(to, "to");
    for (const cc of message.cc) add(cc, "cc");
  }

  return [...seen.values()];
}
