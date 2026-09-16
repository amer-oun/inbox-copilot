import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The follow-up digest (§9).
 *
 * The property that matters most here is a boundary rather than a behaviour: **Resend
 * carries mail from the application to its own user, and never the user's own
 * correspondence.** There is a source-reading test at the bottom for that, because it is
 * the kind of rule that a future "we already have a mail transport here" refactor would
 * quietly break — the user's mail must go from the user's mailbox, with the user's
 * authentication, or it arrives from our domain and fails their recipients' DMARC.
 *
 * Everything else is about not being annoying, which for an email nobody asked for is
 * the same thing as being correct.
 */

const reminderFindMany = vi.hoisted(() => vi.fn());
const reminderUpdateMany = vi.hoisted(() => vi.fn());
const settingsFindFirst = vi.hoisted(() => vi.fn());
const userFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    followUpReminder: { findMany: reminderFindMany, updateMany: reminderUpdateMany },
    userSettings: { findFirst: settingsFindFirst },
    user: { findFirst: userFindFirst },
  }),
  Prisma: {},
}));

const sendAppEmail = vi.hoisted(() => vi.fn());

vi.mock("../lib/resend.js", () => ({ sendAppEmail }));

const { escapeHtml, sendFollowUpDigest } = await import("./digest.js");

const USER_ID = "user_1";
const NOW = new Date("2026-09-16T08:00:00Z");

function reminderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cldd4kzai000108l3a1b2c3d4",
    dueAt: new Date("2026-09-14T08:00:00Z"),
    reason: "Re: Invoice 4471",
    thread: { subject: "Invoice 4471" },
    ...overrides,
  };
}

beforeEach(() => {
  reminderFindMany.mockReset().mockResolvedValue([reminderRow()]);
  reminderUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  settingsFindFirst.mockReset().mockResolvedValue({ followUpDigest: true });
  userFindFirst.mockReset().mockResolvedValue({ email: "owner@example.com", name: "Amer" });
  sendAppEmail.mockReset().mockResolvedValue({ sent: true, id: "re_1" });
});

describe("the opt-in", () => {
  it("sends nothing when the user has not turned the digest on", async () => {
    settingsFindFirst.mockResolvedValue({ followUpDigest: false });

    const result = await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    expect(result).toEqual({ sent: false, reason: "opt-out" });
    expect(sendAppEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when the user has no settings row at all", async () => {
    // Absent settings means the schema default, which is off. This is the one feature
    // that mails a person, so "we could not tell" resolves to "do not".
    settingsFindFirst.mockResolvedValue(null);

    const result = await sendFollowUpDigest({ userId: USER_ID, now: NOW });
    expect(result.reason).toBe("opt-out");
  });
});

describe("what it will not send", () => {
  it("sends no email when there is nothing overdue", async () => {
    // Explicitly not a "you have 0 reminders" mail.
    reminderFindMany.mockResolvedValue([]);

    const result = await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    expect(result).toEqual({ sent: false, reason: "no-items" });
    expect(sendAppEmail).not.toHaveBeenCalled();
  });

  it("never names the same reminder in two digests", async () => {
    // `digestSentAt: null` in the query is what stops a thread that stays unanswered for
    // a week from producing seven emails.
    await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    expect(reminderFindMany.mock.calls[0]?.[0].where).toMatchObject({
      status: "TRIGGERED",
      digestSentAt: null,
    });
  });

  it("stamps the rows only after the send succeeded", async () => {
    /*
     * The two failure modes are not symmetrical: marking first and failing to send loses
     * the digest silently, while sending and failing to mark repeats it once. A duplicate
     * the user can see beats a gap they cannot.
     */
    await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    expect(sendAppEmail).toHaveBeenCalled();
    expect(reminderUpdateMany.mock.calls[0]?.[0].data).toEqual({ digestSentAt: NOW });
  });

  it("does not stamp the rows when the transport refused", async () => {
    sendAppEmail.mockResolvedValue({ sent: false, reason: "http-429" });

    const result = await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    expect(result).toEqual({ sent: false, reason: "http-429" });
    // Not stamped, so the next run tries again rather than losing the digest.
    expect(reminderUpdateMany).not.toHaveBeenCalled();
  });

  it("reports rather than throws when the account has no address", async () => {
    userFindFirst.mockResolvedValue({ email: null, name: "Amer" });

    const result = await sendFollowUpDigest({ userId: USER_ID, now: NOW });
    expect(result.reason).toBe("no-address");
  });
});

describe("the body", () => {
  it("escapes a subject line, because a subject is sender-chosen", async () => {
    /*
     * The digest is the one place this application renders an email subject into HTML
     * itself — everywhere else a subject goes through React, or through DOMPurify inside
     * a sandboxed frame. So the escaping is here and it is tested here.
     */
    reminderFindMany.mockResolvedValue([
      reminderRow({ thread: { subject: '<img src=x onerror="alert(1)">' } }),
    ]);

    await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    const { html } = sendAppEmail.mock.calls[0]?.[0] ?? {};
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes quotes and ampersands too", () => {
    expect(escapeHtml(`a & b "c" 'd' <e>`)).toBe(
      "a &amp; b &quot;c&quot; &#39;d&#39; &lt;e&gt;",
    );
  });

  it("says how overdue each thread is, not just that it exists", async () => {
    reminderFindMany.mockResolvedValue([
      reminderRow({ dueAt: new Date("2026-09-14T08:00:00Z") }),
    ]);

    await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    expect(sendAppEmail.mock.calls[0]?.[0].html).toContain("2 days overdue");
  });

  it("counts correctly in the subject line", async () => {
    reminderFindMany.mockResolvedValue([reminderRow(), reminderRow({ id: "b" })]);

    await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    expect(sendAppEmail.mock.calls[0]?.[0].subject).toBe(
      "2 messages are still waiting for a reply",
    );
  });

  it("carries a plain-text alternative built from our own words", async () => {
    // Not a tag-stripped copy of the HTML: the text part is written, so it cannot leak
    // markup or half a sender's subject.
    await sendFollowUpDigest({ userId: USER_ID, now: NOW });

    const { text } = sendAppEmail.mock.calls[0]?.[0] ?? {};
    expect(text).toContain("/follow-ups");
    expect(text).not.toContain("<");
  });
});

describe("the Resend boundary", () => {
  it("is the only module that reaches the app-email transport", async () => {
    /*
     * A source-reading test, because this is a boundary rather than a behaviour and the
     * behaviour tests above cannot see it.
     *
     * If a future change routes the user's own mail through Resend, it will arrive from
     * our domain rather than theirs: invisible in their Sent folder, failing their
     * recipients' DMARC alignment, and indistinguishable from an impersonation. The
     * user's mail goes through `MailProvider.sendMessage` and nothing else.
     */
    const { readFileSync } = await import("node:fs");
    const { readdirSync } = await import("node:fs");

    const serviceDir = new URL("./", import.meta.url);
    const files = readdirSync(serviceDir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    const importers = files.filter((name) =>
      readFileSync(new URL(name, serviceDir), "utf8").includes("lib/resend.js"),
    );

    expect(importers).toEqual(["digest.ts"]);
  });

  it("does not reach the mail provider, so it cannot send as the user", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./digest.ts", import.meta.url), "utf8");

    expect(source).not.toContain("mailProviderFor");
    expect(source).not.toContain("providers/");
  });
});
