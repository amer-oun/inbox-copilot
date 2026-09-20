import { UpstreamError } from "../../lib/errors.js";

/**
 * JSON Schema (draft-7, as Zod emits it) to Gemini's function-declaration schema.
 *
 * Gemini does not accept JSON Schema. It accepts a small OpenAPI-derived subset:
 * `type`, `description`, `enum`, `properties`, `required`, `items`, `nullable`, `format`
 * — and rejects a declaration carrying keys outside it. So `additionalProperties: false`,
 * `$schema`, `minLength`, `minimum`, `maxItems` and the rest have to go, and this module
 * is the one place that happens.
 *
 * **Dropping those constraints is safe, and it is worth being precise about why.** The
 * tool declaration is a *hint to the model*: it shapes what the model tries to produce.
 * It has never been what makes the output trustworthy. That is the Zod parse in
 * `client.ts`, which runs over whatever comes back regardless of what the declaration
 * managed to express — so a Gemini answer with `priorityScore: 999` is rejected exactly
 * as an Anthropic one would be, even though the declaration Gemini saw could not say
 * `maximum: 100`. The constraint moves from advisory to enforced; it does not disappear.
 * `geminiSchema.test.ts` pins that, and `client.gemini.test.ts` pins the enforcement.
 *
 * What this module must *never* do is silently drop something structural. A lost
 * `properties` entry or a lost `required` would leave the model free to omit a field, and
 * for the threat tool the absent fields are the security property (§6: there is no field
 * with which to argue the verdict down). So unknown *structural* keys are an error rather
 * than a shrug — see `STRUCTURAL_KEYS`.
 */

/** Gemini's `SchemaType` values. Spelled out rather than imported from the SDK so this
 * module is testable without constructing a client, and so a version bump that renames
 * the enum fails at the type level here instead of at the first call. */
export type GeminiType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface GeminiSchema {
  type: GeminiType;
  description?: string;
  /** STRING only, and the one constraint Gemini does honour. */
  enum?: string[];
  format?: string;
  nullable?: boolean;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
}

/**
 * Keys we deliberately drop, with the reason they are safe to lose.
 *
 * All of them are *value* constraints: they narrow what a valid value looks like without
 * changing which fields exist. Zod re-checks every one of them on the way back, so the
 * worst case is a model that produces a value we then reject and log — a wasted call, not
 * a bad row.
 */
const DROPPED_KEYS = new Set([
  "$schema",
  // Not expressible. Gemini objects are closed to unknown properties anyway, and an
  // extra key would be stripped by Zod's own object parsing.
  "additionalProperties",
  // String bounds: re-checked by Zod.
  "minLength",
  "maxLength",
  "pattern",
  // Numeric bounds: re-checked by Zod. This is the `priorityScore: 0..100` case.
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // Array bounds: re-checked by Zod. This is the `variants` length-3 case, and it is the
  // most consequential drop — see the note in `convert`.
  "minItems",
  "maxItems",
  "uniqueItems",
  // Annotations with no Gemini equivalent.
  "title",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "$id",
  "$comment",
  "deprecated",
]);

/**
 * Keys that change *which fields exist*. If one of these appears in a form this
 * converter does not handle, the declaration would be structurally wrong rather than
 * merely looser — so it throws instead.
 *
 * `anyOf`/`oneOf`/`$ref` are the realistic ones: a Zod union or a recursive schema would
 * produce them, Gemini cannot express them, and a converter that dropped them would hand
 * the model a schema describing a different tool than the one Zod will validate against.
 * Better a loud failure at the call site than a mysterious validation failure per message.
 */
const STRUCTURAL_KEYS = new Set([
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$ref",
  "$defs",
  "definitions",
  "if",
  "then",
  "else",
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "prefixItems",
  "const",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(node: Record<string, unknown>, path: string): GeminiType {
  const raw = node["type"];

  if (Array.isArray(raw)) {
    /*
     * `["string", "null"]` is how draft-7 spells an optional-and-nullable field. Gemini
     * has a separate `nullable` flag, so the null is lifted out of the union by the
     * caller and only the real type is kept. Any other multi-type union is a genuine
     * union, which Gemini cannot express.
     */
    const types = raw.filter((entry) => entry !== "null");
    if (types.length !== 1) {
      throw new UpstreamError(
        `cannot express a multi-type JSON Schema as a Gemini schema at ${path}`,
        { types: raw },
      );
    }
    return asGeminiType(types[0], path);
  }

  if (raw === undefined) {
    /*
     * A node with a description and no type: Zod emits this for `.optional()` on a plain
     * string in some positions (`dueDate` in the summary tool is exactly this). Gemini
     * requires a type, and guessing "object" would turn a string field into a nested
     * object — so "string" is the guess, and it is the right one because the only
     * typeless nodes Zod produces here are leaves.
     */
    return "string";
  }

  return asGeminiType(raw, path);
}

function asGeminiType(raw: unknown, path: string): GeminiType {
  switch (raw) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "array":
    case "object":
      return raw;
    case "null":
      // A field that can only be null carries no information and Gemini has no NULL
      // type. Nothing in this application produces one.
      throw new UpstreamError(`a null-only field cannot be a Gemini schema at ${path}`);
    default:
      throw new UpstreamError(`unknown JSON Schema type at ${path}`, { type: raw });
  }
}

/**
 * Converts one node. Recursive, and it refuses rather than guesses.
 *
 * `path` is threaded through only for the error messages: "cannot express a union" is
 * not actionable without knowing which field, and this fails at the first call of a
 * feature rather than in a review.
 */
function convert(node: unknown, path: string): GeminiSchema {
  if (!isRecord(node)) {
    throw new UpstreamError(`expected a JSON Schema object at ${path}`);
  }

  for (const key of Object.keys(node)) {
    if (STRUCTURAL_KEYS.has(key)) {
      throw new UpstreamError(
        `cannot express JSON Schema keyword "${key}" as a Gemini schema at ${path}`,
      );
    }
  }

  const type = typeOf(node, path);
  const out: GeminiSchema = { type };

  const description = node["description"];
  if (typeof description === "string" && description !== "") {
    /*
     * Descriptions are carried across, and they matter more here than on the Anthropic
     * path rather than less: they are the *only* surviving statement of the constraints
     * this converter drops. "0-100, how much this needs the user's attention soon" is
     * what makes a model produce a number in range once `maximum` is gone.
     */
    out.description = description;
  }

  if (Array.isArray(node["type"]) && node["type"].includes("null")) {
    out.nullable = true;
  }

  const enumValues = node["enum"];
  if (Array.isArray(enumValues)) {
    if (type !== "string") {
      // Gemini only honours `enum` on STRING. A numeric enum would be silently ignored
      // by the API, which is the kind of quiet loosening this module exists to refuse.
      throw new UpstreamError(`Gemini supports enum only on string fields, at ${path}`);
    }
    if (!enumValues.every((value): value is string => typeof value === "string")) {
      throw new UpstreamError(`a non-string enum cannot be a Gemini schema at ${path}`);
    }
    out.enum = enumValues;
  }

  if (type === "object") {
    const properties = node["properties"];
    if (isRecord(properties)) {
      const converted: Record<string, GeminiSchema> = {};
      for (const [key, child] of Object.entries(properties)) {
        converted[key] = convert(child, `${path}.${key}`);
      }
      out.properties = converted;
    }

    const required = node["required"];
    if (Array.isArray(required)) {
      /*
       * Required is carried across verbatim and is the one thing here that must not be
       * lost. Zod would reject a missing field anyway, but that would be a failed call
       * per message rather than a model that knew what to produce — and for the threat
       * tool the field list is load-bearing (§6).
       */
      out.required = required.filter((key): key is string => typeof key === "string");
    }
  }

  if (type === "array") {
    const items = node["items"];
    if (items === undefined) {
      throw new UpstreamError(`an array schema needs items, at ${path}`);
    }
    out.items = convert(items, `${path}[]`);
  }

  return out;
}

/**
 * The entry point: a compiled JSON Schema in, a Gemini function-declaration schema out.
 *
 * The top level must be an object, because that is what a tool's parameters are. A
 * transport calls this once per request; it is pure and cheap enough not to cache.
 */
export function toGeminiSchema(jsonSchema: Record<string, unknown>): GeminiSchema {
  const converted = convert(jsonSchema, "$");
  if (converted.type !== "object") {
    throw new UpstreamError("a tool's parameters must be an object schema", {
      type: converted.type,
    });
  }
  return converted;
}

/**
 * Which keys this converter drops, exported for the test that asserts the list is
 * *complete* for the schemas this application actually sends.
 *
 * That test is the real guard here. A new Zod refinement that emits an unhandled keyword
 * should fail in CI rather than at a user's first classification, and it cannot be caught
 * by reading this file — only by running the real schemas through it.
 */
export const GEMINI_DROPPED_KEYS: ReadonlySet<string> = DROPPED_KEYS;
export const GEMINI_STRUCTURAL_KEYS: ReadonlySet<string> = STRUCTURAL_KEYS;
