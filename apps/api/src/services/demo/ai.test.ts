import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SAMPLE_MODEL, DEMO_USER_ID } from "@inbox-copilot/shared";

/**
 * The demo's model-calling buttons: pre-written first, live only within an allowance.
 *
 * What matters is which requests reach a model. A pre-written answer and a cache hit
 * must not spend allowance; everything else must, and must be refused once it is gone —
 * because the demo runs on the owner's free quota and anyone can script a button.
 */

const threadFindFirst = vi.hoisted(() => vi.fn());
const replyDraftCreate = vi.hoisted(() => vi.fn());
const messageFindFirst = vi.hoisted(() => vi.fn());
const translationFindFirst = vi.hoisted(() => vi.fn());
const generateReplies = vi.hoisted(() => vi.fn());
const translateMessage = vi.hoisted(() => vi.fn());
const counters = vi.hoisted(() => new Map<string, number>());
const redisDown = vi.hoisted(() => ({ value: false }));

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    thread: { findFirst: threadFindFirst },
    replyDraft: { create: replyDraftCreate },
    message: { findFirst: messageFindFirst },
    translation: { findFirst: translationFindFirst },
  }),
}));

/** A tiny INCR-only Redis, enough for the allowance's MULTI. */
vi.mock("../../lib/redis.js", () => ({
  connectRedis: async () => {
    if (redisDown.value) throw new Error("redis is down");
  },
  redis: {
    multi() {
      const ops: Array<() => [null, number]> = [];
      const chain = {
        incr(key: string) {
          ops.push(() => {
            const next = (counters.get(key) ?? 0) + 1;
            counters.set(key, next);
            return [null, next];
          });
          return chain;
        },
        expire() {
          ops.push(() => [null, 1]);
          return chain;
        },
        exec: async () => ops.map((op) => op()),
      };
      return chain;
    },
  },
}));

vi.mock("../ai/reply.js", () => ({ generateReplies }));
vi.mock("../ai/translate.js", () => ({
  translateMessage,
  normalizeLang: (lang: string) => lang.trim().toLowerCase(),
}));

const { demoReplies, demoTranslate, PER_SESSION_PER_HOUR, ALL_SESSIONS_PER_HOUR } =
  await import("./ai.js");
const { threadIdFor } = await import("./seed.js");
const { AiCapExceededError, DemoLimitError } = await import("../../lib/errors.js");

/** Thread 1 has pre-written PROFESSIONAL and CONCISE drafts; thread 6 has none. */
const WITH_DRAFTS = threadIdFor(1);
const WITHOUT_DRAFTS = threadIdFor(6);
const MESSAGE_ID = "cdemomesg0000000000000501";

function visitor(sid = "visit_aaaaaaaaaaaaaaaa") {
  return { id: DEMO_USER_ID, demo: true, demoSessionId: sid };
}

let draftCounter = 0;

beforeEach(() => {
  counters.clear();
  redisDown.value = false;
  draftCounter = 0;
  threadFindFirst.mockReset().mockResolvedValue({ id: WITH_DRAFTS });
  replyDraftCreate.mockReset().mockImplementation(async () => ({
    id: `cdemodrft${String(++draftCounter).padStart(16, "0")}`,
    createdAt: new Date("2026-09-22T09:30:00Z"),
  }));
  messageFindFirst.mockReset().mockResolvedValue({ contentHash: "hash-1" });
  translationFindFirst.mockReset().mockResolvedValue(null);
  generateReplies.mockReset().mockResolvedValue({
    threadId: WITHOUT_DRAFTS,
    tone: "PROFESSIONAL",
    drafts: [],
    styleApplied: true,
  });
  translateMessage.mockReset().mockResolvedValue({ fromCache: false });
});

describe("demoReplies", () => {
  it("serves the pre-written drafts with no model call and no allowance spent", async () => {
    const result = await demoReplies({ user: visitor(), threadId: WITH_DRAFTS });

    expect(generateReplies).not.toHaveBeenCalled();
    expect(counters.size).toBe(0);
    expect(result.drafts).toHaveLength(3);
    expect(result.drafts[0]?.label).toBe("Sign today");
    for (const draft of result.drafts) expect(draft.model).toBe(DEMO_SAMPLE_MODEL);
    // Stored like live drafts, so the composer's feedback path is the same.
    expect(replyDraftCreate).toHaveBeenCalledTimes(3);
  });

  it("serves another pre-written tone when one exists", async () => {
    const result = await demoReplies({
      user: visitor(),
      threadId: WITH_DRAFTS,
      tone: "CONCISE",
    });

    expect(generateReplies).not.toHaveBeenCalled();
    expect(result.tone).toBe("CONCISE");
  });

  it("drafts live, within the allowance, when nothing was written in advance", async () => {
    threadFindFirst.mockResolvedValue({ id: WITHOUT_DRAFTS });

    await demoReplies({ user: visitor(), threadId: WITHOUT_DRAFTS });

    expect(generateReplies).toHaveBeenCalledWith({
      userId: DEMO_USER_ID,
      threadId: WITHOUT_DRAFTS,
      tone: "PROFESSIONAL",
    });
  });

  it("refuses a thread the demo user does not have", async () => {
    threadFindFirst.mockResolvedValue(null);

    await expect(
      demoReplies({ user: visitor(), threadId: WITHOUT_DRAFTS }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(generateReplies).not.toHaveBeenCalled();
  });

  it("stops one visitor at their hourly allowance", async () => {
    threadFindFirst.mockResolvedValue({ id: WITHOUT_DRAFTS });
    for (let i = 0; i < PER_SESSION_PER_HOUR; i++) {
      await demoReplies({ user: visitor(), threadId: WITHOUT_DRAFTS });
    }

    await expect(
      demoReplies({ user: visitor(), threadId: WITHOUT_DRAFTS }),
    ).rejects.toBeInstanceOf(DemoLimitError);
    expect(generateReplies).toHaveBeenCalledTimes(PER_SESSION_PER_HOUR);

    // A different visitor still has theirs.
    await demoReplies({
      user: visitor("visit_bbbbbbbbbbbbbbbb"),
      threadId: WITHOUT_DRAFTS,
    });
    expect(generateReplies).toHaveBeenCalledTimes(PER_SESSION_PER_HOUR + 1);
  });

  it("stops every visitor at the demo's hourly allowance", async () => {
    threadFindFirst.mockResolvedValue({ id: WITHOUT_DRAFTS });
    for (let i = 0; i < ALL_SESSIONS_PER_HOUR; i++) {
      await demoReplies({
        user: visitor(`visit_${String(i).padStart(16, "0")}`),
        threadId: WITHOUT_DRAFTS,
      });
    }

    await expect(
      demoReplies({ user: visitor("visit_zzzzzzzzzzzzzzzz"), threadId: WITHOUT_DRAFTS }),
    ).rejects.toBeInstanceOf(DemoLimitError);
  });

  it("refuses live calls when the allowance cannot be counted", async () => {
    threadFindFirst.mockResolvedValue({ id: WITHOUT_DRAFTS });
    redisDown.value = true;

    await expect(
      demoReplies({ user: visitor(), threadId: WITHOUT_DRAFTS }),
    ).rejects.toBeInstanceOf(DemoLimitError);
    expect(generateReplies).not.toHaveBeenCalled();

    // Pre-written drafts do not need it.
    threadFindFirst.mockResolvedValue({ id: WITH_DRAFTS });
    await expect(
      demoReplies({ user: visitor(), threadId: WITH_DRAFTS }),
    ).resolves.toBeDefined();
  });

  it("rewords the daily cap so it does not read like the visitor's own quota", async () => {
    threadFindFirst.mockResolvedValue({ id: WITHOUT_DRAFTS });
    generateReplies.mockRejectedValue(
      new AiCapExceededError("Daily AI call cap reached"),
    );

    await expect(
      demoReplies({ user: visitor(), threadId: WITHOUT_DRAFTS }),
    ).rejects.toMatchObject({ code: "DEMO_AI_LIMITED" });
  });
});

describe("demoTranslate", () => {
  it("spends no allowance on a translation the cache already holds", async () => {
    translationFindFirst.mockResolvedValue({ contentHash: "hash-1" });

    await demoTranslate({ user: visitor(), messageId: MESSAGE_ID, targetLang: "EN" });

    expect(counters.size).toBe(0);
    expect(translateMessage).toHaveBeenCalledWith({
      userId: DEMO_USER_ID,
      messageId: MESSAGE_ID,
      targetLang: "en",
    });
  });

  it("spends allowance when the translation is missing or stale", async () => {
    translationFindFirst.mockResolvedValue({ contentHash: "an-older-body" });

    await demoTranslate({ user: visitor(), messageId: MESSAGE_ID, targetLang: "de" });

    expect(counters.size).toBe(2);
    expect(translateMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses a message the demo user does not have", async () => {
    messageFindFirst.mockResolvedValue(null);

    await expect(
      demoTranslate({ user: visitor(), messageId: MESSAGE_ID, targetLang: "de" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(translateMessage).not.toHaveBeenCalled();
  });
});
