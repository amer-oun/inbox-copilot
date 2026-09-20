import { describe, expect, it } from "vitest";
import { threatAssessmentFor } from "./read.js";

/**
 * Reading a verdict back out for the banner.
 *
 * Two jobs, and they are both about not lying to the reader: pick the message the banner
 * should be about, and survive a stored shape written by an older build rather than
 * failing a thread the user only wanted to read.
 */

function classification(overrides: Record<string, unknown> = {}) {
  return {
    threatLevel: "SUSPICIOUS",
    threatScore: 57,
    threatReasons: ["DMARC failed: shop.example says this did not come from them."],
    ruleSignals: { version: 1, score: 45, floor: "SUSPICIOUS" },
    threatIntent: "INVOICE_FRAUD",
    threatExplanation: "The payment details differ from the ones you have used before.",
    threatModel: "claude-opus-5",
    ...overrides,
  };
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return { id, classification: classification(overrides), threatAppeal: null };
}

describe("threatAssessmentFor", () => {
  it("returns null when nothing in the thread has been assessed", () => {
    // Not an empty "all clear": a banner that says nothing was checked would be worse
    // than no banner, and the UI needs to be able to tell the two apart.
    expect(threatAssessmentFor([])).toBeNull();
    expect(
      threatAssessmentFor([{ id: "m1", classification: null, threatAppeal: null }]),
    ).toBeNull();
    expect(threatAssessmentFor([row("m1", { threatLevel: "UNKNOWN" })])).toBeNull();
  });

  it("does not crash when the caller never selected the columns", () => {
    // A thread read must not 500 because a select list somewhere is short.
    expect(threatAssessmentFor([{ id: "m1" }])).toBeNull();
  });

  it("picks the worst message, not the newest", () => {
    const assessment = threatAssessmentFor([
      row("m1", { threatLevel: "PHISHING", threatScore: 88 }),
      row("m2", { threatLevel: "SAFE", threatScore: 0 }),
    ]);

    expect(assessment?.messageId).toBe("m1");
    expect(assessment?.level).toBe("PHISHING");
  });

  it("prefers the newest of two equally bad messages", () => {
    // Messages arrive oldest-first, and a reader looking at two suspicious messages is
    // being warned about the one that just landed.
    const assessment = threatAssessmentFor([row("older"), row("newer")]);
    expect(assessment?.messageId).toBe("newer");
  });

  it("carries the evidence, the reading and both scores", () => {
    const assessment = threatAssessmentFor([row("m1")]);

    expect(assessment).toMatchObject({
      level: "SUSPICIOUS",
      score: 57,
      intent: "INVOICE_FRAUD",
      model: "claude-opus-5",
      ruleScore: 45,
      ruleFloor: "SUSPICIOUS",
      appeal: null,
    });
    expect(assessment?.reasons).toHaveLength(1);
  });

  it("claims nothing for the rules when their stored findings cannot be read", () => {
    /*
     * Falling back to the union score here would hide exactly the case the user is
     * entitled to see — a verdict the model raised — by presenting it as something the
     * deterministic checks found.
     */
    const assessment = threatAssessmentFor([
      row("m1", { ruleSignals: "not json we wrote" }),
    ]);

    expect(assessment?.ruleScore).toBe(0);
    expect(assessment?.ruleFloor).toBe("SAFE");
    expect(assessment?.score).toBe(57);
  });

  it("drops a stored intent it does not recognize", () => {
    // The column is a plain string, so a value from an older enum must not reach the DTO.
    expect(
      threatAssessmentFor([row("m1", { threatIntent: "SOMETHING_ELSE" })])?.intent,
    ).toBeNull();
  });

  it("shows no reasons rather than junk when the column is not a string array", () => {
    expect(
      threatAssessmentFor([row("m1", { threatReasons: { a: 1 } })])?.reasons,
    ).toEqual([]);
    expect(
      threatAssessmentFor([row("m1", { threatReasons: [1, "", "real"] })])?.reasons,
    ).toEqual(["real"]);
  });

  it("reports an appeal alongside the verdict it disagrees with", () => {
    // The verdict is unchanged on purpose — the appeal changes how loudly the UI says it,
    // not what was decided.
    const assessment = threatAssessmentFor([
      {
        id: "m1",
        classification: classification(),
        threatAppeal: {
          createdAt: new Date("2026-09-15T10:00:00Z"),
          note: null,
          claimedLevel: "SUSPICIOUS",
          claimedScore: 57,
        },
      },
    ]);

    expect(assessment?.level).toBe("SUSPICIOUS");
    expect(assessment?.appeal).toEqual({
      createdAt: "2026-09-15T10:00:00.000Z",
      note: null,
      claimedLevel: "SUSPICIOUS",
      claimedScore: 57,
    });
  });
});
