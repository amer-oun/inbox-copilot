import { describe, expect, it } from "vitest";
import {
  MAX_BODY_CHARS,
  MAX_THREAD_CHARS,
  messageForPrompt,
  needsSummary,
  promptBody,
  promptMetadata,
  threadForPrompt,
  truncateForPrompt,
} from "./content.js";
import { threadContentHash } from "./cache.js";

/** Turning stored rows into prompt input: body selection, budgets, metadata. */

function msg(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    subject: "Invoice 4471",
    fromName: "Dana Whitfield",
    fromEmail: "dana@northwind.example",
    to: ["person@example.com"],
    cc: ["ap@northwind.example"],
    replyTo: null,
    sentAt: new Date("2026-09-10T09:00:00Z"),
    bodyText: "plain text body",
    bodyHtml: null,
    snippet: "plain text",
    isOutbound: false,
    hasAttachments: false,
    contentHash: "hash-1",
    ...overrides,
  };
}

describe("promptBody", () => {
  it("prefers the stored plain text", () => {
    expect(promptBody(msg())).toBe("plain text body");
  });

  it("extracts text from HTML when there is no plain part", () => {
    const body = promptBody(
      msg({
        bodyText: null,
        bodyHtml: "<p>Hello <b>there</b></p><script>alert(1)</script>",
      }),
    );

    expect(body).toContain("Hello");
    // §7 rule 5: the script's contents are dropped, not just its tags.
    expect(body).not.toContain("alert(1)");
  });

  it("falls back to the snippet rather than sending nothing", () => {
    expect(
      promptBody(msg({ bodyText: null, bodyHtml: null, snippet: "just a snippet" })),
    ).toBe("just a snippet");
  });

  it("returns an empty string when the message has no text at all", () => {
    expect(promptBody(msg({ bodyText: null, bodyHtml: null, snippet: null }))).toBe("");
  });

  it("truncates a pathological body", () => {
    const body = promptBody(msg({ bodyText: "x".repeat(MAX_BODY_CHARS + 5_000) }));

    expect(body.length).toBeLessThan(MAX_BODY_CHARS + 200);
    expect(body).toContain("[... truncated");
  });
});

describe("truncateForPrompt", () => {
  it("leaves text within budget alone", () => {
    expect(truncateForPrompt("short", 100)).toBe("short");
  });

  it("marks the cut so the model knows text is missing", () => {
    const out = truncateForPrompt("abcdefghij", 4);
    expect(out.startsWith("abcd")).toBe(true);
    expect(out).toContain("6 more characters");
  });
});

describe("promptMetadata", () => {
  it("includes the envelope facts a classifier needs", () => {
    expect(promptMetadata(msg(), "person@example.com")).toMatchObject({
      from: "Dana Whitfield <dana@northwind.example>",
      to: "person@example.com",
      cc: "ap@northwind.example",
      subject: "Invoice 4471",
      sent_at: "2026-09-10T09:00:00.000Z",
      mailbox_owner: "person@example.com",
      sent_by_mailbox_owner: false,
    });
  });

  it("flags a Reply-To that disagrees with the From (§6 layer 1)", () => {
    const metadata = promptMetadata(
      msg({ replyTo: "billing@totally-different.example" }),
      "person@example.com",
    );

    expect(metadata).toHaveProperty(
      "reply_to_differs_from_from",
      "billing@totally-different.example",
    );
  });

  it("does not flag a Reply-To that matches the sender", () => {
    const metadata = promptMetadata(
      msg({ replyTo: "Dana <dana@northwind.example>" }),
      "person@example.com",
    );

    expect(metadata).not.toHaveProperty("reply_to_differs_from_from");
  });

  it("names a missing subject rather than omitting it", () => {
    expect(promptMetadata(msg({ subject: null }), "person@example.com").subject).toBe(
      "(no subject)",
    );
  });
});

describe("needsSummary", () => {
  it("is true at three messages", () => {
    expect(needsSummary([msg(), msg(), msg()])).toBe(true);
  });

  it("is false for two short messages", () => {
    expect(needsSummary([msg(), msg()])).toBe(false);
  });

  it("is true for a body over 1500 characters", () => {
    expect(needsSummary([msg({ bodyText: "x".repeat(1_501) })])).toBe(true);
  });

  it("is false at exactly 1500 characters", () => {
    expect(needsSummary([msg({ bodyText: "x".repeat(1_500) })])).toBe(false);
  });

  it("considers the snippet when there is no body", () => {
    expect(needsSummary([msg({ bodyText: null, snippet: "x".repeat(1_501) })])).toBe(
      true,
    );
  });
});

describe("threadForPrompt", () => {
  it("keeps order oldest-first", () => {
    const blocks = threadForPrompt(
      [msg({ bodyText: "one" }), msg({ bodyText: "two" })],
      "me@x.example",
    );
    expect(blocks.map((block) => block.body)).toEqual(["one", "two"]);
  });

  it("drops the oldest messages when over the thread budget", () => {
    /*
     * A summary missing how a thread started is imperfect; one missing where it
     * stands is wrong. So the newest survive.
     *
     * Note the per-message cap applies first: each body is already truncated to
     * MAX_BODY_CHARS, so the thread budget only bites once there are more messages
     * than MAX_THREAD_CHARS / MAX_BODY_CHARS of them — four, here.
     */
    const big = "x".repeat(MAX_BODY_CHARS);
    const messages = ["oldest", "second", "third", "fourth", "newest"].map((label) =>
      msg({ bodyText: `${label} ${big}` }),
    );

    const blocks = threadForPrompt(messages, "me@x.example");

    expect(blocks.length).toBeLessThan(messages.length);
    expect(blocks.at(-1)?.body.startsWith("newest")).toBe(true);
    expect(blocks.reduce((sum, block) => sum + block.body.length, 0)).toBeLessThanOrEqual(
      MAX_THREAD_CHARS,
    );
  });

  it("always keeps at least the newest message, even if it alone is over budget", () => {
    const blocks = threadForPrompt(
      [msg({ bodyText: "x".repeat(MAX_BODY_CHARS * 4) })],
      "me@x.example",
    );
    expect(blocks).toHaveLength(1);
  });
});

describe("threadContentHash", () => {
  it("changes when a message is added", () => {
    expect(threadContentHash(["a", "b"])).not.toBe(threadContentHash(["a", "b", "c"]));
  });

  it("changes when the order changes", () => {
    // The same two messages in the other order is a different thread state.
    expect(threadContentHash(["a", "b"])).not.toBe(threadContentHash(["b", "a"]));
  });

  it("is stable for the same input", () => {
    expect(threadContentHash(["a", "b"])).toBe(threadContentHash(["a", "b"]));
  });

  it("is not fooled by concatenation", () => {
    // Without a separator, ["ab","c"] and ["a","bc"] would hash the same.
    expect(threadContentHash(["ab", "c"])).not.toBe(threadContentHash(["a", "bc"]));
  });
});

describe("messageForPrompt", () => {
  it("pairs metadata with the body", () => {
    const block = messageForPrompt(msg(), "person@example.com");
    expect(block.body).toBe("plain text body");
    expect(block.metadata.subject).toBe("Invoice 4471");
  });
});
