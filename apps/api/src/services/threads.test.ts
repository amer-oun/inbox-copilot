import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inbox reads, with Prisma stubbed.
 *
 * The pagination is what gets the attention. The list is sorted by a score the
 * enrichment worker is still writing, so rows move between requests: an `offset`
 * would silently drop or repeat threads, and a keyset cursor only works if its
 * "strictly after" predicate is right — including for the unscored rows that sort
 * last. Those cases are asserted individually because the failure they produce is
 * a missing email, which nobody reports as a bug.
 */

const threadFindMany = vi.hoisted(() => vi.fn());
const threadFindFirst = vi.hoisted(() => vi.fn());
/**
 * `UserSettings.translationLang`, which `getThread` reads for the language control's
 * default. Resolves to null by default — a user who has set no default language is the
 * normal starting state, and the read must not depend on the row existing.
 */
const settingsFindFirst = vi.hoisted(() => vi.fn(async () => null));
const tenantCalls = vi.hoisted(() => [] as string[]);

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: (userId: string) => {
    tenantCalls.push(userId);
    return {
      thread: { findMany: threadFindMany, findFirst: threadFindFirst },
      // The thread read also asks for the user's default translation language (§9).
      userSettings: { findFirst: settingsFindFirst },
    };
  },
  Prisma: {},
}));

const { decodeCursor, encodeCursor, getThread, listThreads, DEFAULT_PAGE_SIZE } =
  await import("./threads.js");
const { BadRequestError, NotFoundError } = await import("../lib/errors.js");

const USER_ID = "user_1";

/** A thread row as `LIST_SELECT` returns it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "cm00000000000000000000001",
    subject: "Invoice 4471",
    snippet: "Could you send a revised invoice",
    messageCount: 2,
    lastMessageAt: new Date("2026-09-12T09:00:00Z"),
    isRead: false,
    isStarred: false,
    category: "FINANCE",
    priority: "HIGH",
    priorityScore: 72,
    needsReply: true,
    language: "en",
    threatLevel: "UNKNOWN",
    messages: [
      {
        fromName: "Dana Whitfield",
        fromEmail: "dana@northwind.example",
        hasAttachments: true,
      },
    ],
    summaries: [{ headline: "Invoice 4471 disputed" }],
    ...overrides,
  };
}

/** `count` rows in the order the query would return them: score desc, then older. */
function rows(count: number) {
  const newest = Date.parse("2026-09-12T09:00:00Z");
  return Array.from({ length: count }, (_, index) =>
    row({
      id: `cm${String(index).padStart(23, "0")}`,
      priorityScore: 90 - index,
      lastMessageAt: new Date(newest - index * 3_600_000),
    }),
  );
}

/** The `where` of the last findMany call. */
function where(): Record<string, unknown> {
  return threadFindMany.mock.calls.at(-1)?.[0].where;
}

beforeEach(() => {
  tenantCalls.length = 0;
  threadFindMany.mockReset().mockResolvedValue([row()]);
  threadFindFirst.mockReset();
  settingsFindFirst.mockReset().mockResolvedValue(null);
});

describe("listThreads ordering", () => {
  it("sorts by priority score, then recency, then id", async () => {
    await listThreads({ userId: USER_ID, category: "ALL" });

    expect(threadFindMany.mock.calls[0]?.[0].orderBy).toEqual([
      // NULLS LAST matters: an unenriched thread has no score and must not lead.
      { priorityScore: { sort: "desc", nulls: "last" } },
      { lastMessageAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("reads through the tenancy client", async () => {
    await listThreads({ userId: USER_ID, category: "ALL" });
    expect(tenantCalls).toEqual([USER_ID]);
  });

  it("filters by category, and does not filter for ALL", async () => {
    await listThreads({ userId: USER_ID, category: "WORK" });
    expect(where()).toMatchObject({ category: "WORK" });

    await listThreads({ userId: USER_ID, category: "ALL" });
    expect(where()).not.toHaveProperty("category");
  });

  it("excludes trashed threads", async () => {
    // Trash is not an empty category; it is mail the user threw away.
    await listThreads({ userId: USER_ID, category: "ALL" });
    expect(where()).toMatchObject({ isTrashed: false });
  });
});

describe("listThreads pagination", () => {
  it("asks for one row more than it returns", async () => {
    // That extra row is how "is there a next page" is answered without a count().
    threadFindMany.mockResolvedValue(rows(26));

    const page = await listThreads({ userId: USER_ID, category: "ALL" });

    expect(threadFindMany.mock.calls[0]?.[0].take).toBe(DEFAULT_PAGE_SIZE + 1);
    expect(page.items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(page.nextCursor).not.toBeNull();
  });

  it("reports no next cursor on the last page", async () => {
    threadFindMany.mockResolvedValue(rows(3));

    const page = await listThreads({ userId: USER_ID, category: "ALL", limit: 25 });

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("reports no next cursor for an empty inbox", async () => {
    threadFindMany.mockResolvedValue([]);

    const page = await listThreads({ userId: USER_ID, category: "ALL" });

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("builds the cursor from the last returned row, not the extra one", async () => {
    const page = rows(4);
    threadFindMany.mockResolvedValue(page);

    const result = await listThreads({ userId: USER_ID, category: "ALL", limit: 3 });

    // Row index 2 is the last *returned* row; index 3 only proved a page follows.
    expect(decodeCursor(result.nextCursor as string)).toEqual({
      score: page[2]?.priorityScore,
      lastMessageAt: page[2]?.lastMessageAt.toISOString(),
      id: page[2]?.id,
    });
  });

  it("continues strictly after a scored cursor", async () => {
    const cursor = encodeCursor({
      score: 72,
      lastMessageAt: "2026-09-12T09:00:00.000Z",
      id: "cm00000000000000000000005",
    });

    await listThreads({ userId: USER_ID, category: "ALL", cursor });

    expect(where()["OR"]).toEqual([
      // Lower score…
      { priorityScore: { lt: 72 } },
      // …or the same score, later in the tie-break…
      {
        priorityScore: 72,
        OR: [
          { lastMessageAt: { lt: new Date("2026-09-12T09:00:00.000Z") } },
          {
            lastMessageAt: new Date("2026-09-12T09:00:00.000Z"),
            id: { lt: "cm00000000000000000000005" },
          },
        ],
      },
      // …or unscored, which sorts after everything scored.
      { priorityScore: null },
    ]);
  });

  it("stays among unscored threads once the cursor is unscored", async () => {
    // With NULLS LAST there is nothing after the unscored block, so re-including
    // scored rows here would resend the whole first page.
    const cursor = encodeCursor({
      score: null,
      lastMessageAt: "2026-09-01T09:00:00.000Z",
      id: "cm00000000000000000000009",
    });

    await listThreads({ userId: USER_ID, category: "ALL", cursor });

    expect(where()).toMatchObject({ priorityScore: null });
    expect(where()["OR"]).toEqual([
      { lastMessageAt: { lt: new Date("2026-09-01T09:00:00.000Z") } },
      {
        lastMessageAt: new Date("2026-09-01T09:00:00.000Z"),
        id: { lt: "cm00000000000000000000009" },
      },
    ]);
  });

  it("keeps the category filter on later pages", async () => {
    const cursor = encodeCursor({
      score: 10,
      lastMessageAt: "2026-09-12T09:00:00.000Z",
      id: "cm00000000000000000000005",
    });

    await listThreads({ userId: USER_ID, category: "NEWSLETTER", cursor });

    expect(where()).toMatchObject({ category: "NEWSLETTER", isTrashed: false });
  });

  it("round-trips a cursor with a null score", async () => {
    const cursor = { score: null, lastMessageAt: "2026-09-12T09:00:00.000Z", id: "abc" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["not base64", "!!!!"],
    ["base64 of nonsense", Buffer.from("nonsense").toString("base64url")],
    [
      "missing id",
      Buffer.from(JSON.stringify({ score: 1, lastMessageAt: "2026-01-01" })).toString(
        "base64url",
      ),
    ],
    [
      "bad date",
      Buffer.from(JSON.stringify({ score: 1, lastMessageAt: "soon", id: "a" })).toString(
        "base64url",
      ),
    ],
    [
      "non-integer score",
      Buffer.from(
        JSON.stringify({ score: 1.5, lastMessageAt: "2026-01-01", id: "a" }),
      ).toString("base64url"),
    ],
    ["array", Buffer.from(JSON.stringify([1, 2])).toString("base64url")],
  ])("rejects a malformed cursor (%s) with 400", (_label, cursor) => {
    // Cursors come from the browser: a bad one is a bad request, never a crash and
    // never a query that quietly loses its filter.
    expect(() => decodeCursor(cursor)).toThrow(BadRequestError);
  });
});

describe("listThreads rows", () => {
  it("shows the newest inbound sender, not the user's own reply", async () => {
    await listThreads({ userId: USER_ID, category: "ALL" });

    expect(threadFindMany.mock.calls[0]?.[0].select.messages).toMatchObject({
      where: { isOutbound: false },
      orderBy: { sentAt: "desc" },
      take: 1,
    });
  });

  it("maps a row to the list DTO", async () => {
    const page = await listThreads({ userId: USER_ID, category: "ALL" });

    expect(page.items[0]).toEqual({
      id: "cm00000000000000000000001",
      subject: "Invoice 4471",
      snippet: "Could you send a revised invoice",
      from: { name: "Dana Whitfield", email: "dana@northwind.example" },
      messageCount: 2,
      lastMessageAt: "2026-09-12T09:00:00.000Z",
      isRead: false,
      isStarred: false,
      hasAttachments: true,
      category: "FINANCE",
      priority: "HIGH",
      priorityScore: 72,
      needsReply: true,
      language: "en",
      threatLevel: "UNKNOWN",
      summaryHeadline: "Invoice 4471 disputed",
    });
  });

  it("handles a thread with no summary and no inbound message", async () => {
    // A thread of only sent mail has no inbound sender; the row must still render.
    threadFindMany.mockResolvedValue([row({ messages: [], summaries: [] })]);

    const page = await listThreads({ userId: USER_ID, category: "ALL" });

    expect(page.items[0]?.from).toBeNull();
    expect(page.items[0]?.summaryHeadline).toBeNull();
    expect(page.items[0]?.hasAttachments).toBe(false);
  });

  it("handles an unenriched thread", async () => {
    threadFindMany.mockResolvedValue([
      row({ category: null, priority: null, priorityScore: null, language: null }),
    ]);

    const page = await listThreads({ userId: USER_ID, category: "ALL" });

    expect(page.items[0]).toMatchObject({
      category: null,
      priority: null,
      priorityScore: null,
      language: null,
    });
  });
});

describe("getThread", () => {
  function detailRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "cm00000000000000000000001",
      subject: "Invoice 4471",
      participants: [
        { name: "Dana Whitfield", email: "dana@northwind.example", role: "from" },
        { name: null, email: "me@example.com", role: "to" },
      ],
      messageCount: 1,
      firstMessageAt: new Date("2026-09-10T09:00:00Z"),
      lastMessageAt: new Date("2026-09-12T09:00:00Z"),
      isRead: true,
      isStarred: false,
      category: "FINANCE",
      priority: "HIGH",
      priorityScore: 72,
      needsReply: true,
      language: "en",
      threatLevel: "UNKNOWN",
      mailAccount: { emailAddress: "me@example.com" },
      messages: [
        {
          id: "cm00000000000000000000010",
          fromName: "Dana Whitfield",
          fromEmail: "dana@northwind.example",
          to: ["me@example.com"],
          cc: [],
          replyTo: null,
          subject: "Invoice 4471",
          sentAt: new Date("2026-09-10T09:00:00Z"),
          isRead: true,
          isOutbound: false,
          bodyText: "Could you send a revised invoice?",
          bodyHtml:
            '<p onclick="alert(1)">Revised invoice?</p><img src="https://t.example/p.gif">',
          attachments: [],
        },
      ],
      summaries: [
        {
          headline: "Invoice 4471 disputed",
          summary: "Dana flagged the licence count.",
          keyPoints: ["14 billed, 12 on the PO"],
          actionItems: [{ text: "Reissue the invoice", owner: "user" }],
          model: "claude-sonnet-5",
          createdAt: new Date("2026-09-12T10:00:00Z"),
        },
      ],
      ...overrides,
    };
  }

  it("returns the thread with messages oldest first", async () => {
    threadFindFirst.mockResolvedValue(detailRow());

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    expect(threadFindFirst.mock.calls[0]?.[0].select.messages.orderBy).toEqual({
      sentAt: "asc",
    });
    expect(thread.messages).toHaveLength(1);
    expect(thread.summary?.headline).toBe("Invoice 4471 disputed");
  });

  it("sanitizes message HTML on the way out", async () => {
    threadFindFirst.mockResolvedValue(detailRow());

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });
    const body = thread.messages[0]?.bodyHtmlSanitized ?? "";

    // The stored row keeps what the sender sent; the wire gets it cleaned.
    expect(body).not.toContain("onclick");
    expect(body).toContain("Revised invoice?");
    expect(thread.messages[0]?.blockedRemoteImages).toBe(1);
  });

  it("never exposes a raw bodyHtml field", async () => {
    // The DTO's field is named `bodyHtmlSanitized` precisely so that nothing
    // downstream can reach for unsanitized HTML — there is none to reach for.
    threadFindFirst.mockResolvedValue(detailRow());

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    expect(thread.messages[0]).not.toHaveProperty("bodyHtml");
    expect(JSON.stringify(thread)).not.toContain("onclick");
  });

  it("reports a plain-text-only message with no HTML", async () => {
    const base = detailRow();
    threadFindFirst.mockResolvedValue({
      ...base,
      messages: [{ ...base.messages[0], bodyHtml: null }],
    });

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    expect(thread.messages[0]?.bodyHtmlSanitized).toBeNull();
    expect(thread.messages[0]?.bodyText).toContain("revised invoice");
    expect(thread.messages[0]?.blockedRemoteImages).toBe(0);
  });

  it("returns no assessment for a thread nothing has assessed", async () => {
    // Null rather than an all-clear: the UI must be able to tell "we have not looked" from
    // "we looked and it was fine".
    threadFindFirst.mockResolvedValue(detailRow());

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    expect(thread.threat).toBeNull();
  });

  it("carries the threat evidence, not just the level", async () => {
    /*
     * §6's product requirement reaching the wire: a score teaches a reader nothing, and the
     * reason list is what they can carry to the next inbox. The rule score travels
     * separately from the final one so the UI can show where the model raised the verdict.
     */
    const base = detailRow();
    threadFindFirst.mockResolvedValue({
      ...base,
      threatLevel: "PHISHING",
      messages: [
        {
          ...base.messages[0],
          classification: {
            threatLevel: "PHISHING",
            threatScore: 85,
            threatReasons: [
              "DMARC failed: northwind.example says this did not come from them.",
              "A link that reads northwind.example actually goes to evil.test.",
            ],
            ruleSignals: { version: 1, score: 75, floor: "SUSPICIOUS" },
            threatIntent: "INVOICE_FRAUD",
            threatExplanation:
              "The bank details differ from the ones on your earlier invoices.",
            threatModel: "claude-opus-5",
          },
          threatAppeal: null,
        },
      ],
    });

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    expect(thread.threat).toMatchObject({
      messageId: "cm00000000000000000000010",
      level: "PHISHING",
      score: 85,
      intent: "INVOICE_FRAUD",
      ruleScore: 75,
      ruleFloor: "SUSPICIOUS",
      appeal: null,
    });
    expect(thread.threat?.reasons).toHaveLength(2);
  });

  it("reports an appeal without changing the verdict it disagrees with", async () => {
    const base = detailRow();
    threadFindFirst.mockResolvedValue({
      ...base,
      messages: [
        {
          ...base.messages[0],
          classification: {
            threatLevel: "SUSPICIOUS",
            threatScore: 57,
            threatReasons: ["No DMARC result."],
            ruleSignals: { version: 1, score: 57, floor: "SUSPICIOUS" },
            threatIntent: "BENIGN_TRANSACTIONAL",
            threatExplanation: "Reads like a normal receipt.",
            threatModel: "claude-sonnet-5",
          },
          threatAppeal: {
            createdAt: new Date("2026-09-15T10:00:00Z"),
            note: null,
            claimedLevel: "SUSPICIOUS",
            claimedScore: 57,
          },
        },
      ],
    });

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    // The verdict stands in the data; the banner is what stands down.
    expect(thread.threat?.level).toBe("SUSPICIOUS");
    expect(thread.threat?.appeal?.claimedLevel).toBe("SUSPICIOUS");
  });

  it("tells the UI who a reply would go to", async () => {
    threadFindFirst.mockResolvedValue(detailRow());
    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    expect(thread.replyRecipients).toEqual([
      { name: "Dana Whitfield", email: "dana@northwind.example" },
    ]);
  });

  it("honours Reply-To, so the composer shows the address the send will use", async () => {
    const base = detailRow();
    threadFindFirst.mockResolvedValue({
      ...base,
      messages: [{ ...base.messages[0], replyTo: "Billing <billing@northwind.example>" }],
    });

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    // Computed by the send path's own function, so the address on the button cannot
    // disagree with the address the reply is actually addressed to.
    expect(thread.replyRecipients).toEqual([
      { name: "Billing", email: "billing@northwind.example" },
    ]);
  });

  it("reports nobody to reply to rather than failing the read", async () => {
    // A thread of the user's own mail to themselves. The composer hides itself; the
    // thread still opens, because the user came here to read it.
    const base = detailRow();
    threadFindFirst.mockResolvedValue({
      ...base,
      messages: [
        {
          ...base.messages[0],
          isOutbound: true,
          fromName: null,
          fromEmail: "me@example.com",
          to: ["me@example.com"],
        },
      ],
    });

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });
    expect(thread.replyRecipients).toEqual([]);
  });

  it("returns null summary for a thread below the threshold", async () => {
    threadFindFirst.mockResolvedValue(detailRow({ summaries: [] }));

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });
    expect(thread.summary).toBeNull();
  });

  it("404s for another user's thread", async () => {
    // The tenancy filter makes it simply not exist.
    threadFindFirst.mockResolvedValue(null);

    await expect(
      getThread({ userId: USER_ID, threadId: "cm00000000000000000000001" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("survives a malformed participants column", async () => {
    // It is our JSON, but shaped from sender-supplied headers.
    threadFindFirst.mockResolvedValue(
      detailRow({
        participants: ["nonsense", { email: 42 }, { email: "ok@example.com" }],
      }),
    );

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });

    expect(thread.participants).toEqual([{ name: null, email: "ok@example.com" }]);
  });

  it("survives participants being something other than an array", async () => {
    threadFindFirst.mockResolvedValue(detailRow({ participants: null }));

    const thread = await getThread({
      userId: USER_ID,
      threadId: "cm00000000000000000000001",
    });
    expect(thread.participants).toEqual([]);
  });
});
