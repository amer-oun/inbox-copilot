import { beforeEach, describe, expect, it, vi } from "vitest";
import { costUsd, MODELS, PRICING } from "./models.js";
import type { AiSettings } from "./usage.js";

/**
 * The ledger, the cap, and the arithmetic behind both.
 *
 * The cost math gets real tests because it is the number a human will compare
 * against an invoice. Floating point is fine for the multiplication and wrong for
 * the storage, which is why the function returns a fixed-point string.
 */

const usageCreate = vi.hoisted(() => vi.fn());
const usageCount = vi.hoisted(() => vi.fn());
const settingsFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    aiUsage: { create: usageCreate, count: usageCount },
    userSettings: { findFirst: settingsFindFirst },
  }),
}));

const {
  callsToday,
  capWindowStart,
  checkDailyCap,
  DEFAULT_SETTINGS,
  loadAiSettings,
  recordUsage,
} = await import("./usage.js");

const USER_ID = "user_1";
const SETTINGS: AiSettings = {
  aiEnabled: true,
  autoSummarize: true,
  autoCategorize: true,
  dailyAiCallCap: 500,
  defaultTone: "PROFESSIONAL",
};

beforeEach(() => {
  usageCreate.mockReset().mockResolvedValue({});
  usageCount.mockReset().mockResolvedValue(0);
  settingsFindFirst.mockReset().mockResolvedValue(SETTINGS);
});

describe("costUsd", () => {
  it("prices a Haiku classification", () => {
    // 1240 in at $1/MTok + 92 out at $5/MTok.
    expect(costUsd(MODELS.fast, {
      inputTokens: 1_240,
      outputTokens: 92,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })).toBe("0.001700");
  });

  it("prices a Sonnet summary", () => {
    // 4310 in at $3/MTok + 288 out at $15/MTok = 0.01293 + 0.00432.
    expect(costUsd(MODELS.standard, {
      inputTokens: 4_310,
      outputTokens: 288,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })).toBe("0.017250");
  });

  it("charges cached reads at a tenth of the input rate", () => {
    const full = costUsd(MODELS.standard, {
      inputTokens: 10_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const cached = costUsd(MODELS.standard, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
    });

    expect(Number(full)).toBeCloseTo(Number(cached) * 10, 6);
  });

  it("returns a string with six decimals, matching Decimal(10,6)", () => {
    const cost = costUsd(MODELS.fast, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(cost).toMatch(/^\d+\.\d{6}$/);
    // A single-token call must not round to zero at this precision.
    expect(Number(cost)).toBeGreaterThan(0);
  });

  it("records zero for an unpriced model rather than losing the row", () => {
    expect(costUsd("claude-something-unreleased", {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })).toBe("0.000000");
  });

  it("prices every configured model", () => {
    for (const model of Object.values(MODELS)) {
      expect(PRICING[model]).toBeDefined();
      expect(PRICING[model].outputPerMTok).toBeGreaterThan(PRICING[model].inputPerMTok);
    }
  });
});

describe("the cap window", () => {
  it("starts at UTC midnight", () => {
    const start = capWindowStart(new Date("2026-09-12T23:59:59.999Z"));
    expect(start.toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });

  it("does not move with a local timezone", () => {
    // UTC on purpose: a window that follows a travelling user can be crossed twice.
    const early = capWindowStart(new Date("2026-09-12T00:00:00Z"));
    const late = capWindowStart(new Date("2026-09-12T22:00:00Z"));
    expect(early.getTime()).toBe(late.getTime());
  });

  it("counts only calls inside the window", async () => {
    await callsToday(USER_ID, new Date("2026-09-12T10:00:00Z"));

    expect(usageCount).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        createdAt: { gte: new Date("2026-09-12T00:00:00.000Z") },
      },
    });
  });
});

describe("checkDailyCap", () => {
  it("allows a user below the cap", async () => {
    usageCount.mockResolvedValue(499);
    expect(await checkDailyCap(USER_ID, SETTINGS)).toEqual({
      allowed: true,
      used: 499,
      cap: 500,
    });
  });

  it("refuses at the cap", async () => {
    usageCount.mockResolvedValue(500);
    expect((await checkDailyCap(USER_ID, SETTINGS)).allowed).toBe(false);
  });

  it("refuses above the cap, which a race can produce", async () => {
    // Two workers can both pass the check at cap-1. The overshoot is accepted; what
    // must not happen is the counter unblocking again once it is past.
    usageCount.mockResolvedValue(501);
    expect((await checkDailyCap(USER_ID, SETTINGS)).allowed).toBe(false);
  });

  it("refuses everything at a cap of zero", async () => {
    usageCount.mockResolvedValue(0);
    expect(
      (await checkDailyCap(USER_ID, { ...SETTINGS, dailyAiCallCap: 0 })).allowed,
    ).toBe(false);
  });
});

describe("loadAiSettings", () => {
  it("returns the user's row", async () => {
    expect(await loadAiSettings(USER_ID)).toEqual(SETTINGS);
  });

  it("falls back to the schema defaults when there is no row", async () => {
    settingsFindFirst.mockResolvedValue(null);
    expect(await loadAiSettings(USER_ID)).toEqual({ ...DEFAULT_SETTINGS });
  });
});

describe("recordUsage", () => {
  it("writes tokens and cost, with cached tokens summed", async () => {
    await recordUsage({
      userId: USER_ID,
      feature: "summarize",
      model: MODELS.standard,
      tokens: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 900,
        cacheWriteTokens: 100,
      },
    });

    expect(usageCreate).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        feature: "summarize",
        model: MODELS.standard,
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 1_000,
        costUsd: expect.stringMatching(/^\d+\.\d{6}$/),
      },
    });
  });
});
