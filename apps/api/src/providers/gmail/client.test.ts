import { beforeEach, describe, expect, it, vi } from "vitest";
import historyList from "./__fixtures__/history-list.json" with { type: "json" };
import invoiceThread from "./__fixtures__/thread-invoice.json" with { type: "json" };

/**
 * The Gmail provider against recorded responses. `googleapis` is mocked at the
 * module boundary, so these tests assert the request we *would* send and the
 * normalization of what comes back — never a live call.
 */

const getAccessToken = vi.hoisted(() => vi.fn());
const threadsList = vi.hoisted(() => vi.fn());
const threadsGet = vi.hoisted(() => vi.fn());
const historyListFn = vi.hoisted(() => vi.fn());
const getProfileFn = vi.hoisted(() => vi.fn());
const attachmentsGet = vi.hoisted(() => vi.fn());
const setCredentials = vi.hoisted(() => vi.fn());
const messagesSend = vi.hoisted(() => vi.fn());
const draftsCreate = vi.hoisted(() => vi.fn());
const usersWatch = vi.hoisted(() => vi.fn());
const usersStop = vi.hoisted(() => vi.fn());

vi.mock("../tokenManager.js", () => ({ getAccessToken }));

const acquireGmailQuota = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rateLimiter.js", () => ({
  acquireGmailQuota,
  GMAIL_QUOTA_UNITS: {},
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = setCredentials;
      },
    },
    gmail: () => ({
      users: {
        getProfile: getProfileFn,
        threads: { list: threadsList, get: threadsGet },
        history: { list: historyListFn },
        messages: { attachments: { get: attachmentsGet }, send: messagesSend },
        drafts: { create: draftsCreate },
        watch: usersWatch,
        stop: usersStop,
      },
    }),
  },
}));

const TOPIC = "projects/inbox-copilot-test/topics/gmail-push";

const { createGmailProvider } = await import("./client.js");
const { env } = await import("../../lib/env.js");

const CONTEXT = {
  mailAccountId: "mail_1",
  userId: "user_1",
  emailAddress: "person@example.com",
};

describe("GmailProvider", () => {
  beforeEach(() => {
    getAccessToken.mockReset().mockResolvedValue("fresh-access-token");
    threadsList.mockReset();
    threadsGet.mockReset();
    historyListFn.mockReset();
    getProfileFn.mockReset();
    attachmentsGet.mockReset();
    setCredentials.mockReset();
    usersWatch.mockReset();
    usersStop.mockReset();
    // Mutated rather than mocked: `env` is validated once at import, and the code under
    // test reads the topic at call time precisely so it can change.
    env.GMAIL_PUBSUB_TOPIC = TOPIC;
    messagesSend.mockReset();
    draftsCreate.mockReset();
    acquireGmailQuota.mockReset().mockResolvedValue(undefined);
  });

  describe("authentication", () => {
    it("fetches a token through the token manager for every call", async () => {
      getProfileFn.mockResolvedValue({
        data: { emailAddress: "Person@Example.com", historyId: "12345" },
      });
      const provider = createGmailProvider(CONTEXT);

      await provider.getProfile();
      await provider.getProfile();

      expect(getAccessToken).toHaveBeenCalledTimes(2);
      expect(getAccessToken).toHaveBeenCalledWith("mail_1", "user_1");
      // Never cached on the instance: a token expiring mid-backfill is refreshed.
      expect(setCredentials).toHaveBeenCalledWith({ access_token: "fresh-access-token" });
    });
  });

  describe("getProfile", () => {
    it("lowercases the address and returns the history pointer", async () => {
      getProfileFn.mockResolvedValue({
        data: { emailAddress: "Person@Example.com", historyId: "12345" },
      });

      await expect(createGmailProvider(CONTEXT).getProfile()).resolves.toEqual({
        emailAddress: "person@example.com",
        providerAccountId: "person@example.com",
        historyId: "12345",
      });
    });

    it("fails loudly when Gmail returns no address", async () => {
      getProfileFn.mockResolvedValue({ data: {} });

      await expect(createGmailProvider(CONTEXT).getProfile()).rejects.toThrow(
        /no email address/,
      );
    });
  });

  describe("listThreadIds", () => {
    it("asks for the batch size, skips spam and trash, and passes the window", async () => {
      threadsList.mockResolvedValue({
        data: { threads: [{ id: "t1" }, { id: "t2" }], nextPageToken: "page-2" },
      });

      const after = new Date("2025-01-01T00:00:00Z");
      const page = await createGmailProvider(CONTEXT).listThreadIds({ limit: 50, after });

      expect(page).toEqual({ items: ["t1", "t2"], nextPageToken: "page-2" });
      expect(threadsList).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "me",
          maxResults: 50,
          includeSpamTrash: false,
          q: `after:${Math.floor(after.getTime() / 1000)}`,
        }),
        {},
      );
    });

    it("reports the last page as a null cursor", async () => {
      threadsList.mockResolvedValue({ data: { threads: [{ id: "t1" }] } });

      const page = await createGmailProvider(CONTEXT).listThreadIds({ limit: 50 });
      expect(page.nextPageToken).toBeNull();
    });

    it("tolerates an empty mailbox", async () => {
      threadsList.mockResolvedValue({ data: {} });

      await expect(createGmailProvider(CONTEXT).listThreadIds({ limit: 50 })).resolves.toEqual({
        items: [],
        nextPageToken: null,
      });
    });

    it("caps maxResults at Gmail's own limit", async () => {
      threadsList.mockResolvedValue({ data: { threads: [] } });

      await createGmailProvider(CONTEXT).listThreadIds({ limit: 5_000 });
      expect(threadsList).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 500 }),
        {},
      );
    });
  });

  describe("getThread", () => {
    it("requests the full format and returns normalized messages", async () => {
      threadsGet.mockResolvedValue({ data: invoiceThread });

      const thread = await createGmailProvider(CONTEXT).getThread("18f0a1b2c3d4e5f0");

      expect(threadsGet).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "me", id: "18f0a1b2c3d4e5f0", format: "full" }),
        {},
      );
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[0]?.subject).toBe("Invoice 4471 for March");
      expect(thread.messages[1]?.isOutbound).toBe(true);
    });
  });

  describe("getAttachment", () => {
    it("decodes base64url content", async () => {
      attachmentsGet.mockResolvedValue({
        data: { data: Buffer.from("PDF-BYTES").toString("base64url") },
      });

      const buffer = await createGmailProvider(CONTEXT).getAttachment("m1", "a1");
      expect(buffer.toString("utf8")).toBe("PDF-BYTES");
    });

    it("throws when the attachment has no content", async () => {
      attachmentsGet.mockResolvedValue({ data: {} });

      await expect(createGmailProvider(CONTEXT).getAttachment("m1", "a1")).rejects.toThrow(
        /no content/,
      );
    });
  });

  describe("syncDelta", () => {
    it("refuses to run without a history id", async () => {
      // Delta sync with no cursor would silently sync nothing; backfill first.
      await expect(createGmailProvider(CONTEXT).syncDelta(null)).rejects.toThrow(
        /needs a history id/,
      );
      expect(historyListFn).not.toHaveBeenCalled();
    });

    it("calls history.list with startHistoryId and returns the new cursor", async () => {
      historyListFn.mockResolvedValue({ data: historyList });

      const result = await createGmailProvider(CONTEXT).syncDelta("1000000");

      expect(historyListFn).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "me", startHistoryId: "1000000" }),
        {},
      );
      expect(result.cursor).toBe("1000500");
    });

    it("folds records per message so a later delete wins over an earlier add", async () => {
      historyListFn.mockResolvedValue({ data: historyList });

      const { changes } = await createGmailProvider(CONTEXT).syncDelta("1000000");
      const byId = new Map(changes.map((change) => [change.providerMessageId, change]));

      // msg-new-2 was added then deleted inside the same page.
      expect(byId.get("msg-new-2")?.kind).toBe("deleted");
      // msg-new-1 was added then had UNREAD removed: the fetch brings current
      // labels, so it stays a single upsert rather than two changes.
      expect(byId.get("msg-new-1")?.kind).toBe("upserted");
      expect(changes).toHaveLength(3);
    });

    it("reports a label-only change on a message it is not otherwise fetching", async () => {
      historyListFn.mockResolvedValue({ data: historyList });

      const { changes } = await createGmailProvider(CONTEXT).syncDelta("1000000");
      const starred = changes.find((change) => change.providerMessageId === "msg-old-9");

      expect(starred).toEqual({
        kind: "labelsChanged",
        providerMessageId: "msg-old-9",
        providerThreadId: "thread-b",
        labelsAdded: ["STARRED"],
        labelsRemoved: [],
      });
    });

    it("follows pagination until the last page", async () => {
      historyListFn
        .mockResolvedValueOnce({
          data: {
            historyId: "2000",
            nextPageToken: "h2",
            history: [
              { id: "1", messagesAdded: [{ message: { id: "a", threadId: "ta" } }] },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            historyId: "2100",
            history: [{ id: "2", messagesAdded: [{ message: { id: "b", threadId: "tb" } }] }],
          },
        });

      const result = await createGmailProvider(CONTEXT).syncDelta("1000");

      expect(historyListFn).toHaveBeenCalledTimes(2);
      expect(result.changes).toHaveLength(2);
      expect(result.cursor).toBe("2100");
    });

    it("keeps the old cursor when Gmail reports no change at all", async () => {
      historyListFn.mockResolvedValue({ data: {} });

      const result = await createGmailProvider(CONTEXT).syncDelta("1000");
      expect(result).toEqual({ changes: [], cursor: "1000" });
    });

    it("ignores history entries with no usable ids", async () => {
      historyListFn.mockResolvedValue({
        data: { historyId: "5", history: [{ id: "1", messagesAdded: [{ message: {} }] }] },
      });

      const result = await createGmailProvider(CONTEXT).syncDelta("1");
      expect(result.changes).toEqual([]);
    });
  });

  describe("quota pacing", () => {
    it("spends the method's quota before every call", async () => {
      getProfileFn.mockResolvedValue({ data: { emailAddress: "p@e.test", historyId: "1" } });
      threadsList.mockResolvedValue({ data: { threads: [] } });
      threadsGet.mockResolvedValue({ data: invoiceThread });
      const provider = createGmailProvider(CONTEXT);

      await provider.getProfile();
      await provider.listThreadIds({ limit: 50 });
      await provider.getThread("t1");

      // Pacing is the primary defense, so it happens on the way in — not after a
      // rejection comes back.
      expect(acquireGmailQuota.mock.calls.map((call) => call[1])).toEqual([
        "users.getProfile",
        "users.threads.list",
        "users.threads.get",
      ]);
      expect(acquireGmailQuota.mock.calls.every((call) => call[0] === "mail_1")).toBe(true);
    });

    it("acquires before the request is made, not alongside it", async () => {
      const order: string[] = [];
      acquireGmailQuota.mockImplementation(async () => {
        order.push("acquire");
      });
      getProfileFn.mockImplementation(async () => {
        order.push("request");
        return { data: { emailAddress: "p@e.test", historyId: "1" } };
      });

      await createGmailProvider(CONTEXT).getProfile();

      expect(order).toEqual(["acquire", "request"]);
    });

    it("pays quota again for a retried call, because it is another request", async () => {
      const rateLimited = Object.assign(new Error("rate limited"), {
        response: { status: 429, headers: { "retry-after": "0" } },
      });
      threadsGet.mockRejectedValueOnce(rateLimited).mockResolvedValue({ data: invoiceThread });

      await createGmailProvider(CONTEXT).getThread("t1");

      expect(acquireGmailQuota).toHaveBeenCalledTimes(2);
    }, 10_000);
  });

  describe("cancellation", () => {
    it("passes the signal to Gaxios so an in-flight request can be dropped", async () => {
      const controller = new AbortController();
      threadsGet.mockResolvedValue({ data: invoiceThread });

      await createGmailProvider({ ...CONTEXT, signal: controller.signal }).getThread("t1");

      expect(threadsGet).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t1" }),
        { signal: controller.signal },
      );
    });

    it("passes the signal to the quota wait, so a cancelled job stops queueing", async () => {
      const controller = new AbortController();
      getProfileFn.mockResolvedValue({ data: { emailAddress: "p@e.test", historyId: "1" } });

      await createGmailProvider({ ...CONTEXT, signal: controller.signal }).getProfile();

      expect(acquireGmailQuota).toHaveBeenCalledWith(
        "mail_1",
        "users.getProfile",
        controller.signal,
      );
    });

    it("omits request options entirely when there is no signal", async () => {
      getProfileFn.mockResolvedValue({ data: { emailAddress: "p@e.test", historyId: "1" } });

      await createGmailProvider(CONTEXT).getProfile();

      expect(getProfileFn).toHaveBeenCalledWith({ userId: "me" }, {});
    });
  });

  describe("sending", () => {
    /** The raw message Gmail was handed, decoded back into text. */
    function sentMime(): string {
      const raw = messagesSend.mock.calls[0]?.[0]?.requestBody?.raw as string;
      return Buffer.from(raw, "base64url").toString("utf8");
    }

    beforeEach(() => {
      messagesSend.mockResolvedValue({ data: { id: "m_99", threadId: "t_1" } });
    });

    it("sends a base64url-encoded message and returns the provider ids", async () => {
      const result = await createGmailProvider(CONTEXT).sendMessage({
        to: [{ name: "Ada", email: "ada@example.test" }],
        subject: "Re: invoice",
        bodyHtml: "<p>Paid.</p>",
        bodyText: "Paid.",
      });

      expect(result).toEqual({ providerMessageId: "m_99", providerThreadId: "t_1" });

      const mime = sentMime();
      expect(mime).toContain('To: "Ada" <ada@example.test>');
      // The From is the mailbox, from the context — never an argument.
      expect(mime).toContain("From: person@example.com");
      expect(mime).toContain("Subject: Re: invoice");
      expect(mime).toContain("Content-Type: multipart/alternative");
    });

    it("threads a reply on In-Reply-To, References and Gmail's threadId", async () => {
      await createGmailProvider(CONTEXT).sendMessage({
        to: [{ email: "ada@example.test" }],
        subject: "Re: invoice",
        bodyHtml: "<p>ok</p>",
        inReplyTo: {
          providerThreadId: "t_1",
          internetMessageId: "<parent@mail.example>",
          references: ["<first@mail.example>"],
        },
      });

      const mime = sentMime();
      expect(mime).toContain("In-Reply-To: <parent@mail.example>");
      // The chain, parent appended: other clients thread on this, not on threadId.
      expect(mime).toContain("References: <first@mail.example> <parent@mail.example>");
      expect(messagesSend.mock.calls[0]?.[0]?.requestBody?.threadId).toBe("t_1");
    });

    it("does not repeat the parent when the caller's chain already ends with it", async () => {
      /*
       * `services/send.ts` builds the whole chain, parent included. Appending it again
       * here produced `References: <parent> <parent>` — found by sending a real
       * self-addressed pair and reading the headers Gmail stored.
       */
      await createGmailProvider(CONTEXT).sendMessage({
        to: [{ email: "ada@example.test" }],
        subject: "Re: invoice",
        bodyHtml: "<p>ok</p>",
        inReplyTo: {
          providerThreadId: "t_1",
          internetMessageId: "<parent@mail.example>",
          references: ["<first@mail.example>", "<parent@mail.example>"],
        },
      });

      const references = /References: (.*)/.exec(sentMime())?.[1] ?? "";
      expect(references).toBe("<first@mail.example> <parent@mail.example>");
      expect(references.match(/<parent@mail.example>/g)).toHaveLength(1);
    });

    it("sends no threadId for a message that is not a reply", async () => {
      await createGmailProvider(CONTEXT).sendMessage({
        to: [{ email: "ada@example.test" }],
        subject: "New",
        bodyHtml: "<p>hi</p>",
      });

      expect(messagesSend.mock.calls[0]?.[0]?.requestBody).not.toHaveProperty("threadId");
      expect(sentMime()).not.toContain("In-Reply-To");
    });

    it("derives a plain-text part when the caller supplies only HTML", async () => {
      await createGmailProvider(CONTEXT).sendMessage({
        to: [{ email: "ada@example.test" }],
        subject: "New",
        bodyHtml: "<p>Hello there</p>",
      });

      const mime = sentMime();
      const parts = mime.split(/--=_inbox_copilot_[0-9a-f]+/);
      const textPart = parts.find((part) => part.includes("text/plain")) ?? "";
      const body = Buffer.from(
        textPart.split("\r\n\r\n")[1]?.trim() ?? "",
        "base64",
      ).toString("utf8");
      expect(body).toContain("Hello there");
    });

    it("spends the documented send quota", async () => {
      await createGmailProvider(CONTEXT).sendMessage({
        to: [{ email: "ada@example.test" }],
        subject: "x",
        bodyHtml: "<p>y</p>",
      });

      expect(acquireGmailQuota).toHaveBeenCalledWith(
        "mail_1",
        "users.messages.send",
        undefined,
      );
    });

    it("makes exactly one attempt, even on an error that would normally retry", async () => {
      /*
       * The point of the whole `callOnce` path. A 429 is retryable for every read in
       * this file; for a send it is not, because the failure may be on the response
       * path and the message may already be out. One attempt, then tell the caller.
       */
      messagesSend.mockReset().mockRejectedValue(
        Object.assign(new Error("rate limit"), { response: { status: 429 } }),
      );

      await expect(
        createGmailProvider(CONTEXT).sendMessage({
          to: [{ email: "ada@example.test" }],
          subject: "x",
          bodyHtml: "<p>y</p>",
        }),
      ).rejects.toThrow(/rate limit/);

      expect(messagesSend).toHaveBeenCalledTimes(1);
    });

    it("refuses a recipient carrying header syntax", async () => {
      await expect(
        createGmailProvider(CONTEXT).sendMessage({
          to: [{ email: "ada@example.test>, victim@evil.test" }],
          subject: "x",
          bodyHtml: "<p>y</p>",
        }),
      ).rejects.toThrow(/Invalid email address/);

      expect(messagesSend).not.toHaveBeenCalled();
    });

    it("treats a send with no returned ids as an upstream fault", async () => {
      messagesSend.mockReset().mockResolvedValue({ data: {} });

      await expect(
        createGmailProvider(CONTEXT).sendMessage({
          to: [{ email: "ada@example.test" }],
          subject: "x",
          bodyHtml: "<p>y</p>",
        }),
      ).rejects.toThrow(/returned no ids/);
    });
  });

  describe("drafts", () => {
    it("creates a draft with the same MIME and returns its id", async () => {
      draftsCreate.mockResolvedValue({ data: { id: "d_1" } });

      const result = await createGmailProvider(CONTEXT).createDraft({
        to: [{ email: "ada@example.test" }],
        subject: "Draft",
        bodyHtml: "<p>later</p>",
        inReplyTo: { providerThreadId: "t_2", internetMessageId: "<p@m.example>" },
      });

      expect(result).toEqual({ draftId: "d_1" });
      const message = draftsCreate.mock.calls[0]?.[0]?.requestBody?.message;
      expect(message?.threadId).toBe("t_2");
      expect(Buffer.from(message?.raw as string, "base64url").toString("utf8")).toContain(
        "In-Reply-To: <p@m.example>",
      );
      expect(acquireGmailQuota).toHaveBeenCalledWith(
        "mail_1",
        "users.drafts.create",
        undefined,
      );
    });
  });

  describe("watching", () => {
    it("asks Gmail to publish to the configured topic and reports the expiry", async () => {
      // Seven days out, as epoch milliseconds in a string — Gmail's own shape.
      const expiration = String(Date.now() + 7 * 24 * 60 * 60_000);
      usersWatch.mockResolvedValue({ data: { expiration, historyId: "99123" } });

      const result = await createGmailProvider(CONTEXT).startWatch();

      expect(usersWatch).toHaveBeenCalledWith(
        { userId: "me", requestBody: { topicName: TOPIC } },
        {},
      );
      expect(result.cursor).toBe("99123");
      expect(result.expiresAt.getTime()).toBe(Number(expiration));
      expect(acquireGmailQuota).toHaveBeenCalledWith("mail_1", "users.watch", undefined);
    });

    it("sets no label filter, so sent mail is pushed too", async () => {
      // Watching INBOX alone would be cheaper and would make the user's own sent mail
      // invisible to push — which is what the writing-style profile is built from.
      usersWatch.mockResolvedValue({
        data: { expiration: String(Date.now() + 1000), historyId: "1" },
      });

      await createGmailProvider(CONTEXT).startWatch();

      const body = usersWatch.mock.calls[0]?.[0]?.requestBody as Record<string, unknown>;
      expect(body).not.toHaveProperty("labelIds");
      expect(body).not.toHaveProperty("labelFilterAction");
    });

    it("refuses when no Pub/Sub topic is configured", async () => {
      env.GMAIL_PUBSUB_TOPIC = "";

      await expect(createGmailProvider(CONTEXT).startWatch()).rejects.toThrow(
        /GMAIL_PUBSUB_TOPIC is not set/,
      );
      expect(usersWatch).not.toHaveBeenCalled();
    });

    it("treats a watch with no expiration as an upstream fault", async () => {
      usersWatch.mockResolvedValue({ data: { historyId: "1" } });

      await expect(createGmailProvider(CONTEXT).startWatch()).rejects.toThrow(
        /no expiration or history id/,
      );
    });

    it("rejects an unreadable expiration rather than storing an invalid date", async () => {
      // A NaN expiry would be written to `watchExpiresAt` and make every renewal check
      // false, which is a watch that silently never renews.
      usersWatch.mockResolvedValue({ data: { expiration: "soon", historyId: "1" } });

      await expect(createGmailProvider(CONTEXT).startWatch()).rejects.toThrow(
        /unreadable expiration/,
      );
    });

    it("stops the watch with no argument, because Gmail has no watch id", async () => {
      usersStop.mockResolvedValue({});

      await createGmailProvider(CONTEXT).stopWatch();

      expect(usersStop).toHaveBeenCalledWith({ userId: "me" }, {});
      expect(acquireGmailQuota).toHaveBeenCalledWith("mail_1", "users.stop", undefined);
    });
  });

  describe("an expired history id", () => {
    it("becomes a typed expired-cursor error, not a generic 404", async () => {
      /*
       * Gmail keeps about a week of history and answers 404 for anything older. Left as
       * a generic 404 this reads as "mailbox not found", burns job attempts, and leaves
       * the mailbox frozen — so it becomes the one error the delta worker recovers from
       * by re-syncing.
       */
      historyListFn.mockRejectedValue(
        Object.assign(new Error("Requested entity was not found"), {
          response: { status: 404 },
        }),
      );

      await expect(createGmailProvider(CONTEXT).syncDelta("12345")).rejects.toThrow(
        /history id is too old/,
      );
      // Not retried: a 404 is permanent and `withRetry` knows it.
      expect(historyListFn).toHaveBeenCalledTimes(1);
    });

    it("lets other history failures through as themselves", async () => {
      // 400 rather than 500 on purpose: a 5xx is retryable, so asserting on it here
      // would make this test sit through the real backoff curve.
      historyListFn.mockRejectedValue(
        Object.assign(new Error("boom"), { response: { status: 400 } }),
      );

      await expect(createGmailProvider(CONTEXT).syncDelta("12345")).rejects.toThrow(/boom/);
    });
  });

  describe("methods belonging to later phases", () => {
    it("refuses to modify labels", async () => {
      await expect(createGmailProvider(CONTEXT).modifyLabels("t", [], [])).rejects.toThrow(
        /not implemented/,
      );
    });
  });
});
