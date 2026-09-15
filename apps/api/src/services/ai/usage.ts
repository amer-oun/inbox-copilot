import { dbForUser } from "@inbox-copilot/db";
import type { ReplyTone } from "@inbox-copilot/shared";
import { logger } from "../../lib/logger.js";
import { costUsd, type TokenCounts } from "./models.js";

/**
 * The usage ledger and the daily cap (§5).
 *
 * Every call is written to `AiUsage` — tokens in, tokens out, cached tokens, and
 * the cost. The cap is checked against that same table, so the thing that bills
 * and the thing that limits can never disagree: there is no separate counter to
 * drift.
 */

/** Fallbacks when a user has no `UserSettings` row yet (schema defaults). */
export const DEFAULT_SETTINGS = {
  aiEnabled: true,
  autoSummarize: true,
  autoCategorize: true,
  phishingProtection: true,
  dailyAiCallCap: 500,
  defaultTone: "PROFESSIONAL",
} as const;

export interface AiSettings {
  aiEnabled: boolean;
  autoSummarize: boolean;
  autoCategorize: boolean;
  /** §6 layer 3. Off means no threat banner at all — including the free layers. */
  phishingProtection: boolean;
  dailyAiCallCap: number;
  /** The tone a reply is drafted in when the caller does not name one. */
  defaultTone: ReplyTone;
}

export async function loadAiSettings(userId: string): Promise<AiSettings> {
  const row = await dbForUser(userId).userSettings.findFirst({
    where: { userId },
    select: {
      aiEnabled: true,
      autoSummarize: true,
      autoCategorize: true,
      phishingProtection: true,
      dailyAiCallCap: true,
      defaultTone: true,
    },
  });

  return row ?? { ...DEFAULT_SETTINGS };
}

/**
 * Start of the current cap window, in UTC.
 *
 * UTC rather than the user's timezone, deliberately: the cap exists to bound spend,
 * and a window that moves with a travelling user is a window that can be crossed
 * twice in a day. The user-facing *display* of usage can be local later.
 */
export function capWindowStart(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

/** Calls this user has made in the current window. */
export async function callsToday(userId: string, now: Date = new Date()): Promise<number> {
  return dbForUser(userId).aiUsage.count({
    where: { userId, createdAt: { gte: capWindowStart(now) } },
  });
}

export interface CapDecision {
  allowed: boolean;
  used: number;
  cap: number;
}

/**
 * Whether one more call is allowed.
 *
 * Checked *before* every call rather than after, and not inside a transaction: two
 * concurrent workers can both pass the check at cap-1 and land one call over. That
 * is accepted on purpose — serializing every AI call through a lock to save a
 * fraction of a cent would cost more than it protects. The cap is a spend bound,
 * not a security boundary.
 */
export async function checkDailyCap(
  userId: string,
  settings: AiSettings,
  now: Date = new Date(),
): Promise<CapDecision> {
  const used = await callsToday(userId, now);
  return { allowed: used < settings.dailyAiCallCap, used, cap: settings.dailyAiCallCap };
}

export interface RecordUsageInput {
  userId: string;
  feature: string;
  model: string;
  tokens: TokenCounts;
}

/**
 * Writes one ledger row.
 *
 * Called after a call returns, including when the *response* turned out to be
 * unusable: the tokens were spent either way, and a ledger that only records
 * successes understates the bill.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const cost = costUsd(input.model, input.tokens);

  await dbForUser(input.userId).aiUsage.create({
    data: {
      userId: input.userId,
      feature: input.feature,
      model: input.model,
      inputTokens: input.tokens.inputTokens,
      outputTokens: input.tokens.outputTokens,
      cachedTokens: input.tokens.cacheReadTokens + input.tokens.cacheWriteTokens,
      costUsd: cost,
    },
  });

  logger.debug(
    {
      userId: input.userId,
      feature: input.feature,
      model: input.model,
      ...input.tokens,
      costUsd: cost,
    },
    "ai call billed",
  );
}
