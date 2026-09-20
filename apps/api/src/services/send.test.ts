import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sending.
 *
 * The questions this file answers: who does a reply go to, does it thread, what gets
 * recorded, and — the one that matters most — can anything but a person's submitted
 * text end up in a sent message.
 */

const sendMessage = vi.hoisted(() => vi.fn());
const mailProviderFor = vi.hoisted(() => vi.fn());

vi.mock("../providers/registry.js", () => ({ mailProviderFor }));

/**
 * The follow-up reminder the send path creates when the user asked for one (§9).
 *
 * Mocked: what this file owns is *when* it is called — after the mail has gone, never
 * before, and never able to fail the send. What it decides is `followUps.test.ts`.
 */
const createFollowUpReminder = vi.hoisted(() => vi.fn());
vi.mock("./followUps.js", () => ({ createFollowUpReminder }));

const threadFindFirst = vi.hoisted(() => vi.fn());
const draftFindFirst = vi.hoisted(() => vi.fn());
const draftUpdate = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    thread: { findFirst: threadFindFirst },
    replyDraft: { findFirst: draftFindFirst, update: draftUpdate },
  }),
  Prisma: {},
}));

const {
  parseFormattedAddress,
  referencesChain,
  replyRecipients,
  replySubject,
  sendReply,
  textToHtml,
} = await import("./send.js");

const USER_ID = "user_1";
const THREAD_ID = "thread_1";
const MAILBOX = "sam@example.com";

function parent(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    internetMessageId: "<parent@northwind.example>",
    subject: "Invoice 4471",
    fromName: "Dana Whitfield",
    fromEmail: "dana@northwind.example",
    to: [`Sam <${MAILBOX}>`],
    cc: ["Lead <lead@northwind.example>"],
    replyTo: null,
    headers: { references: "<first@northwind.example> <second@northwind.example>" },
    isOutbound: false,
    ...overrides,
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD_ID,
    providerThreadId: "gmail_thread_1",
    mailAccountId: "mail_1",
    mailAccount: { emailAddress: MAILBOX, provider: "GMAIL" },
    messages: [parent()],
    ...overrides,
  };
}

/** What the provider was asked to send. */
function outbound(): Record<string, unknown> {
  return sendMessage.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({
    providerMessageId: "sent_1",
    providerThreadId: "gmail_thread_1",
  });
  mailProviderFor.mockReset().mockReturnValue({ sendMessage });
  threadFindFirst.mockReset().mockResolvedValue(thread());
  draftFindFirst.mockReset().mockResolvedValue(null);
  draftUpdate.mockReset().mockResolvedValue({});
  createFollowUpReminder.mockReset().mockResolvedValue(null);
});

describe("parseFormattedAddress", () => {
  it("splits a formatted address", () => {
    expect(parseFormattedAddress("Dana Whitfield <dana@northwind.example>")).toEqual({
      name: "Dana Whitfield",
      email: "dana@northwind.example",
    });
  });

  it("takes the last angle-addr, not the first", () => {
    /*
     * A display name may contain an address. Reading the first `<` would let
     * "billing@bank.example <attacker@evil.test>" be parsed as the bank — and the
     * reply would go to the attacker with a reassuring name on it.
     */
    expect(parseFormattedAddress("billing@bank.example <attacker@evil.test>")).toEqual({
      name: "billing@bank.example",
      email: "attacker@evil.test",
    });
  });

  it("handles a bare address and rejects nothing useful", () => {
    expect(parseFormattedAddress("dana@northwind.example")).toEqual({
      email: "dana@northwind.example",
    });
    expect(parseFormattedAddress("   ")).toBeNull();
    expect(parseFormattedAddress("Dana <>")).toBeNull();
  });
});

describe("replyRecipients", () => {
  it("replies to the sender, and copies nobody", () => {
    // Not reply-all: the widest mistake this code can make is adding a recipient.
    expect(replyRecipients(parent(), MAILBOX)).toEqual([
      { name: "Dana Whitfield", email: "dana@northwind.example" },
    ]);
  });

  it("honours Reply-To", () => {
    expect(
      replyRecipients(
        parent({ replyTo: "Billing <billing@northwind.example>" }),
        MAILBOX,
      ),
    ).toEqual([{ name: "Billing", email: "billing@northwind.example" }]);
  });

  it("answers the user's own last message to whoever it was addressed to", () => {
    const own = parent({
      isOutbound: true,
      fromEmail: MAILBOX,
      fromName: "Sam",
      to: ["Dana <dana@northwind.example>"],
    });

    expect(replyRecipients(own, MAILBOX)).toEqual([
      { name: "Dana", email: "dana@northwind.example" },
    ]);
  });

  it("never addresses the mailbox itself", () => {
    const own = parent({ isOutbound: true, fromEmail: MAILBOX, to: [MAILBOX] });
    expect(() => replyRecipients(own, MAILBOX)).toThrow(/who to reply to/);
  });
});

describe("replySubject", () => {
  it("adds Re: once", () => {
    expect(replySubject("Invoice 4471")).toBe("Re: Invoice 4471");
    expect(replySubject("Re: Invoice 4471")).toBe("Re: Invoice 4471");
    expect(replySubject("RE:Invoice 4471")).toBe("RE:Invoice 4471");
  });

  it("survives a thread with no subject", () => {
    expect(replySubject(null)).toBe("Re:");
  });
});

describe("referencesChain", () => {
  it("appends the parent to its own chain", () => {
    expect(referencesChain(parent())).toEqual([
      "<first@northwind.example>",
      "<second@northwind.example>",
      "<parent@northwind.example>",
    ]);
  });

  it("is just the parent when the parent had no chain", () => {
    expect(referencesChain(parent({ headers: {} }))).toEqual([
      "<parent@northwind.example>",
    ]);
  });

  it("is empty when the parent has no Message-ID either", () => {
    expect(referencesChain(parent({ headers: null, internetMessageId: null }))).toEqual(
      [],
    );
  });

  it("keeps the oldest and newest of a very long chain", () => {
    const ids = Array.from({ length: 60 }, (_, index) => `<m${index}@mail.example>`);
    const chain = referencesChain(parent({ headers: { references: ids.join(" ") } }));

    expect(chain).toHaveLength(20);
    expect(chain[0]).toBe("<m0@mail.example>");
    expect(chain.at(-1)).toBe("<parent@northwind.example>");
  });

  it("ignores junk in the stored header", () => {
    expect(
      referencesChain(parent({ headers: { references: "not-an-id  <ok@m.test>" } })),
    ).toEqual(["<ok@m.test>", "<parent@northwind.example>"]);
  });
});

describe("textToHtml", () => {
  it("escapes markup rather than rendering it", () => {
    const html = textToHtml('<script>alert(1)</script> & "quotes"');

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });

  it("turns blank lines into paragraphs and single breaks into br", () => {
    const html = textToHtml("one\ntwo\n\nthree");
    expect(html).toContain("<p>one<br>two</p>");
    expect(html).toContain("<p>three</p>");
  });
});

describe("sendReply", () => {
  it("sends exactly the text it was given", async () => {
    const result = await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "Sending a revised invoice today.",
    });

    expect(result.providerMessageId).toBe("sent_1");
    expect(outbound()["bodyText"]).toBe("Sending a revised invoice today.");
    expect(outbound()["subject"]).toBe("Re: Invoice 4471");
  });

  it("threads on the parent, and passes the provider thread through", async () => {
    await sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "ok" });

    expect(outbound()["inReplyTo"]).toEqual({
      providerThreadId: "gmail_thread_1",
      internetMessageId: "<parent@northwind.example>",
      references: [
        "<first@northwind.example>",
        "<second@northwind.example>",
        "<parent@northwind.example>",
      ],
    });
  });

  it("sends no Cc or Bcc at all", async () => {
    await sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "ok" });

    expect(outbound()).not.toHaveProperty("cc");
    expect(outbound()).not.toHaveProperty("bcc");
    expect(outbound()["to"]).toHaveLength(1);
  });

  it("falls back to Gmail's threadId alone when the parent has no Message-ID", async () => {
    threadFindFirst.mockResolvedValue(
      thread({ messages: [parent({ internetMessageId: null })] }),
    );

    await sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "ok" });
    expect(outbound()).not.toHaveProperty("inReplyTo");
  });

  it("refuses an empty body without calling the provider", async () => {
    await expect(
      sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "   " }),
    ).rejects.toThrow(/needs a body/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("is a 404 for a thread the user does not own", async () => {
    threadFindFirst.mockResolvedValue(null);

    await expect(
      sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "ok" }),
    ).rejects.toThrow(/Thread not found/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("writes no Message row: the sync engine owns that table", async () => {
    // A row fabricated here would be a second source of truth about what was sent,
    // with ids and a timestamp we made up.
    await sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "ok" });
    // The mocked client exposes no `message` model at all, so a write would throw.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("draft feedback", () => {
  it("marks the draft used, and records nothing when the text is unchanged", async () => {
    draftFindFirst.mockResolvedValue({ id: "draft_1", body: "Sending it today." });

    const result = await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "Sending it today.",
      draftId: "draft_1",
    });

    expect(result).toMatchObject({ usedDraftId: "draft_1", edited: false });
    expect(draftUpdate).toHaveBeenCalledWith({
      where: { id: "draft_1" },
      data: { wasUsed: true },
    });
  });

  it("stores the edited text when the user changed it", async () => {
    draftFindFirst.mockResolvedValue({ id: "draft_1", body: "Sending it today." });

    const result = await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "Sending it tomorrow, sorry.",
      draftId: "draft_1",
    });

    expect(result.edited).toBe(true);
    expect(draftUpdate).toHaveBeenCalledWith({
      where: { id: "draft_1" },
      data: { wasUsed: true, editedBody: "Sending it tomorrow, sorry." },
    });
  });

  it("scopes the draft lookup to the thread", async () => {
    await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      draftId: "draft_from_elsewhere",
    });

    expect(draftFindFirst).toHaveBeenCalledWith({
      where: { id: "draft_from_elsewhere", threadId: THREAD_ID },
      select: { id: true, body: true },
    });
  });

  it("still reports the send when the draft id belongs to another thread", async () => {
    draftFindFirst.mockResolvedValue(null);

    const result = await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      draftId: "draft_elsewhere",
    });

    expect(result.providerMessageId).toBe("sent_1");
    expect(result.usedDraftId).toBeNull();
    expect(draftUpdate).not.toHaveBeenCalled();
  });

  it("never fails a successful send because the bookkeeping write failed", async () => {
    /*
     * The mail has already gone. An error here would be read by the user as "it did
     * not send", and the one thing worse than losing a feedback flag is a second copy
     * of the same reply.
     */
    draftFindFirst.mockResolvedValue({ id: "draft_1", body: "x" });
    draftUpdate.mockRejectedValue(new Error("database is down"));

    const result = await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      draftId: "draft_1",
    });

    expect(result.providerMessageId).toBe("sent_1");
    expect(result.usedDraftId).toBeNull();
  });

  it("records nothing when no draft was named", async () => {
    const result = await sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "ok" });

    expect(result.usedDraftId).toBeNull();
    expect(draftFindFirst).not.toHaveBeenCalled();
  });
});

describe("the follow-up reminder", () => {
  it("creates none unless the user asked for one", async () => {
    // Default off. A reminder nobody asked for is a notification nobody wants — and it
    // is not taken from `needsReply` either, which is the model's opinion about mail
    // *arriving* rather than about who owes the user an answer.
    await sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "ok" });

    expect(createFollowUpReminder).not.toHaveBeenCalled();
  });

  it("watches the provider's message id, because ours does not exist yet", async () => {
    /*
     * The sent message has no `Message` row at this moment: the sync engine owns that
     * table and the next delta brings the real row. The provider's id is the only
     * identifier that exists here, which is why the column is not a foreign key.
     */
    createFollowUpReminder.mockResolvedValue({ id: "cldd4kzai000908l3a1b2c3d4" });

    const result = await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      expectsReply: true,
    });

    expect(createFollowUpReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        threadId: THREAD_ID,
        watchedMessageId: "sent_1",
      }),
    );
    expect(result.reminderId).toBe("cldd4kzai000908l3a1b2c3d4");
  });

  it("creates it only after the send succeeded", async () => {
    /*
     * A reminder to chase a reply to mail that never went out is worse than no reminder.
     * The send throws, so nothing is created — and because the reminder write comes
     * after `sendMessage`, this ordering is structural rather than a check.
     */
    sendMessage.mockRejectedValue(new Error("502 Bad Gateway"));

    await expect(
      sendReply({ userId: USER_ID, threadId: THREAD_ID, body: "ok", expectsReply: true }),
    ).rejects.toThrow();

    expect(createFollowUpReminder).not.toHaveBeenCalled();
  });

  it("never turns a failed reminder into a failed send", async () => {
    /*
     * The mail has left the building and no local write can recall it, so everything
     * after that point is bookkeeping. The one thing worse than losing a reminder is a
     * user who reads "not sent" about mail that went out and sends it again.
     */
    createFollowUpReminder.mockRejectedValue(new Error("db blip"));

    const result = await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      expectsReply: true,
    });

    expect(result.providerMessageId).toBe("sent_1");
    expect(result.reminderId).toBeNull();
  });

  it("reports null when the thread already had an open reminder", async () => {
    // `createFollowUpReminder` refuses to stack them; the send is unaffected.
    createFollowUpReminder.mockResolvedValue(null);

    const result = await sendReply({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: "ok",
      expectsReply: true,
    });

    expect(result.reminderId).toBeNull();
  });
});
