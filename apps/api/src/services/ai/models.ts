/**
 * Model and price configuration for the AI layer (§5).
 *
 * Model ids appear **here and nowhere else**. Call sites ask for a feature
 * ("classify") and get whatever this file routes it to, so an A/B swap or a
 * price change is one edit in one place rather than a grep across services.
 */

/** The cost-aware cascade from §5. Mirrors the block in CLAUDE.md. */
export const MODELS = {
  fast: "claude-haiku-4-5-20251001", // classify, priority, language detect
  standard: "claude-sonnet-5", // summarize, reply, compose, translate
  deep: "claude-opus-5", // phishing escalation, complex threads
} as const;

export type ModelTier = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[ModelTier];

/**
 * Which model each feature runs on. `feature` is also the value written to
 * `AiUsage.feature`, so the ledger can be grouped by what the spend was for.
 */
export const FEATURE_MODELS = {
  classify: MODELS.fast,
  summarize: MODELS.standard,
} as const satisfies Record<string, ModelId>;

export type AiFeature = keyof typeof FEATURE_MODELS;

/**
 * Output ceilings, per feature.
 *
 * These are a cost control as much as a correctness one: the structured output we
 * ask for is small, and a model that starts rambling should be cut off rather than
 * billed for. Summaries get more room because `keyPoints` and `actionItems` are
 * lists whose length depends on the thread.
 */
export const MAX_OUTPUT_TOKENS = {
  classify: 512,
  summarize: 2_048,
} as const satisfies Record<AiFeature, number>;

/**
 * USD per million tokens, per model.
 *
 * Config, not truth: prices change, and when they do this table is the only thing
 * that needs editing. `cacheRead`/`cacheWrite` are the prompt-caching multipliers
 * (0.1x read, 1.25x write) — the ledger records cached tokens separately so the
 * savings are visible rather than assumed.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export const PRICING: Readonly<Record<ModelId, ModelPricing>> = {
  [MODELS.fast]: {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  [MODELS.standard]: {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  [MODELS.deep]: {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Cost of one call, as a fixed-point string.
 *
 * A string because `AiUsage.costUsd` is `Decimal(10,6)`: handing Prisma a float
 * would round-trip through binary floating point on its way into an exact column,
 * and a ledger that disagrees with the invoice is worse than no ledger. Six
 * decimals is also below the price of any single call, so nothing rounds to zero
 * that should not.
 */
export function costUsd(model: string, tokens: TokenCounts): string {
  const pricing = PRICING[model as ModelId];
  if (!pricing) {
    // An unpriced model is a config gap, not a reason to lose the call record:
    // the tokens are still logged, with a zero cost that will look wrong on a
    // dashboard — which is the point.
    return "0.000000";
  }

  const total =
    (tokens.inputTokens * pricing.inputPerMTok +
      tokens.outputTokens * pricing.outputPerMTok +
      tokens.cacheReadTokens * pricing.cacheReadPerMTok +
      tokens.cacheWriteTokens * pricing.cacheWritePerMTok) /
    1_000_000;

  return total.toFixed(6);
}
