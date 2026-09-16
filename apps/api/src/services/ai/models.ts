/**
 * Model and price configuration for the AI layer (§5).
 *
 * Model ids appear **here and nowhere else**. Call sites ask for a feature
 * ("classify") and get whatever this file routes it to, so an A/B swap or a
 * price change is one edit in one place rather than a grep across services.
 *
 * Two providers now share that routing, and the indirection is what keeps them
 * honest: a feature names a **tier** (`fast` / `standard` / `deep`), and each provider
 * maps the three tiers to its own ids. So "classification runs on the cheap model and
 * translation does not" is one fact stated once, rather than a decision re-made per
 * provider and quietly drifting between them.
 */

/** The cost-aware cascade from §5. Mirrors the block in CLAUDE.md. */
export const MODELS = {
  fast: "claude-haiku-4-5-20251001", // classify, priority, language detect
  standard: "claude-sonnet-5", // summarize, reply, compose, translate
  deep: "claude-opus-5", // phishing escalation, complex threads
} as const;

export type ModelTier = keyof typeof MODELS;

/**
 * The same three roles on Gemini, for `AI_PROVIDER=gemini`.
 *
 * **Every id here was verified callable against a real free-tier AI Studio key**, with
 * the forced-function-calling request this application actually sends. That is not
 * pedantry: `ListModels` returns models a free key cannot call, and the first set of ids
 * chosen from documentation produced three different failures — 404 "no longer
 * available", 503, and a 429 with zero quota. So this table is empirical, and re-checking
 * it is the first thing to do when the Gemini path starts failing wholesale.
 *
 * These tiers are **not** a like-for-like translation of the Anthropic ones and should
 * not be read as one:
 *
 *   - `fast` is a lite model, genuinely smaller than Haiku, so a classification is
 *     coarser. It is also the quickest of the three, which is what a per-message label
 *     needs.
 *   - `standard` is a newer lite model: better than `fast` at the text a person actually
 *     reads (summaries, drafts, translations) without the latency of a thinking model.
 *   - `deep` is the one model here that **reasons before answering** — it reported 362
 *     thinking tokens on a trivial classification in testing. That is what §6's phishing
 *     escalation wants from the deep tier: "is this a targeted attack on this person".
 *
 * What is *not* available is a Pro model. On this key every Pro id answers 429 with "you
 * exceeded your current quota" — the free tier includes no Pro requests at all — so the
 * deep tier is a thinking Flash model rather than a Pro one. The cascade still increases
 * in capability at each step; it simply tops out lower than the Anthropic one. A key with
 * billing enabled should move `deep` to a Pro id, and this comment is the note to do it.
 *
 * Pinned versions, never a `-latest` alias: the ledger records the model id that answered,
 * and an alias that silently changes under you makes every historical row a guess.
 */
export const GEMINI_MODELS = {
  fast: "gemini-3.1-flash-lite", // classify, priority, language detect
  standard: "gemini-3.5-flash-lite", // summarize, reply, compose, translate
  deep: "gemini-3.5-flash", // phishing escalation, complex threads — thinks
} as const;

export type ModelId = (typeof MODELS)[ModelTier] | (typeof GEMINI_MODELS)[ModelTier];

/** Which provider a transport talks to. */
export type AiProviderName = "anthropic" | "gemini";

const PROVIDER_MODELS: Readonly<Record<AiProviderName, Readonly<Record<ModelTier, ModelId>>>> =
  {
    anthropic: MODELS,
    gemini: GEMINI_MODELS,
  };

/**
 * Which tier each feature runs on. `feature` is also the value written to
 * `AiUsage.feature`, so the ledger can be grouped by what the spend was for.
 */
export const FEATURE_TIERS = {
  classify: "fast",
  summarize: "standard",
  reply: "standard",
  compose: "standard",
  // Style profiling runs once per mailbox, over ~30 messages, and its output is
  // injected into every reply the user ever sees — the one call worth not saving on.
  style: "standard",
  /*
   * Translation, on the standard tier as §5 routes it.
   *
   * Not the fast tier, even though it is per-message and the cheap model can translate:
   * this output is read *as the sender's words*, and the failure mode of a weaker
   * translator is not a clumsy sentence but a changed meaning in a message the user is
   * deciding whether to trust. It is also cached per (message, language) for ever, so
   * the cost is paid once per thing a person actually chose to read.
   */
  translate: "standard",
  /*
   * Threat assessment, in two tiers (§6 layer 3).
   *
   * `threat` runs on every inbound message that the deterministic layers did not
   * already condemn, so it has to be affordable. `threatDeep` is the escalation §5
   * reserves the deep tier for: when layer 1 or 2 has found hard evidence, the
   * remaining question — is this a targeted attack on this person, and what do we tell
   * them — is worth the better reader. Both are separate ledger labels, so the cost of
   * escalating is visible rather than buried in one "phishing" total.
   */
  threat: "standard",
  threatDeep: "deep",
} as const satisfies Record<string, ModelTier>;

export type AiFeature = keyof typeof FEATURE_TIERS;

/** The model id for one feature on one provider. The only resolution call sites make. */
export function modelFor(feature: AiFeature, provider: AiProviderName): ModelId {
  return PROVIDER_MODELS[provider][FEATURE_TIERS[feature]];
}

/**
 * The Anthropic routing as a named table, because §5 and CLAUDE.md both quote it and
 * because it is the answer to "what does this application call by default". Derived from
 * `FEATURE_TIERS` rather than restated, so the two cannot disagree.
 */
export const FEATURE_MODELS = {
  classify: MODELS[FEATURE_TIERS.classify],
  summarize: MODELS[FEATURE_TIERS.summarize],
  reply: MODELS[FEATURE_TIERS.reply],
  compose: MODELS[FEATURE_TIERS.compose],
  style: MODELS[FEATURE_TIERS.style],
  translate: MODELS[FEATURE_TIERS.translate],
  threat: MODELS[FEATURE_TIERS.threat],
  threatDeep: MODELS[FEATURE_TIERS.threatDeep],
} as const satisfies Record<AiFeature, ModelId>;

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
  // Three drafts, so three times the room of one — and a ceiling low enough that a
  // model writing an essay is cut off rather than billed for.
  reply: 3_072,
  compose: 1_536,
  style: 1_024,
  /*
   * Generous, and it has to be: unlike every other ceiling here the output is roughly
   * the size of the *input*, and a body truncated at the prompt boundary
   * (`MAX_BODY_CHARS`) can still be twelve thousand characters of prose. Cutting a
   * translation off mid-sentence would be the worst of the failure modes — the reader
   * cannot tell a truncated translation from a short email.
   */
  translate: 8_192,
  /*
   * An intent, a level, a confidence and at most 600 characters of explanation. The
   * ceiling is deliberately tight: a threat assessment that needs a thousand tokens to
   * state itself is reasoning in the output rather than judging, and the user is not
   * going to read it either.
   */
  threat: 768,
  threatDeep: 768,
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

/** Free tier: no charge, and the zeros are a statement rather than a placeholder. */
const FREE_TIER: ModelPricing = {
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
};

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
  /*
   * Gemini on the free tier: zero, stated explicitly rather than left to fall through
   * `costUsd`'s unknown-model branch.
   *
   * That branch also returns zero, but it *means* "this model is not in the price table,
   * which is a config gap", and it is meant to look wrong on a dashboard. A free call is
   * not a config gap, so it says so here — and the token counts are still recorded in
   * full, because the ledger's job on this path is to show how much work was done and
   * how close the daily cap is, not what it cost.
   *
   * These become wrong the moment a key moves to a paid tier, which is exactly when this
   * table is the one place to edit.
   */
  [GEMINI_MODELS.fast]: FREE_TIER,
  [GEMINI_MODELS.standard]: FREE_TIER,
  [GEMINI_MODELS.deep]: FREE_TIER,
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
