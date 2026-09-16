import { z } from "zod";
import { cuidSchema, emailSchema } from "./common.js";
import { replyToneSchema } from "./enums.js";

/**
 * Reply, compose and writing-style contracts (ARCHITECTURE §5).
 *
 * The shapes here are also the JSON Schemas handed to the model as tool
 * definitions, so their *absences* are load-bearing. A reply variant is a body and
 * nothing else: no recipient field, no subject, no send flag. The model cannot
 * address a third party or trigger a send because there is no field in which to do
 * it — recipients are computed by our code from the parent message, and sending is
 * a separate call carrying text the user submitted (rule 1, §7 rule 3).
 */

/**
 * What each tone asks for. Ours, not the model's: the enum value arrives from the
 * UI and is mapped to this text in `prompts.ts`, so nothing free-form reaches the
 * prompt through the tone parameter.
 */
export const TONE_GUIDANCE: Readonly<Record<z.infer<typeof replyToneSchema>, string>> = {
  PROFESSIONAL: "Professional and warm. Plain, competent, no corporate filler.",
  FRIENDLY: "Friendly and personable. Contractions are fine; stay concrete.",
  CONCISE: "As short as it can be while still answering. Two or three sentences.",
  FORMAL: "Formal. Full sentences, no contractions, measured register.",
  APOLOGETIC: "Apologetic without grovelling. Acknowledge the miss, then move to the fix.",
  ENTHUSIASTIC: "Enthusiastic and energetic. Positive, but never gushing or salesy.",
};

// ── AI outputs ───────────────────────────────────────────────────────────────

export const replyVariantSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(60)
    .describe(
      'Two to five words naming this variant\'s approach, e.g. "Accept and confirm Tuesday".',
    ),
  body: z
    .string()
    .min(1)
    .describe(
      "The reply body as plain text, written as the mailbox owner. No subject line, no To/Cc header, no quoted original.",
    ),
});
export type ReplyVariant = z.infer<typeof replyVariantSchema>;

export const aiReplyVariantsSchema = z.object({
  variants: z
    .array(replyVariantSchema)
    .length(3)
    .describe("Exactly three drafts that differ in substance, not just wording."),
});
export type AiReplyVariantsOutput = z.infer<typeof aiReplyVariantsSchema>;

export const aiComposedMessageSchema = z.object({
  subject: z
    .string()
    .min(1)
    .max(200)
    .describe("Subject line. No 'Re:' prefix — this is a new message."),
  body: z
    .string()
    .min(1)
    .describe("The message body as plain text, written as the mailbox owner."),
});
export type AiComposedMessageOutput = z.infer<typeof aiComposedMessageSchema>;

export const formalitySchema = z.enum(["casual", "neutral", "formal"]);
export type Formality = z.infer<typeof formalitySchema>;

/**
 * The model's half of the writing-style profile.
 *
 * Only the judgments a model is actually better at. Sentence length and emoji use
 * are counted in code from the same samples — asking for a number a regex can
 * measure exactly would be paying for a worse answer.
 */
export const aiWritingStyleSchema = z.object({
  greeting: z
    .string()
    .max(120)
    .describe(
      'How this person opens a message, as a template with <name> for the recipient, e.g. "Hi <name>," — empty string if they usually open with no greeting.',
    ),
  signOff: z
    .string()
    .max(160)
    .describe(
      'How this person closes, including their name as they write it, e.g. "Best,\nAmer" — empty string if they usually do not sign off.',
    ),
  formality: formalitySchema.describe("Overall register of these samples."),
  descriptor: z
    .string()
    .min(1)
    .max(1200)
    .describe(
      "A paragraph another writer could follow to sound like this person: sentence rhythm, directness, hedging, humour, structure, punctuation habits, and anything distinctive. Describe the writing, never the content of any one email.",
    ),
});
export type AiWritingStyleOutput = z.infer<typeof aiWritingStyleSchema>;

// ── Wire contracts ───────────────────────────────────────────────────────────

export const writingStyleSchema = z.object({
  greeting: z.string().nullable(),
  signOff: z.string().nullable(),
  formality: formalitySchema.nullable(),
  avgSentenceLen: z.number().int().nonnegative().nullable(),
  usesEmoji: z.boolean(),
  descriptor: z.string().nullable(),
  /** How many sent messages this was built from. 0 means "not built yet". */
  sampleCount: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});
export type WritingStyleDto = z.infer<typeof writingStyleSchema>;

export const writingStyleResponseSchema = z.object({
  style: writingStyleSchema.nullable(),
});
export type WritingStyleResponseDto = z.infer<typeof writingStyleResponseSchema>;

/** One draft as the UI sees it. `label` is not persisted — see reply.ts. */
export const replyDraftSchema = z.object({
  id: cuidSchema,
  tone: replyToneSchema,
  label: z.string().nullable(),
  body: z.string(),
  model: z.string(),
  createdAt: z.iso.datetime(),
});
export type ReplyDraftDto = z.infer<typeof replyDraftSchema>;

export const replyDraftsResponseSchema = z.object({
  threadId: cuidSchema,
  tone: replyToneSchema,
  drafts: z.array(replyDraftSchema),
  /** True when the writing-style profile was available and injected. */
  styleApplied: z.boolean(),
});
export type ReplyDraftsResponseDto = z.infer<typeof replyDraftsResponseSchema>;

export const generateRepliesBodySchema = z.object({
  /** Omitted means the user's `UserSettings.defaultTone`. */
  tone: replyToneSchema.optional(),
});
export type GenerateRepliesBody = z.infer<typeof generateRepliesBodySchema>;

/**
 * The send request.
 *
 * `body` is the text the user has seen in the composer and submitted — there is no
 * field by which a caller could ask the server to generate and send in one step,
 * and no endpoint that accepts a model output id alone. `draftId` is feedback only:
 * it records which variant was used and how far it was edited.
 */
export const sendReplyBodySchema = z.object({
  body: z.string().min(1).max(100_000),
  draftId: cuidSchema.optional(),
  /**
   * Create a follow-up reminder for this message (§9).
   *
   * A boolean the user ticked, not a judgment: `AiClassification.needsReply` is the
   * model's opinion about mail *arriving*, and using it to decide whether to chase
   * somebody would be the application deciding who owes the user an answer. Default
   * false — a reminder nobody asked for is a notification nobody wants.
   */
  expectsReply: z.boolean().default(false),
});
export type SendReplyBody = z.infer<typeof sendReplyBodySchema>;

export const sendResultSchema = z.object({
  providerMessageId: z.string(),
  providerThreadId: z.string(),
  sentAt: z.iso.datetime(),
  /** Set when the send was attributed to one of the offered drafts. */
  usedDraftId: cuidSchema.nullable(),
  /** True when the sent text differed from that draft. */
  edited: z.boolean(),
  /**
   * The follow-up reminder this send created, when one was asked for and created.
   * Null when it was not asked for, when the thread already had an open reminder, or
   * when the bookkeeping failed after a successful send — the send is what matters.
   */
  reminderId: cuidSchema.nullable().default(null),
});
export type SendResultDto = z.infer<typeof sendResultSchema>;

export const composeBodySchema = z.object({
  /** What the user wants to say, in their words. */
  intent: z.string().min(1).max(4_000),
  to: emailSchema,
  tone: replyToneSchema.optional(),
});
export type ComposeBody = z.infer<typeof composeBodySchema>;

export const composeResultSchema = z.object({
  subject: z.string(),
  body: z.string(),
  model: z.string(),
  /** How many prior messages with this recipient were used as context. */
  contextMessages: z.number().int().nonnegative(),
  styleApplied: z.boolean(),
});
export type ComposeResultDto = z.infer<typeof composeResultSchema>;
