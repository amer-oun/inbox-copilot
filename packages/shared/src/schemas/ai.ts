import { z } from "zod";
import { categorySchema, prioritySchema, threatLevelSchema } from "./enums.js";

/**
 * The structured outputs of the AI layer (§5).
 *
 * These live in `shared` because they are the contract in three directions: the
 * JSON Schema handed to the model as a tool definition, the validator the response
 * is parsed with, and the shape the web app reads. Never parse an LLM response any
 * other way (rule 6) — a regex over prose is how a "priority: LOW" in an email
 * body becomes the classification.
 *
 * `.describe()` is not decoration: it is compiled into the tool's JSON Schema and
 * is what the model reads about each field.
 */

/** Score bands. Duplicated in the classify prompt, enforced in `classify.ts`. */
export const PRIORITY_BANDS = [
  { priority: "URGENT", min: 80 },
  { priority: "HIGH", min: 60 },
  { priority: "NORMAL", min: 30 },
  { priority: "LOW", min: 0 },
] as const;

export const aiClassificationSchema = z.object({
  category: categorySchema.describe("The kind of mail this is."),
  priority: prioritySchema.describe(
    "The band priorityScore falls in: URGENT 80-100, HIGH 60-79, NORMAL 30-59, LOW 0-29.",
  ),
  priorityScore: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("0-100, how much this needs the user's attention soon."),
  needsReply: z
    .boolean()
    .describe("True only if the sender is waiting on a response from the user."),
  language: z
    .string()
    .min(2)
    .max(12)
    .describe('BCP-47 code of the body\'s main language, e.g. "en", "pt-BR".'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("0-1 confidence in the category and priority."),
});
export type AiClassificationOutput = z.infer<typeof aiClassificationSchema>;

export const aiActionItemSchema = z.object({
  text: z.string().min(1).describe("What must be done, in one line."),
  owner: z
    .string()
    .min(1)
    .describe('Who owns it. "user" for the mailbox owner, otherwise the person\'s name.'),
  dueDate: z
    .string()
    .optional()
    .describe("ISO-8601 date, only when the thread states one."),
});
export type AiActionItem = z.infer<typeof aiActionItemSchema>;

export const aiSummarySchema = z.object({
  headline: z
    .string()
    .min(1)
    .max(200)
    .describe("One line under 80 characters naming the concrete state of the thread."),
  summary: z
    .string()
    .min(1)
    .describe("Short paragraph: what this is about, what is decided, what is open."),
  keyPoints: z
    .array(z.string().min(1))
    .max(10)
    .describe("The facts a reader needs, one per item."),
  actionItems: z
    .array(aiActionItemSchema)
    .max(10)
    .describe("Only things somebody must actually do. An empty list is valid."),
});
export type AiSummaryOutput = z.infer<typeof aiSummarySchema>;

/** What `POST /threads/:id/summary` and the enrich job report back. */
export const aiEnrichResultSchema = z.object({
  messageId: z.string(),
  classified: z.boolean(),
  summarized: z.boolean(),
  /**
   * The verdict §6's layers reached, when they ran. Omitted rather than UNKNOWN when
   * they did not: "we did not look" and "we looked and found nothing" are different
   * outcomes, and the `skipped` list says which.
   */
  threatLevel: threatLevelSchema.optional(),
  /** Set when work was skipped rather than done: "cache" | "cap" | "disabled". */
  skipped: z.array(z.string()),
});
export type AiEnrichResult = z.infer<typeof aiEnrichResultSchema>;
