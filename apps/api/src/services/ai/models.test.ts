import { describe, expect, it } from "vitest";
import {
  costUsd,
  FEATURE_MODELS,
  FEATURE_TIERS,
  GEMINI_MODELS,
  MAX_OUTPUT_TOKENS,
  MODELS,
  modelFor,
  PRICING,
  type AiFeature,
} from "./models.js";

/**
 * Model routing and pricing across both providers.
 *
 * The indirection being tested is small but load-bearing: a feature names a **tier** and
 * each provider maps tiers to ids. Without that, "classification runs on the cheap model"
 * would be a decision re-made per provider, and the two would drift the first time
 * somebody added a feature.
 */

const FEATURES = Object.keys(FEATURE_TIERS) as AiFeature[];

describe("tier routing", () => {
  it("routes every feature on both providers", () => {
    // No feature may be unroutable on a provider: that would be a runtime undefined at
    // the first call of whichever feature was forgotten.
    for (const feature of FEATURES) {
      expect(modelFor(feature, "anthropic"), feature).toBeTypeOf("string");
      expect(modelFor(feature, "gemini"), feature).toBeTypeOf("string");
    }
  });

  it("gives both providers the same tier for every feature", () => {
    /*
     * The point of the indirection. Classification is cheap on both, translation is not
     * cheap on either (§9: its output is read as the sender's words), and the phishing
     * escalation is the strongest model available on both (§6).
     */
    for (const feature of FEATURES) {
      const tier = FEATURE_TIERS[feature];
      expect(modelFor(feature, "anthropic")).toBe(MODELS[tier]);
      expect(modelFor(feature, "gemini")).toBe(GEMINI_MODELS[tier]);
    }
  });

  it("puts classification on the fast tier and the threat escalation on the deep one", () => {
    expect(FEATURE_TIERS.classify).toBe("fast");
    expect(FEATURE_TIERS.threatDeep).toBe("deep");
    // The two-tier threat routing §6 relies on: escalating must actually change model.
    expect(modelFor("threat", "gemini")).not.toBe(modelFor("threatDeep", "gemini"));
    expect(modelFor("threat", "anthropic")).not.toBe(modelFor("threatDeep", "anthropic"));
  });

  it("keeps FEATURE_MODELS in step with the tiers rather than restating them", () => {
    // Derived, so the named table §5 and CLAUDE.md quote cannot disagree with the router.
    for (const feature of FEATURES) {
      expect(FEATURE_MODELS[feature]).toBe(modelFor(feature, "anthropic"));
    }
  });

  it("has an output ceiling for every feature", () => {
    for (const feature of FEATURES) {
      expect(MAX_OUTPUT_TOKENS[feature], feature).toBeGreaterThan(0);
    }
  });

  it("uses three distinct models per provider", () => {
    // A collapsed tier would make the cost cascade decorative.
    expect(new Set(Object.values(MODELS)).size).toBe(3);
    expect(new Set(Object.values(GEMINI_MODELS)).size).toBe(3);
  });
});

describe("pricing", () => {
  it("prices every model both providers can be routed to", () => {
    /*
     * An unpriced model falls through `costUsd`'s unknown branch, which returns zero and
     * is *meant* to look wrong on a dashboard. A Gemini model landing there would make a
     * free call indistinguishable from a config gap, so every id is in the table.
     */
    for (const feature of FEATURES) {
      for (const provider of ["anthropic", "gemini"] as const) {
        expect(PRICING[modelFor(feature, provider)], `${provider}/${feature}`).toBeDefined();
      }
    }
  });

  it("charges nothing for a Gemini call", () => {
    const tokens = {
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 0,
    };

    for (const model of Object.values(GEMINI_MODELS)) {
      expect(costUsd(model, tokens)).toBe("0.000000");
    }
  });

  it("still charges for Anthropic, so the zero above means something", () => {
    // Otherwise "free tier costs zero" would pass with a broken cost function.
    const cost = costUsd(MODELS.standard, {
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(Number(cost)).toBeGreaterThan(0);
  });

  it("keeps the unknown-model branch distinguishable from a free one", () => {
    /*
     * Both return "0.000000", and that is fine because the *ledger* records the model id
     * next to the cost: a zero beside `gemini-2.5-flash` is a free call, and a zero beside
     * something not in this table is a config gap. What must not happen is a Gemini id
     * being absent from PRICING, which the first test in this block covers.
     */
    expect(costUsd("some-model-nobody-priced", {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })).toBe("0.000000");
    expect(PRICING["some-model-nobody-priced" as keyof typeof PRICING]).toBeUndefined();
  });
});
