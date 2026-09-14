import { BadRequestError } from "../../lib/errors.js";

/**
 * RFC 5322 message construction for sending.
 *
 * Gmail's `messages.send` takes a complete raw message, so threading, encoding and
 * header safety are all ours to get right. The three things that actually matter:
 *
 *   1. **Threading.** A reply is part of a conversation only if it carries
 *      `In-Reply-To` and `References` pointing at the message it answers. Gmail's
 *      own `threadId` is not enough: it groups the message in *this* mailbox, while
 *      every other participant's client threads on those two headers. Get them
 *      wrong and the reply appears to everyone else as a new conversation.
 *   2. **Header injection.** A header value containing CRLF ends the header and
 *      starts another — that is how a subject line becomes a `Bcc`. Every value is
 *      checked here, once, at the only place that writes headers.
 *   3. **Encoding.** Bodies are base64 with an explicit UTF-8 charset, so nothing
 *      depends on line length or on the text being ASCII, and non-ASCII header
 *      values become RFC 2047 encoded-words rather than mojibake.
 *
 * Provider-agnostic on purpose (nothing here imports `googleapis`): Outlook's Graph
 * send takes JSON rather than MIME, but scheduled sends and `.eml` export will want
 * exactly this.
 */

/**
 * A NUL byte, built rather than escaped.
 *
 * Named constant because the escape form of it, written into a regex, is how a
 * real NUL byte ended up in this file once already.
 */
const NUL = String.fromCharCode(0);

/** RFC 5322: lines are CRLF-separated. */
const CRLF = "\r\n";

export interface MimeAddress {
  name?: string | undefined;
  email: string;
}

export interface MimeMessageInput {
  from: MimeAddress;
  to: readonly MimeAddress[];
  cc?: readonly MimeAddress[];
  bcc?: readonly MimeAddress[];
  subject: string;
  /** Plain-text alternative. Always sent: a text/html-only mail is a spam signal. */
  text: string;
  html: string;
  /** The parent's `Message-ID`, angle brackets included. */
  inReplyTo?: string;
  /** The chain: the parent's `References`, then the parent's own `Message-ID`. */
  references?: readonly string[];
}

/**
 * Rejects a header value that could inject a header.
 *
 * A throw rather than a silent strip: these values come from stored provider headers
 * and from the user, and a CR in either means something has gone wrong upstream that
 * should be visible, not quietly repaired. `subject` is the one exception — see
 * `foldSubject`.
 */
function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n]/.test(value) || value.includes(NUL)) {
    throw new BadRequestError(`Illegal line break in ${field}`);
  }
}

/**
 * The same check for a value we have already folded ourselves.
 *
 * "No CRLF at all" is the wrong rule for a finished header: RFC 5322 *requires*
 * folding of long values, and both `References` on a deep thread and a long
 * non-ASCII display name exceed the line limit. What must not appear is a line break
 * that is not a fold — one not followed by whitespace — because that is the break
 * that ends our header and starts the attacker's. So the folds are collapsed and the
 * strict rule is applied to what is left.
 *
 * The distinction cost a test before it existed: the first version rejected its own
 * `References` fold.
 */
function assertFoldedHeaderSafe(field: string, value: string): void {
  assertHeaderSafe(field, value.replace(/\r\n[ \t]/g, " "));
}

/**
 * An address, validated and formatted.
 *
 * The address itself must look like an address and must not carry the syntax of the
 * header it is going into: a `,` would silently add a recipient, and `<`/`>` would
 * let a display name close the angle-addr and open another.
 */
export function formatMimeAddress(address: MimeAddress): string {
  const email = address.email.trim();

  if (!/^[^\s<>,;:"()[\]\\]+@[^\s<>,;:"()[\]\\]+\.[^\s<>,;:"()[\]\\]+$/.test(email)) {
    throw new BadRequestError(`Invalid email address: ${email}`);
  }

  const name = address.name?.trim();
  if (name === undefined || name === "") return email;

  assertHeaderSafe("display name", name);
  return `${encodeDisplayName(name)} <${email}>`;
}

/** True when every character is printable US-ASCII, which is what headers allow raw. */
function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^ -~]/.test(value);
}

/**
 * RFC 2047 encoded-word, base64 form.
 *
 * Chunked so no encoded-word exceeds 75 characters, and chunked on *code points*
 * rather than bytes — splitting mid-character produces a word that decodes to a
 * replacement glyph, which is the bug this is easy to write.
 */
export function encodeWord(value: string): string {
  const prefix = "=?UTF-8?B?";
  const suffix = "?=";
  // Base64 of 3 bytes is 4 characters, so this is the byte budget per word.
  const maxBytes = Math.floor(((75 - prefix.length - suffix.length) / 4) * 3);

  const words: string[] = [];
  let chunk = Buffer.alloc(0);

  for (const char of value) {
    const bytes = Buffer.from(char, "utf8");
    if (chunk.length + bytes.length > maxBytes && chunk.length > 0) {
      words.push(`${prefix}${chunk.toString("base64")}${suffix}`);
      chunk = Buffer.alloc(0);
    }
    chunk = Buffer.concat([chunk, bytes]);
  }
  if (chunk.length > 0) words.push(`${prefix}${chunk.toString("base64")}${suffix}`);

  // Folded with CRLF + space: adjacent encoded-words on a continuation line are
  // joined without the whitespace between them, which is what RFC 2047 requires.
  return words.join(`${CRLF} `);
}

/** A display name: quoted when it needs it, encoded when it is not ASCII. */
function encodeDisplayName(name: string): string {
  if (!isAscii(name)) return encodeWord(name);
  // `"` and `\` have to be escaped inside a quoted-string.
  return `"${name.replace(/([\\"])/g, "\\$1")}"`;
}

/**
 * The subject, made safe and then encoded.
 *
 * Unlike every other header, a line break here is collapsed rather than rejected:
 * subjects are typed and pasted by people, a newline in one is a formatting
 * accident rather than an attack, and refusing to send over it would be hostile.
 * Collapsing it is exactly as safe — the value can no longer end the header.
 */
export function foldSubject(subject: string): string {
  const single = subject.replace(/[\r\n]+/g, " ").split(NUL).join("").trim();
  return isAscii(single) ? single : encodeWord(single);
}

/**
 * Folds a space-separated header value onto continuation lines, but only once it
 * needs it.
 *
 * RFC 5322 limits a line to 998 octets and recommends 78. A `References` chain on a
 * deep thread passes both, and receivers that truncate an over-long header break
 * threading for everyone in the conversation. Folding unconditionally would be
 * correct too, but a two-line `References` header on a two-message thread is noise in
 * every raw message a human ever reads.
 */
export function foldHeaderLine(field: string, value: string, width = 78): string {
  const tokens = value.split(" ").filter((token) => token !== "");
  const lines: string[] = [];
  // The field name counts toward the first line's budget — measuring only the value
  // is how a "78-character" header comes out 90 characters long.
  let line = `${field}:`;

  for (const token of tokens) {
    // A token longer than the whole width still goes on the current line: it cannot be
    // broken (a split Message-ID is a different id), and a line holding only the field
    // name would be folding for nothing.
    if (line.length + 1 + token.length <= width || line === `${field}:`) {
      line = `${line} ${token}`;
    } else {
      lines.push(line);
      line = token;
    }
  }
  if (line !== "") lines.push(line);

  return lines.join(`${CRLF} `);
}

/** Base64, wrapped at 76 characters as RFC 2045 requires. */
function base64Body(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return (encoded.match(/.{1,76}/g) ?? [""]).join(CRLF);
}

/**
 * A MIME boundary that cannot occur in the content.
 *
 * Random rather than derived from the body: a boundary that appears in the body
 * truncates the message, and checking for that is strictly worse than making it
 * improbable. The prefix makes the source obvious in a raw message.
 */
function makeBoundary(): string {
  const random = Buffer.from(
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
  ).toString("hex");
  return `--=_inbox_copilot_${random}`;
}

/**
 * Builds the complete message.
 *
 * No `Message-ID` and no `Date`: Gmail stamps both on accept, and a `Message-ID`
 * minted here would have to claim a domain we do not control. `Bcc` *is* written —
 * Gmail strips it from the copy recipients receive, and omitting it would silently
 * drop the blind recipients instead of hiding them.
 */
export function buildMimeMessage(input: MimeMessageInput): string {
  const headers: string[] = [];

  const addHeader = (field: string, value: string): void => {
    assertFoldedHeaderSafe(field, value);
    headers.push(`${field}: ${value}`);
  };

  if (input.to.length === 0) {
    throw new BadRequestError("A message needs at least one recipient");
  }

  addHeader("From", formatMimeAddress(input.from));
  addHeader("To", input.to.map(formatMimeAddress).join(", "));
  if (input.cc && input.cc.length > 0) {
    addHeader("Cc", input.cc.map(formatMimeAddress).join(", "));
  }
  if (input.bcc && input.bcc.length > 0) {
    addHeader("Bcc", input.bcc.map(formatMimeAddress).join(", "));
  }
  headers.push(`Subject: ${foldSubject(input.subject)}`);

  if (input.inReplyTo !== undefined && input.inReplyTo !== "") {
    addHeader("In-Reply-To", input.inReplyTo);
  }
  if (input.references && input.references.length > 0) {
    for (const id of input.references) assertHeaderSafe("References", id);
    const folded = foldHeaderLine("References", input.references.join(" "));
    assertFoldedHeaderSafe("References", folded);
    headers.push(folded);
  }

  const boundary = makeBoundary();
  headers.push("MIME-Version: 1.0");
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.html),
    `--${boundary}--`,
    "",
  ];

  return [...headers, "", ...parts].join(CRLF);
}

/** Gmail wants the raw message base64url-encoded, unpadded-safe. */
export function encodeMimeForGmail(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}
