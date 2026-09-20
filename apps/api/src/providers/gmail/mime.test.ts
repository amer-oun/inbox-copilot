import { describe, expect, it } from "vitest";
import {
  buildMimeMessage,
  encodeMimeForGmail,
  encodeWord,
  foldHeaderLine,
  foldSubject,
  formatMimeAddress,
  type MimeMessageInput,
} from "./mime.js";

/**
 * MIME construction. Three things are being tested, in order of what they cost when
 * wrong: header injection (a subject that adds a Bcc), threading (a reply that reads
 * as a new conversation to everyone but the sender), and encoding.
 */

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function message(overrides: Partial<MimeMessageInput> = {}): string {
  return buildMimeMessage({
    from: { email: "sam@example.com" },
    to: [{ email: "dana@northwind.example" }],
    subject: "Hello",
    text: "Hello there",
    html: "<p>Hello there</p>",
    ...overrides,
  });
}

describe("header injection", () => {
  it("refuses a line break in an address", () => {
    expect(() =>
      message({
        to: [{ email: `dana@northwind.example${CR}${LF}Bcc: victim@evil.test` }],
      }),
    ).toThrow(/Invalid email address/);
  });

  it("refuses a line break in a display name", () => {
    expect(() =>
      message({
        to: [
          {
            name: `Dana${CR}${LF}Bcc: victim@evil.test`,
            email: "dana@northwind.example",
          },
        ],
      }),
    ).toThrow(/Illegal line break/);
  });

  it("refuses an address carrying a second recipient", () => {
    // A comma is the To header's own separator: without this check, one address field
    // silently becomes two recipients.
    expect(() =>
      message({ to: [{ email: "dana@northwind.example, victim@evil.test" }] }),
    ).toThrow(/Invalid email address/);
  });

  it("refuses an address that closes the angle-addr", () => {
    expect(() =>
      message({ to: [{ email: "dana@northwind.example>, <victim@evil.test" }] }),
    ).toThrow(/Invalid email address/);
  });

  it("collapses a line break in the subject rather than refusing to send", () => {
    /*
     * The one value where a newline is a formatting accident rather than an attack:
     * people paste subjects. Collapsing is exactly as safe as refusing — the value can
     * no longer end the header — and it does not block a legitimate send.
     */
    const mime = message({ subject: `Invoice${CR}${LF}Bcc: victim@evil.test` });

    expect(mime).toContain("Subject: Invoice Bcc: victim@evil.test");
    expect(mime).not.toMatch(/^Bcc:/m);
  });

  it("escapes a quote inside a display name", () => {
    expect(formatMimeAddress({ name: 'Dana "Danny" W', email: "d@n.test" })).toBe(
      String.raw`"Dana \"Danny\" W" <d@n.test>`,
    );
  });
});

describe("threading", () => {
  it("writes In-Reply-To and a References chain ending in the parent", () => {
    const mime = message({
      inReplyTo: "<parent@mail.example>",
      references: [
        "<first@mail.example>",
        "<second@mail.example>",
        "<parent@mail.example>",
      ],
    });

    expect(mime).toContain("In-Reply-To: <parent@mail.example>");
    expect(mime).toContain(
      "References: <first@mail.example> <second@mail.example> <parent@mail.example>",
    );
  });

  it("omits both headers for a new message", () => {
    const mime = message();
    expect(mime).not.toContain("In-Reply-To");
    expect(mime).not.toContain("References");
  });

  it("folds a long References chain onto continuation lines", () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) => `<message-${index}@mail.example>`,
    );
    const mime = message({ inReplyTo: ids.at(-1) ?? "", references: ids });

    const header = mime.split(`${CR}${LF}${CR}${LF}`)[0] ?? "";
    const lines = header.split(`${CR}${LF}`);
    const start = lines.findIndex((line) => line.startsWith("References:"));
    const chain = [
      lines[start],
      ...lines.slice(start + 1).filter((line) => line.startsWith(" ")),
    ];

    // RFC 5322 allows 998 and recommends 78; a receiver that truncates an over-long
    // header breaks threading for everyone in the conversation. (Only the folded
    // header is checked — the boundary in Content-Type is one long token and cannot
    // be folded.)
    for (const line of chain) expect(line?.length ?? 0).toBeLessThanOrEqual(78);
    expect(chain.length).toBeGreaterThan(1);
    // Still one header: every fold continues it with leading whitespace.
    expect(header).toContain(`References: ${ids[0]}`);
    expect(header).toContain(`${CR}${LF} `);
  });

  it("does not fold what fits", () => {
    const mime = message({ references: ["<a@b.test>"] });
    expect(mime).toContain(`References: <a@b.test>${CR}${LF}`);
  });
});

describe("encoding", () => {
  it("encodes a non-ASCII subject as an RFC 2047 word", () => {
    const mime = message({ subject: "Réunion de jeudi" });

    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).not.toContain("Réunion");
    // Decodes back to the original.
    const encoded = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(mime)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("Réunion de jeudi");
  });

  it("leaves an ASCII subject readable", () => {
    expect(message({ subject: "Re: invoice 4471" })).toContain(
      "Subject: Re: invoice 4471",
    );
  });

  it("never splits a multi-byte character across encoded words", () => {
    // Chunking on bytes instead of code points is the easy version of this function,
    // and it produces replacement glyphs in the middle of a long subject.
    const long = "é".repeat(200);
    const words = [...encodeWord(long).matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(
      (match) => match[1] ?? "",
    );

    expect(words.length).toBeGreaterThan(1);
    const decoded = words
      .map((word) => Buffer.from(word, "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe(long);
  });

  it("sends both a text and an HTML part, base64 with a charset", () => {
    const mime = message({ text: "Hello there", html: "<p>Hello there</p>" });

    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(mime).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(mime).toContain('Content-Type: text/html; charset="utf-8"');
    expect(mime.match(/Content-Transfer-Encoding: base64/g)).toHaveLength(2);
    expect(mime).toContain(Buffer.from("Hello there", "utf8").toString("base64"));
  });

  it("wraps base64 at 76 characters", () => {
    const mime = message({ text: "x".repeat(500), html: "<p>y</p>" });
    for (const line of mime.split(`${CR}${LF}`)) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
    expect(mime).toMatch(/eHh4[A-Za-z0-9+/=]{60,73}\r\n/);
  });

  it("uses CRLF line endings throughout", () => {
    const mime = message();
    expect(mime.split(LF).every((line) => line === "" || line.endsWith(CR))).toBe(true);
  });

  it("base64url-encodes the finished message for Gmail", () => {
    const raw = encodeMimeForGmail(message());

    expect(raw).not.toMatch(/[+/]/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toContain("Subject: Hello");
  });
});

describe("the envelope", () => {
  it("writes Bcc, because Gmail strips it and omitting it would drop the recipient", () => {
    const mime = message({ bcc: [{ email: "archive@example.com" }] });
    expect(mime).toContain("Bcc: archive@example.com");
  });

  it("writes Cc when there is one, and no empty header when there is not", () => {
    expect(message({ cc: [{ email: "lead@example.com" }] })).toContain(
      "Cc: lead@example.com",
    );
    expect(message({ cc: [] })).not.toContain("Cc:");
  });

  it("refuses a message with no recipient", () => {
    expect(() => message({ to: [] })).toThrow(/at least one recipient/);
  });

  it("sets no Message-ID or Date, which the provider stamps", () => {
    const mime = message();
    expect(mime).not.toMatch(/^Message-ID:/m);
    expect(mime).not.toMatch(/^Date:/m);
  });

  it("uses a boundary that does not appear in the content", () => {
    const html = "<p>--=_inbox_copilot_deadbeef</p>";
    const mime = message({ html });
    const boundary = /boundary="([^"]+)"/.exec(mime)?.[1] ?? "";

    // Random, not derived from the body: a boundary occurring in the content would
    // truncate the message. Four occurrences — the Content-Type header, two part
    // delimiters, and the closing one.
    expect(boundary).not.toBe("--=_inbox_copilot_deadbeef");
    expect(
      mime.match(new RegExp(boundary.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&"), "g")),
    ).toHaveLength(4);
  });
});

describe("foldHeaderLine", () => {
  it("returns a short header untouched", () => {
    expect(foldHeaderLine("References", "<a@b.test> <c@d.test>")).toBe(
      "References: <a@b.test> <c@d.test>",
    );
  });

  it("never breaks a token, even one longer than the width", () => {
    const long = `<${"x".repeat(100)}@mail.example>`;
    expect(foldHeaderLine("References", `${long} <b@c.test>`)).toBe(
      `References: ${long}${CR}${LF} <b@c.test>`,
    );
  });

  it("counts the field name toward the first line", () => {
    const ids = Array.from({ length: 6 }, (_, i) => `<message-${i}@mail.example>`);
    const first =
      foldHeaderLine("References", ids.join(" ")).split(`${CR}${LF}`)[0] ?? "";
    expect(first.length).toBeLessThanOrEqual(78);
  });
});

describe("foldSubject", () => {
  it("trims and collapses whitespace-only breaks", () => {
    expect(foldSubject(`  Hello${CR}${LF}world  `)).toBe("Hello world");
  });

  it("survives an empty subject", () => {
    expect(foldSubject("")).toBe("");
  });
});
