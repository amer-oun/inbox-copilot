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

vi.mock("../tokenManager.js", () => ({ getAccessToken }));

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
        messages: { attachments: { get: attachmentsGet } },
      },
    }),
  },
}));

const { createGmailProvider } = await import("./client.js");

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
      expect(threadsList).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 500 }));
    });
  });

  describe("getThread", () => {
    it("requests the full format and returns normalized messages", async () => {
      threadsGet.mockResolvedValue({ data: invoiceThread });

      const thread = await createGmailProvider(CONTEXT).getThread("18f0a1b2c3d4e5f0");

      expect(threadsGet).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "me", id: "18f0a1b2c3d4e5f0", format: "full" }),
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

  describe("methods belonging to later phases", () => {
    it("refuses to send, draft, modify labels or watch", async () => {
      const provider = createGmailProvider(CONTEXT);

      await expect(
        provider.sendMessage({ to: [{ email: "a@b.test" }], subject: "x", bodyHtml: "y" }),
      ).rejects.toThrow(/phase 6/);
      await expect(
        provider.createDraft({ to: [{ email: "a@b.test" }], subject: "x", bodyHtml: "y" }),
      ).rejects.toThrow(/phase 6/);
      await expect(provider.modifyLabels("t", [], [])).rejects.toThrow(/phase 6/);
      await expect(provider.startWatch()).rejects.toThrow(/phase 7/);
      await expect(provider.stopWatch()).rejects.toThrow(/phase 7/);
    });
  });
});
