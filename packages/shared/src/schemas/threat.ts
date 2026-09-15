import { z } from "zod";
import { cuidSchema } from "./common.js";
import { threatLevelSchema } from "./enums.js";

/**
 * Phishing and spam detection (§6). Three layers, and the layering is the contract:
 *
 *   1. **Header truth** — SPF, DKIM, DMARC, display-name and Return-Path alignment,
 *      read from what the receiving server recorded.
 *   2. **Heuristics** — lookalike domains, link text that disagrees with its href,
 *      raw-IP and punycode links, first-time senders, risky attachments.
 *   3. **The model** — given the findings of 1 and 2 *plus* the body, what was the
 *      sender trying to do, and how do we explain that to the user.
 *
 * The shapes below encode one rule that the prose cannot enforce on its own: the
 * model's output has no field with which it can lower a verdict. It names an intent
 * and a level, and the level is unioned with the rules' floor in code
 * (`services/security/phishing.ts`). A DMARC fail therefore stays suspicious however
 * plausible the prose — which is the entire reason the deterministic layers run
 * first.
 */

/** The verdicts an `Authentication-Results` header can carry. */
export const authVerdictSchema = z.enum([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
]);
export type AuthVerdict = z.infer<typeof authVerdictSchema>;

/**
 * Layer 1 findings.
 *
 * Every verdict is nullable and a null is never read as a pass — the rule from
 * phase 2, restated here because this is where it starts having consequences. An
 * absent DMARC verdict means the receiver did not evaluate DMARC, which tells us
 * nothing good about the sender and must not be scored as though it did.
 */
export const headerSignalsSchema = z.object({
  fromDomain: z.string().nullable(),
  spf: authVerdictSchema.nullable(),
  dkim: authVerdictSchema.nullable(),
  dmarc: authVerdictSchema.nullable(),
  /** True when the From display name contains an address that is not the From address. */
  displayNameMismatch: z.boolean(),
  replyToDomain: z.string().nullable(),
  /** True only when a Reply-To exists and its registrable domain differs from From's. */
  replyToDiffers: z.boolean(),
  returnPathDomain: z.string().nullable(),
  /**
   * Whether the envelope sender's domain matches From's. `null` means the header did
   * not disclose a Return-Path — unknown, not aligned.
   */
  returnPathAligned: z.boolean().nullable(),
});
export type HeaderSignals = z.infer<typeof headerSignalsSchema>;

/** A domain that resembles one the user actually corresponds with. */
export const lookalikeSchema = z.object({
  /** The domain as it appeared. */
  domain: z.string(),
  /** The known domain it resembles. */
  resembles: z.string(),
  /** Levenshtein distance after homoglyph normalization. 0 means only confusables differed. */
  distance: z.number().int().min(0),
  /** True when normalizing confusable characters is what revealed the resemblance. */
  viaHomoglyphs: z.boolean(),
});
export type Lookalike = z.infer<typeof lookalikeSchema>;

/** A link whose visible text claims one destination and whose href is another. */
export const linkMismatchSchema = z.object({
  shownHost: z.string(),
  actualHost: z.string(),
});
export type LinkMismatch = z.infer<typeof linkMismatchSchema>;

/** Layer 2 findings about the links in the body. */
export const urlSignalsSchema = z.object({
  linkCount: z.number().int().nonnegative(),
  /** Hosts that are bare IP addresses — no legitimate brand links this way. */
  rawIpHosts: z.array(z.string()),
  /** Hosts carrying an `xn--` label, which renders as script the eye cannot check. */
  punycodeHosts: z.array(z.string()),
  displayMismatches: z.array(linkMismatchSchema),
  lookalikeHosts: z.array(lookalikeSchema),
});
export type UrlSignals = z.infer<typeof urlSignalsSchema>;

/** Layer 2 findings about the sender. */
export const senderSignalsSchema = z.object({
  /** How many earlier messages this mailbox has from this address. */
  messagesSeenFrom: z.number().int().nonnegative(),
  /** True when this is the first message from this address. Weak on its own. */
  firstTimeSender: z.boolean(),
  /** Set when the sender's domain resembles one the user does correspond with. */
  lookalikeDomain: lookalikeSchema.nullable(),
  punycodeSender: z.boolean(),
});
export type SenderSignals = z.infer<typeof senderSignalsSchema>;

export const riskyAttachmentSchema = z.object({
  filename: z.string(),
  /** The deterministic tag the sync engine wrote: "executable" | "macro" | "archive". */
  riskFlag: z.string(),
});
export type RiskyAttachment = z.infer<typeof riskyAttachmentSchema>;

/**
 * The whole deterministic assessment, as stored in `AiClassification.ruleSignals`.
 *
 * The outcome (`score`, `floor`, `reasons`) is kept in here alongside the findings,
 * so the row answers "what did the rules alone conclude?" without re-deriving it —
 * which is the question to ask when a verdict looks wrong, and the only way to tell
 * a floor the rules set from a level the model raised.
 */
export const ruleSignalsSchema = z.object({
  /** Bumped when the rule set changes, so a stored assessment can be recognized as old. */
  version: z.literal(1),
  /**
   * Hash of the findings. The model's interpretation is cached against it: the same
   * body with the same signals is never re-interpreted, and a body whose signals have
   * changed is, even when the text has not.
   */
  fingerprint: z.string(),
  header: headerSignalsSchema,
  urls: urlSignalsSchema,
  sender: senderSignalsSchema,
  attachments: z.array(riskyAttachmentSchema),
  /** 0-100 from the rules alone. */
  score: z.number().int().min(0).max(100),
  /** The level the rules require. The model may raise this; nothing may lower it. */
  floor: threatLevelSchema,
  /** User-facing, one per finding. These are what the banner shows. */
  reasons: z.array(z.string()),
});
export type RuleSignals = z.infer<typeof ruleSignalsSchema>;

/**
 * What the model is asked to name: what the sender was *trying* to do.
 *
 * Intent is the one judgment the deterministic layers genuinely cannot make. A
 * lookalike domain with a DMARC fail is evidence; whether it is an invoice scam or a
 * credential page is a reading of the prose.
 */
export const threatIntentSchema = z.enum([
  "CREDENTIAL_HARVEST",
  "BEC",
  "INVOICE_FRAUD",
  "MALWARE",
  "EXTORTION",
  "ADVANCE_FEE",
  "BENIGN_MARKETING",
  "BENIGN_TRANSACTIONAL",
  "BENIGN_PERSONAL",
  "UNCLEAR",
]);
export type ThreatIntent = z.infer<typeof threatIntentSchema>;

/**
 * The model's tool (layer 3). Four fields, and what is *missing* is the point:
 *
 *   - there is no score, so a model cannot argue a number down;
 *   - there is no "override" or "dismiss", so a persuasive email has no field to aim
 *     at;
 *   - `assessedLevel` cannot say UNKNOWN. "I cannot tell" is SUSPICIOUS's job when
 *     the rules found something and SAFE's when they did not — and either way the
 *     union with the rules decides, not this value alone.
 */
export const aiThreatAssessmentSchema = z.object({
  intent: threatIntentSchema.describe(
    "What the sender was trying to achieve. Judge from the prose plus the signals, not from what the email claims about itself.",
  ),
  assessedLevel: z
    .enum(["SAFE", "SPAM", "SUSPICIOUS", "PHISHING"])
    .describe(
      "Your own reading. SAFE for legitimate mail, SPAM for unsolicited bulk, SUSPICIOUS when something is wrong but the intent is unclear, PHISHING for a deliberate attempt to deceive this reader. This can raise the deterministic verdict and can never lower it.",
    ),
  confidence: z.number().min(0).max(1).describe("0-1 confidence in the intent."),
  explanation: z
    .string()
    .min(1)
    .max(600)
    .describe(
      "Two or three sentences for the reader of this mailbox, in plain language: what to look at and what to do. Name the concrete evidence. No jargon, no reassurance you cannot justify.",
    ),
});
export type AiThreatAssessmentOutput = z.infer<typeof aiThreatAssessmentSchema>;

/** A user's disagreement with a verdict, as the UI reads it back. */
export const threatAppealSchema = z.object({
  createdAt: z.iso.datetime(),
  note: z.string().nullable(),
  /** The verdict they were looking at when they disagreed. */
  claimedLevel: threatLevelSchema,
  claimedScore: z.number().int().min(0).max(100),
});
export type ThreatAppealDto = z.infer<typeof threatAppealSchema>;

/**
 * One message's verdict, as the thread view receives it.
 *
 * `reasons` rather than only `score` is a product requirement from §6: a number
 * teaches a user nothing, and the point of showing the evidence is that they learn to
 * spot it without us.
 */
export const threatAssessmentSchema = z.object({
  messageId: cuidSchema,
  level: threatLevelSchema,
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string()),
  /** Null when the rules ran alone — AI off, or the daily cap spent. */
  intent: threatIntentSchema.nullable(),
  explanation: z.string().nullable(),
  model: z.string().nullable(),
  /** What the deterministic layers alone concluded, before the model saw anything. */
  ruleScore: z.number().int().min(0).max(100),
  ruleFloor: threatLevelSchema,
  /** Set when the user has said this is a false positive. */
  appeal: threatAppealSchema.nullable(),
});
export type ThreatAssessmentDto = z.infer<typeof threatAssessmentSchema>;

/** `POST /messages/:messageId/threat-appeal` */
export const threatAppealBodySchema = z.object({
  /** Optional: why they think it is safe. Recorded, never fed back into a prompt. */
  note: z.string().trim().max(500).optional(),
});
export type ThreatAppealBody = z.infer<typeof threatAppealBodySchema>;

export const messageIdParamsSchema = z.object({ messageId: cuidSchema });

export const threatAppealResponseSchema = z.object({
  messageId: cuidSchema,
  appeal: threatAppealSchema,
});
export type ThreatAppealResponseDto = z.infer<typeof threatAppealResponseSchema>;
