import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  aiClassificationSchema,
  aiReplyVariantsSchema,
  aiSummarySchema,
  aiThreatAssessmentSchema,
  aiTranslationSchema,
  aiWritingStyleSchema,
} from "@inbox-copilot/shared";
import {
  GEMINI_DROPPED_KEYS,
  GEMINI_STRUCTURAL_KEYS,
  toGeminiSchema,
} from "./geminiSchema.js";
import { UpstreamError } from "../../lib/errors.js";

/**
 * JSON Schema to Gemini's function-declaration subset.
 *
 * Two jobs here, and the second is the one that will catch a real regression.
 *
 * The first is that the conversion is correct for the schemas this application actually
 * sends: structure preserved, value constraints dropped, unions refused.
 *
 * The second is a **completeness sweep** over every real tool schema, asserting that
 * every key Zod emits is one this converter has an opinion about. A new `.refine()` or a
 * Zod upgrade that starts emitting an unhandled keyword should fail here, in CI, rather
 * than at a user's first classification — and no amount of reading `geminiSchema.ts` would
 * catch it, because the question is what Zod produces, not what the converter says.
 */

/** Every tool schema this application hands to a model. */
const REAL_SCHEMAS = {
  classify: aiClassificationSchema,
  summarize: aiSummarySchema,
  reply: aiReplyVariantsSchema,
  style: aiWritingStyleSchema,
  threat: aiThreatAssessmentSchema,
  translate: aiTranslationSchema,
} as const;

function compile(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<
    string,
    unknown
  >;
}

/** Every key appearing anywhere in a compiled schema, at any depth. */
function keysIn(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const entry of node) keysIn(entry, found);
    return found;
  }
  if (typeof node !== "object" || node === null) return found;

  for (const [key, value] of Object.entries(node)) {
    found.add(key);
    // `properties` keys are field names rather than keywords, so recurse into the values
    // without collecting the names themselves.
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) keysIn(child, found);
      continue;
    }
    keysIn(value, found);
  }
  return found;
}

describe("the completeness sweep", () => {
  it("has an opinion about every keyword Zod emits for every real tool schema", () => {
    /*
     * The keys a converter is allowed to see: the ones it acts on structurally, the ones
     * it deliberately drops, and the ones it refuses. Anything else is a keyword nobody
     * has thought about, and silence would mean the model gets a schema describing a
     * different tool than the one Zod will validate against.
     */
    const HANDLED = new Set([
      "type",
      "description",
      "enum",
      "properties",
      "required",
      "items",
      ...GEMINI_DROPPED_KEYS,
      ...GEMINI_STRUCTURAL_KEYS,
    ]);

    const unhandled = new Map<string, string[]>();
    for (const [name, schema] of Object.entries(REAL_SCHEMAS)) {
      for (const key of keysIn(compile(schema))) {
        if (HANDLED.has(key)) continue;
        unhandled.set(key, [...(unhandled.get(key) ?? []), name]);
      }
    }

    expect(Object.fromEntries(unhandled)).toEqual({});
  });

  it("converts every real tool schema without throwing", () => {
    for (const [name, schema] of Object.entries(REAL_SCHEMAS)) {
      expect(() => toGeminiSchema(compile(schema)), name).not.toThrow();
    }
  });

  it("emits nothing but Gemini's own keys", () => {
    const ALLOWED = new Set([
      "type",
      "description",
      "enum",
      "format",
      "nullable",
      "properties",
      "required",
      "items",
    ]);

    for (const [name, schema] of Object.entries(REAL_SCHEMAS)) {
      for (const key of keysIn(toGeminiSchema(compile(schema)))) {
        expect(ALLOWED.has(key), `${name} emitted ${key}`).toBe(true);
      }
    }
  });
});

describe("what is preserved", () => {
  it("keeps every field and every required name", () => {
    /*
     * The structural half, and the half that must never be lost. Zod would reject a
     * missing field anyway, but that would be a failed call per message rather than a
     * model that knew what to produce.
     */
    const converted = toGeminiSchema(compile(aiClassificationSchema));

    expect(Object.keys(converted.properties ?? {}).sort()).toEqual([
      "category",
      "confidence",
      "language",
      "needsReply",
      "priority",
      "priorityScore",
    ]);
    expect(converted.required?.sort()).toEqual([
      "category",
      "confidence",
      "language",
      "needsReply",
      "priority",
      "priorityScore",
    ]);
  });

  it("keeps string enums, the one constraint Gemini honours", () => {
    const converted = toGeminiSchema(compile(aiThreatAssessmentSchema));

    /*
     * This is the §6 field where the value set is the security property: the model picks
     * a level from four, and there is no field for it to argue the verdict down with. So
     * the enum surviving the conversion is not a nicety.
     */
    expect(converted.properties?.["assessedLevel"]?.enum).toEqual([
      "SAFE",
      "SPAM",
      "SUSPICIOUS",
      "PHISHING",
    ]);
    expect(converted.properties?.["intent"]?.enum).toHaveLength(10);
  });

  it("keeps descriptions, because they are the only surviving statement of the bounds", () => {
    // Once `minimum`/`maximum` are gone, "0-100, how much this needs the user's
    // attention soon" is the entire reason a model produces a number in range.
    const converted = toGeminiSchema(compile(aiClassificationSchema));

    expect(converted.properties?.["priorityScore"]?.description).toMatch(/0-100/);
    expect(converted.properties?.["confidence"]?.description).toMatch(/0-1/);
  });

  it("recurses into arrays of objects", () => {
    const converted = toGeminiSchema(compile(aiSummarySchema));

    const actionItems = converted.properties?.["actionItems"];
    expect(actionItems?.type).toBe("array");
    expect(actionItems?.items?.type).toBe("object");
    expect(Object.keys(actionItems?.items?.properties ?? {}).sort()).toEqual([
      "dueDate",
      "owner",
      "text",
    ]);
    // `dueDate` is optional, so it is absent from required while still being declared.
    expect(actionItems?.items?.required).toEqual(["text", "owner"]);
  });

  it("gives a typeless optional leaf a type, rather than defaulting it to object", () => {
    /*
     * `dueDate` compiles to `{description, type: "string"}` today, but Zod has emitted
     * typeless nodes for optionals in the past. Guessing "object" there would turn a
     * date string into a nested object and the model would produce `{}`.
     */
    const converted = toGeminiSchema({
      type: "object",
      properties: { note: { description: "A note." } },
    });

    expect(converted.properties?.["note"]).toEqual({
      type: "string",
      description: "A note.",
    });
  });

  it("lifts a nullable union into Gemini's nullable flag", () => {
    const converted = toGeminiSchema({
      type: "object",
      properties: { maybe: { type: ["string", "null"], description: "Optional." } },
    });

    expect(converted.properties?.["maybe"]).toEqual({
      type: "string",
      nullable: true,
      description: "Optional.",
    });
  });
});

describe("what is dropped, and why that is safe", () => {
  it("drops $schema and additionalProperties", () => {
    // Gemini rejects a declaration carrying keys outside its subset, so these cannot
    // simply be passed through.
    const converted = toGeminiSchema(
      compile(aiClassificationSchema),
    ) as unknown as Record<string, unknown>;

    expect(converted["$schema"]).toBeUndefined();
    expect(converted["additionalProperties"]).toBeUndefined();
  });

  it("drops the numeric bounds Gemini cannot express", () => {
    /*
     * `priorityScore` is 0-100 in Zod and unbounded in the declaration Gemini sees.
     *
     * That is the interesting case in this whole module, and it is safe for one reason
     * only: `client.ts` runs the Zod schema over whatever comes back. The constraint
     * moves from advisory to enforced rather than disappearing —
     * `client.gemini.test.ts` is where that enforcement is pinned, with an out-of-range
     * answer being rejected.
     */
    const score = toGeminiSchema(compile(aiClassificationSchema)).properties?.[
      "priorityScore"
    ] as Record<string, unknown> | undefined;

    expect(score?.["type"]).toBe("integer");
    expect(score?.["minimum"]).toBeUndefined();
    expect(score?.["maximum"]).toBeUndefined();
  });

  it("drops array bounds, including the reply tool's exactly-three", () => {
    // The most consequential drop: three drafts is a product requirement, and on this
    // path only Zod enforces it.
    const variants = toGeminiSchema(compile(aiReplyVariantsSchema)).properties?.[
      "variants"
    ] as Record<string, unknown> | undefined;

    expect(variants?.["type"]).toBe("array");
    expect(variants?.["minItems"]).toBeUndefined();
    expect(variants?.["maxItems"]).toBeUndefined();
  });

  it("drops string bounds, including the threat explanation's 600 characters", () => {
    const explanation = toGeminiSchema(compile(aiThreatAssessmentSchema)).properties?.[
      "explanation"
    ] as Record<string, unknown> | undefined;

    expect(explanation?.["type"]).toBe("string");
    expect(explanation?.["maxLength"]).toBeUndefined();
  });
});

describe("what it refuses rather than guesses", () => {
  it("refuses a union, which would describe a different tool", () => {
    /*
     * A Zod union compiles to `anyOf`, Gemini cannot express it, and a converter that
     * dropped it would hand the model a schema for a tool that is not the one Zod
     * validates against. A loud failure at the first call beats a mysterious validation
     * failure on every message.
     */
    expect(() =>
      toGeminiSchema({
        type: "object",
        properties: { either: { anyOf: [{ type: "string" }, { type: "number" }] } },
      }),
    ).toThrow(UpstreamError);
  });

  it("refuses $ref, because a recursive schema cannot be flattened here", () => {
    expect(() =>
      toGeminiSchema({
        type: "object",
        properties: { child: { $ref: "#/$defs/node" } },
      }),
    ).toThrow(/\$ref/);
  });

  it("refuses const, which looks like a one-value enum and is not", () => {
    expect(() =>
      toGeminiSchema({ type: "object", properties: { kind: { const: "fixed" } } }),
    ).toThrow(UpstreamError);
  });

  it("refuses a non-string enum, which Gemini would silently ignore", () => {
    // Silent loosening is the failure mode this module exists to prevent.
    expect(() =>
      toGeminiSchema({
        type: "object",
        properties: { level: { type: "integer", enum: [1, 2, 3] } },
      }),
    ).toThrow(/enum only on string/);
  });

  it("refuses a multi-type union that is not just nullable", () => {
    expect(() =>
      toGeminiSchema({
        type: "object",
        properties: { odd: { type: ["string", "number"] } },
      }),
    ).toThrow(/multi-type/);
  });

  it("refuses an array with no items", () => {
    expect(() =>
      toGeminiSchema({ type: "object", properties: { list: { type: "array" } } }),
    ).toThrow(/needs items/);
  });

  it("refuses an unknown type", () => {
    expect(() =>
      toGeminiSchema({ type: "object", properties: { x: { type: "tuple" } } }),
    ).toThrow(/unknown JSON Schema type/);
  });

  it("refuses a top level that is not an object", () => {
    // A tool's parameters are always an object.
    expect(() => toGeminiSchema({ type: "string" })).toThrow(/must be an object schema/);
  });

  it("names the field in the error, so the failure is actionable", () => {
    expect(() =>
      toGeminiSchema({
        type: "object",
        properties: {
          outer: { type: "object", properties: { inner: { const: 1 } } },
        },
      }),
    ).toThrow(/\$\.outer\.inner/);
  });
});
