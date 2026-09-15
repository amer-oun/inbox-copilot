import { z } from "zod";
import {
  threatIntentSchema,
  threatLevelSchema,
  type ThreatAppealDto,
  type ThreatAssessmentDto,
  type ThreatLevel,
} from "@inbox-copilot/shared";
import { moreSevere } from "./phishing.js";

/**
 * Reading a stored threat verdict back out for the UI.
 *
 * Separate from `phishing.ts` because it is the opposite direction and has the opposite
 * disposition: that file decides what is true and may refuse to answer, this one shows
 * a user what was decided and must never fail. Every field here is parsed defensively —
 * the JSON columns were written by an earlier build of the rule set, and a thread the
 * user just wanted to read must not 500 because `ruleSignals` has a shape from last
 * month.
 */

/** The columns a message row needs for the thread view's banner. */
export const THREAT_READ_SELECT = {
  classification: {
    select: {
      threatLevel: true,
      threatScore: true,
      threatReasons: true,
      ruleSignals: true,
      threatIntent: true,
      threatExplanation: true,
      threatModel: true,
    },
  },
  threatAppeal: {
    select: { createdAt: true, note: true, claimedLevel: true, claimedScore: true },
  },
} as const;

/**
 * The row shape this reads.
 *
 * Both relations are optional as well as nullable, so a caller that selected the
 * columns this needs and a caller that did not are both handled: an absent relation is
 * "not assessed", exactly like a null one. A thread read must not 500 because a select
 * list somewhere is missing a field.
 */
interface ThreatRow {
  id: string;
  classification?: {
    threatLevel: string;
    threatScore: number;
    threatReasons: unknown;
    ruleSignals: unknown;
    threatIntent: string | null;
    threatExplanation: string | null;
    threatModel: string | null;
  } | null;
  threatAppeal?: {
    createdAt: Date;
    note: string | null;
    claimedLevel: string;
    claimedScore: number;
  } | null;
}

/**
 * What this needs out of `ruleSignals`, and nothing more.
 *
 * Deliberately *not* the full `ruleSignalsSchema`. Validating the whole stored shape here
 * would mean that the day the rule set gains a field — or `version` goes to 2 — every
 * row written before it silently reports no rule score, which is a worse answer than the
 * one those rows actually contain. The two numbers the banner shows are stable; the rest
 * of the record is for whoever is reviewing the rules, and can be read with the real
 * schema there.
 */
const bannerRulesSchema = z.object({
  score: z.number().int().min(0).max(100),
  floor: threatLevelSchema,
});

/** `threatReasons` is a JSON array of strings, or it is not and we show nothing. */
function asReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

function asAppeal(row: ThreatRow["threatAppeal"]): ThreatAppealDto | null {
  if (row === null || row === undefined) return null;
  const level = threatLevelSchema.safeParse(row.claimedLevel);
  return {
    createdAt: row.createdAt.toISOString(),
    note: row.note,
    claimedLevel: level.success ? level.data : "UNKNOWN",
    claimedScore: row.claimedScore,
  };
}

/**
 * The assessment to show for a thread: the most severe one in it.
 *
 * The worst message wins, and on a tie the *newest* of the tied messages does — a
 * reader looking at a thread where two messages are suspicious is being warned about
 * the one that just arrived. Messages with no assessment, and messages assessed as
 * UNKNOWN, are not candidates: "we have not looked at this" is not a thing to put in a
 * banner.
 *
 * Returns null when nothing in the thread has been assessed, which is how the UI knows
 * to show nothing at all rather than a reassuring empty banner.
 */
export function threatAssessmentFor(
  messages: readonly ThreatRow[],
): ThreatAssessmentDto | null {
  let worst: { row: ThreatRow; level: ThreatLevel } | null = null;

  for (const row of messages) {
    const raw = row.classification;
    if (raw === null || raw === undefined) continue;

    const parsed = threatLevelSchema.safeParse(raw.threatLevel);
    if (!parsed.success || parsed.data === "UNKNOWN") continue;

    // `>=` rather than `>`, and the loop runs oldest-first, so a tie resolves to the
    // newest message.
    if (worst === null || moreSevere(parsed.data, worst.level) === parsed.data) {
      worst = { row, level: parsed.data };
    }
  }

  if (worst === null) return null;

  const raw = worst.row.classification;
  if (raw === null || raw === undefined) return null;

  const rules = bannerRulesSchema.safeParse(raw.ruleSignals);
  const intent = threatIntentSchema.safeParse(raw.threatIntent);

  return {
    messageId: worst.row.id,
    level: worst.level,
    score: raw.threatScore,
    reasons: asReasons(raw.threatReasons),
    intent: intent.success ? intent.data : null,
    explanation: raw.threatExplanation,
    model: raw.threatModel,
    /*
     * Falling back to the final score here would be a lie of a particular kind: the
     * point of showing the rule score separately is to say what the deterministic
     * layers found on their own, and passing off a union score as theirs would hide
     * exactly the case the user is entitled to see — a verdict the model raised. So an
     * unreadable `ruleSignals` reports 0 and SAFE: nothing claimed.
     */
    ruleScore: rules.success ? rules.data.score : 0,
    ruleFloor: rules.success ? rules.data.floor : "SAFE",
    appeal: asAppeal(worst.row.threatAppeal),
  };
}
