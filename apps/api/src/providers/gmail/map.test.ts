import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";
import invoiceThread from "./__fixtures__/thread-invoice.json" with { type: "json" };
import suspiciousThread from "./__fixtures__/thread-suspicious.json" with { type: "json" };
import degenerateThread from "./__fixtures__/thread-degenerate.json" with { type: "json" };
import {
  computeContentHash,
  decodeBase64Url,
  hasDisplayNameMismatch,
  htmlToText,
  mapThread,
  normalizeForHash,
  parseAddress,
  parseAddressList,
  parseAuthResults,
  threadParticipants,
  walkParts,
} from "./map.js";

/**
 * Normalization is tested against recorded Gmail payloads (no live API — a test
 * that needs a network token is a test nobody runs). The fixtures are the real
 * response shapes: nested multipart/alternative inside multipart/mixed, inline
 * images alongside real attachments, and the degenerate message Gmail occasionally
 * returns with no headers at all.
 */

const MAILBOX = { mailboxAddress: "person@example.com" };

const invoice = mapThread(invoiceThread as gmail_v1.Schema$Thread, MAILBOX);
const suspicious = mapThread(suspiciousThread as gmail_v1.Schema$Thread, MAILBOX);

describe("address parsing", () => {
  it("splits a display name from the address and lowercases the address", () => {
    expect(parseAddress('"Acme Billing" <Accounts@Billing.Acme.Test>')).toEqual({
      name: "Acme Billing",
      email: "accounts@billing.acme.test",
    });
  });

  it("handles a bare address", () => {
    expect(parseAddress("ops@example.com")).toEqual({ email: "ops@example.com" });
  });

  it("keeps a comma inside a quoted display name in one address", () => {
    // The reason the splitter is quote-aware rather than a split on ",".
    expect(parseAddressList('"Doe, Jane" <jane@example.com>, ops@example.com')).toEqual([
      { name: "Doe, Jane", email: "jane@example.com" },
      { email: "ops@example.com" },
    ]);
  });

  it("ignores empty entries from a trailing comma", () => {
    expect(parseAddressList("a@x.test, ,")).toEqual([{ email: "a@x.test" }]);
  });

  it("returns an empty list for a missing header", () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe("base64url bodies", () => {
  it("decodes Gmail's unpadded base64url", () => {
    const encoded = Buffer.from("Hé — ok?", "utf8").toString("base64url");
    expect(decodeBase64Url(encoded)).toBe("Hé — ok?");
  });
});

describe("MIME tree walk", () => {
  it("finds text/plain and text/html nested inside multipart/alternative", () => {
    const walked = walkParts(
      (invoiceThread as gmail_v1.Schema$Thread).messages?.[0]?.payload,
    );
    expect(walked.text).toContain("the invoice for March is attached");
    expect(walked.html).toContain("<p>Hi there");
  });

  it("separates a real attachment from an inline image", () => {
    const walked = walkParts(
      (invoiceThread as gmail_v1.Schema$Thread).messages?.[0]?.payload,
    );
    expect(walked.attachments).toHaveLength(2);

    const inline = walked.attachments.find((a) => a.filename === "logo.png");
    const real = walked.attachments.find((a) => a.filename === "invoice-4471.pdf");
    expect(inline?.isInline).toBe(true);
    expect(real?.isInline).toBe(false);
    expect(real?.providerAttachmentId).toBe("ANGjdJ_pdf");
    expect(real?.sizeBytes).toBe(88213);
  });

  it("prefers the first text/plain part (alternative parts are simplest-first)", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("first").toString("base64url") },
        },
        {
          mimeType: "text/plain",
          body: { data: Buffer.from("second").toString("base64url") },
        },
      ],
    };
    expect(walkParts(payload).text).toBe("first");
  });

  it("survives a payload with no parts and no body", () => {
    expect(walkParts({ mimeType: "text/plain" })).toEqual({
      text: null,
      html: null,
      attachments: [],
    });
  });
});

describe("Authentication-Results parsing", () => {
  it("reads pass verdicts and the envelope sender", () => {
    const message = invoice.messages[0];
    expect(message?.authResults).toEqual({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      returnPath: "bounce+7f2@billing.acme.test",
      displayNameMismatch: false,
    });
  });

  it("reads fail and softfail verdicts", () => {
    expect(suspicious.messages[0]?.authResults).toMatchObject({
      spf: "softfail",
      dkim: "fail",
      dmarc: "fail",
    });
  });

  it("falls back to smtp.mailfrom when there is no Return-Path", () => {
    expect(suspicious.messages[0]?.authResults.returnPath).toBe("bounce@paypa1.test");
  });

  it("reports a missing verdict as null, never as a pass", () => {
    // A header that says nothing about DKIM must not be read as DKIM passing.
    const results = parseAuthResults(
      new Map([["authentication-results", "mx.google.com; spf=pass"]]),
      null,
    );
    expect(results.spf).toBe("pass");
    expect(results.dkim).toBeNull();
    expect(results.dmarc).toBeNull();
  });

  it("reports all-null when the header is absent entirely", () => {
    const results = parseAuthResults(new Map(), null);
    expect(results).toEqual({
      spf: null,
      dkim: null,
      dmarc: null,
      returnPath: null,
      displayNameMismatch: false,
    });
  });

  it("ignores a verdict word it does not recognise", () => {
    const results = parseAuthResults(
      new Map([["authentication-results", "x; spf=banana"]]),
      null,
    );
    expect(results.spf).toBeNull();
  });
});

describe("display-name spoofing", () => {
  it("flags a display name holding a different address", () => {
    expect(suspicious.messages[0]?.authResults.displayNameMismatch).toBe(true);
  });

  it("does not flag a display name with no address in it", () => {
    expect(hasDisplayNameMismatch({ name: "Acme Billing", email: "a@b.test" })).toBe(
      false,
    );
  });

  it("does not flag a display name repeating its own address", () => {
    expect(hasDisplayNameMismatch({ name: "a@b.test", email: "a@b.test" })).toBe(false);
  });
});

describe("content hash", () => {
  it("is the sha256 of the normalized plain-text body", () => {
    const body = invoice.messages[0]?.bodyText ?? "";
    const expected = createHash("sha256")
      .update(normalizeForHash(body), "utf8")
      .digest("hex");
    expect(invoice.messages[0]?.contentHash).toBe(expected);
  });

  it("is stable across CRLF, trailing spaces and extra blank lines", () => {
    // Rule 7 depends on this: a cosmetic difference must not cause a cache miss.
    const a = computeContentHash("Hello there\r\n\r\n\r\nBye   \r\n", "x");
    const b = computeContentHash("Hello there\n\nBye\n", "x");
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    expect(computeContentHash("one", "x")).not.toBe(computeContentHash("two", "x"));
  });

  it("falls back to the message id when a body is empty, so empties do not collide", () => {
    expect(computeContentHash(null, "msg-1")).not.toBe(computeContentHash(null, "msg-2"));
  });
});

describe("html fallback", () => {
  it("derives plain text when a message has no text/plain part", () => {
    const text = suspicious.messages[0]?.bodyText ?? "";
    expect(text).toContain("Your account will be");
    expect(text).not.toContain("<b>");
    // <style> content is not text the user reads.
    expect(text).not.toContain("color:red");
  });

  it("decodes entities and turns block ends into newlines", () => {
    expect(htmlToText("<p>a &amp; b</p><p>c</p>")).toContain("a & b");
    expect(htmlToText("x<br>y")).toBe("x\ny");
  });
});

describe("message mapping", () => {
  it("takes sentAt from internalDate rather than the Date header", () => {
    expect(invoice.messages[0]?.sentAt.toISOString()).toBe("2025-03-03T12:00:00.000Z");
  });

  it("extracts the Message-ID for threading on send", () => {
    expect(invoice.messages[0]?.internetMessageId).toBe(
      "<CA+9x8Qz@mail.billing.acme.test>",
    );
  });

  it("keeps Reply-To separate from From", () => {
    expect(invoice.messages[0]?.replyTo).toEqual({ email: "support@billing.acme.test" });
    expect(invoice.messages[0]?.from.email).toBe("accounts@billing.acme.test");
  });

  it("marks UNREAD as unread and its absence as read", () => {
    expect(invoice.messages[0]?.isRead).toBe(false);
    expect(invoice.messages[1]?.isRead).toBe(true);
  });

  it("sets isOutbound by comparing From to the mailbox address", () => {
    expect(invoice.messages[0]?.isOutbound).toBe(false);
    expect(invoice.messages[1]?.isOutbound).toBe(true);
  });

  it("treats a mailbox address differing only in case as outbound", () => {
    const mapped = mapThread(invoiceThread as gmail_v1.Schema$Thread, {
      mailboxAddress: "PERSON@EXAMPLE.COM",
    });
    expect(mapped.messages[1]?.isOutbound).toBe(true);
  });

  it("does not count an inline image as an attachment", () => {
    // The invoice message has one inline logo and one real PDF.
    expect(invoice.messages[0]?.hasAttachments).toBe(true);
    const inlineOnly = mapThread(
      {
        id: "t",
        messages: [
          {
            id: "m",
            threadId: "t",
            payload: {
              mimeType: "multipart/related",
              headers: [],
              parts: [
                {
                  mimeType: "image/png",
                  filename: "sig.png",
                  headers: [{ name: "Content-Disposition", value: "inline" }],
                  body: { size: 10, attachmentId: "a" },
                },
              ],
            },
          },
        ],
      } as gmail_v1.Schema$Thread,
      MAILBOX,
    );
    expect(inlineOnly.messages[0]?.hasAttachments).toBe(false);
  });

  it("keeps only headers worth storing", () => {
    const headers = invoice.messages[0]?.headers ?? {};
    expect(headers["message-id"]).toBeDefined();
    expect(headers["authentication-results"]).toBeDefined();
    // Not in the keep-list: trace noise we would never read again.
    expect(headers["delivered-to"]).toBeUndefined();
  });

  it("maps a message with no headers, body, labels or date without throwing", () => {
    const mapped = mapThread(degenerateThread as gmail_v1.Schema$Thread, MAILBOX);
    const message = mapped.messages[0];

    expect(message?.from.email).toBe("unknown@invalid");
    expect(message?.subject).toBeNull();
    expect(message?.bodyText).toBeNull();
    expect(message?.internetMessageId).toBeNull();
    expect(message?.isRead).toBe(true);
    expect(message?.attachments).toEqual([]);
    expect(message?.contentHash).toHaveLength(64);
    expect(message?.sentAt.getTime()).toBeGreaterThan(0);
  });
});

describe("thread mapping", () => {
  it("orders messages oldest first", () => {
    expect(invoice.messages.map((m) => m.providerMessageId)).toEqual([
      "18f0a1b2c3d4e5f6",
      "18f0a1b2c3d4e601",
    ]);
  });

  it("carries the thread id and history id", () => {
    expect(invoice.providerThreadId).toBe("18f0a1b2c3d4e5f0");
    expect(invoice.historyId).toBe("998877");
  });

  it("collects deduped participants with from outranking to", () => {
    const participants = threadParticipants(invoice.messages);
    const byEmail = new Map(participants.map((p) => [p.email, p]));

    expect(byEmail.get("accounts@billing.acme.test")?.role).toBe("from");
    expect(byEmail.get("person@example.com")?.role).toBe("from");
    expect(byEmail.get("jane@example.com")?.role).toBe("cc");
    // One entry per address, however many messages mention it.
    expect(participants).toHaveLength(new Set(participants.map((p) => p.email)).size);
  });
});
