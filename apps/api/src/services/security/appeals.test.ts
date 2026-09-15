import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The appeal path (§6).
 *
 * The behaviour worth pinning is what this does *not* do: it must not touch the verdict.
 * An assessment that rewrites itself when somebody clicks "safe" destroys the only record
 * of a false positive, and a false-positive rate nobody can measure is a detector nobody
 * can improve.
 */

const messageFindFirst = vi.hoisted(() => vi.fn());
const appealFindFirst = vi.hoisted(() => vi.fn());
const appealCreate = vi.hoisted(() => vi.fn());
const appealUpdateMany = vi.hoisted(() => vi.fn());
const classificationUpdate = vi.hoisted(() => vi.fn());
const threadUpdate = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    message: { findFirst: messageFindFirst },
    threatAppeal: {
      findFirst: appealFindFirst,
      create: appealCreate,
      updateMany: appealUpdateMany,
    },
    // Present but never expected to be called: the point of the test below is that
    // recording an appeal reaches neither of these.
    aiClassification: { update: classificationUpdate },
    thread: { update: threadUpdate },
  }),
  Prisma: {},
}));

const { recordThreatAppeal } = await import("./appeals.js");

const USER_ID = "user_1";
const MESSAGE_ID = "msg_1";

function flagged(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    threadId: "thread_1",
    classification: {
      threatLevel: "SUSPICIOUS",
      threatScore: 57,
      threatReasons: ["DMARC failed.", "A link goes somewhere else."],
      ...overrides,
    },
  };
}

beforeEach(() => {
  messageFindFirst.mockReset().mockResolvedValue(flagged());
  appealFindFirst.mockReset().mockResolvedValue(null);
  appealCreate.mockReset().mockResolvedValue({
    createdAt: new Date("2026-09-15T10:00:00Z"),
    note: null,
    claimedLevel: "SUSPICIOUS",
    claimedScore: 57,
  });
  appealUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  classificationUpdate.mockReset();
  threadUpdate.mockReset();
});

describe("recordThreatAppeal", () => {
  it("records the verdict as the user saw it", async () => {
    const result = await recordThreatAppeal({ userId: USER_ID, messageId: MESSAGE_ID });

    expect(result.appeal.claimedLevel).toBe("SUSPICIOUS");
    expect(appealCreate.mock.calls[0]?.[0].data).toMatchObject({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      claimedLevel: "SUSPICIOUS",
      claimedScore: 57,
      // The reasons they were shown, so the appeal can be read back against what we
      // actually told them.
      shownReasons: ["DMARC failed.", "A link goes somewhere else."],
      note: null,
    });
  });

  it("does not change the verdict", async () => {
    await recordThreatAppeal({ userId: USER_ID, messageId: MESSAGE_ID });

    expect(classificationUpdate).not.toHaveBeenCalled();
    expect(threadUpdate).not.toHaveBeenCalled();
  });

  it("keeps an optional note", async () => {
    appealCreate.mockResolvedValue({
      createdAt: new Date("2026-09-15T10:00:00Z"),
      note: "I know this sender",
      claimedLevel: "SUSPICIOUS",
      claimedScore: 57,
    });

    const result = await recordThreatAppeal({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      note: "I know this sender",
    });

    expect(result.appeal.note).toBe("I know this sender");
  });

  it("refuses to record an appeal against a verdict nobody made", async () => {
    // Otherwise the table fills with false positives that never happened, and its rows
    // stop meaning anything.
    messageFindFirst.mockResolvedValue(flagged({ threatLevel: "UNKNOWN" }));
    await expect(
      recordThreatAppeal({ userId: USER_ID, messageId: MESSAGE_ID }),
    ).rejects.toThrow(/nothing to appeal/);

    messageFindFirst.mockResolvedValue(flagged({ threatLevel: "SAFE" }));
    await expect(
      recordThreatAppeal({ userId: USER_ID, messageId: MESSAGE_ID }),
    ).rejects.toThrow(/nothing to appeal/);

    expect(appealCreate).not.toHaveBeenCalled();
  });

  it("refuses when the message has no assessment at all", async () => {
    messageFindFirst.mockResolvedValue({ id: MESSAGE_ID, threadId: "t1", classification: null });
    await expect(
      recordThreatAppeal({ userId: USER_ID, messageId: MESSAGE_ID }),
    ).rejects.toThrow(/nothing to appeal/);
  });

  it("is a 404 for somebody else's message", async () => {
    // The tenancy read is the ownership check: another user's message does not exist.
    messageFindFirst.mockResolvedValue(null);
    await expect(
      recordThreatAppeal({ userId: USER_ID, messageId: MESSAGE_ID }),
    ).rejects.toThrow(/Message not found/);
  });

  it("replaces an existing appeal rather than duplicating it", async () => {
    appealFindFirst
      .mockResolvedValueOnce({ id: "appeal_1" })
      .mockResolvedValueOnce({
        createdAt: new Date("2026-09-15T10:00:00Z"),
        note: "second thoughts",
        claimedLevel: "SUSPICIOUS",
        claimedScore: 57,
      });

    const result = await recordThreatAppeal({
      userId: USER_ID,
      messageId: MESSAGE_ID,
      note: "second thoughts",
    });

    expect(appealCreate).not.toHaveBeenCalled();
    expect(appealUpdateMany).toHaveBeenCalledWith({
      // A filter, not a unique where: this model's unique key is the message and its
      // tenancy key is the user, so `updateMany` is what stays inside the tenant scope.
      where: { messageId: MESSAGE_ID },
      data: expect.objectContaining({ note: "second thoughts" }),
    });
    expect(result.appeal.note).toBe("second thoughts");
  });
});
