import { dbForUser, type Prisma } from "@inbox-copilot/db";
import {
  aiClassificationSchema,
  PRIORITY_BANDS,
  type AiClassificationOutput,
  type Category,
  type Priority,
} from "@inbox-copilot/shared";
import { logger } from "../../lib/logger.js";
import { callStructured } from "./client.js";
import { cachedClassification } from "./cache.js";
import { messageForPrompt, type MessageForPrompt } from "./content.js";
import { untrustedEmailBlock } from "./prompts.js";
import type { AiSettings } from "./usage.js";

/**
 * Per-message classification (§5): category, priority, language, needsReply.
 *
 * Runs on every message, so it runs on Haiku and its prompt is kept tight. The
 * threat fields of `AiClassification` are deliberately *not* asked of the model
 * here — see the note on `THREAT_PLACEHOLDER` below.
 */

const TOOL_NAME = "record_classification";
const TOOL_DESCRIPTION =
  "Record the classification of the email in the untrusted_email block. This is the only way to respond.";

/**
 * Threat assessment is phase 9, and §6 is explicit that it must not be the model's
 * job alone: layer 1 (header truth) and layer 2 (heuristics) come first, and the
 * model only judges *intent* given those signals. Asking Haiku for a threat verdict
 * now would produce a number with nothing behind it — and a well-written phishing
 * mail is exactly what talks its way past a model with no header facts to check.
 *
 * So the columns are written honestly as "not assessed": UNKNOWN, not SAFE.
 */
const THREAT_PLACEHOLDER = {
  threatLevel: "UNKNOWN",
  threatScore: 0,
  threatReasons: [] as string[],
  ruleSignals: {} as Record<string, never>,
} as const;

/** The band a score falls in, per §5's anchors. */
export function bandFor(score: number): Priority {
  const band = PRIORITY_BANDS.find((entry) => score >= entry.min);
  return (band?.priority ?? "LOW") as Priority;
}

/**
 * Reconciles the model's two priority fields.
 *
 * They can disagree — a model that says `LOW` with a score of 90 has contradicted
 * itself — and something has to decide. The score wins: it is the finer-grained
 * value, it is what the list view sorts by, and a band derived from it is always
 * self-consistent. The disagreement is logged because a rise in its rate is a
 * signal about the prompt, not about the mail.
 */
export function reconcilePriority(
  output: AiClassificationOutput,
  context: Record<string, unknown> = {},
): Priority {
  const derived = bandFor(output.priorityScore);
  if (derived !== output.priority) {
    logger.warn(
      { ...context, modelPriority: output.priority, priorityScore: output.priorityScore, derived },
      "classification priority disagreed with its own score; using the score",
    );
  }
  return derived;
}

export interface ClassifyInput {
  userId: string;
  mailAccountId: string;
  mailboxAddress: string;
  message: MessageForPrompt;
  settings?: AiSettings;
  signal?: AbortSignal;
}

export interface ClassifyResult {
  classification: {
    category: Category;
    priority: Priority;
    priorityScore: number;
    needsReply: boolean;
    language: string;
  };
  /** True when no model call was made. */
  fromCache: boolean;
  model: string;
}

/**
 * Classifies one message, or returns the cached answer.
 *
 * The cache check is first and unconditional (rule 7). It is keyed on the message's
 * `contentHash`, so a re-synced message with an unchanged body never costs a token.
 */
export async function classifyMessage(input: ClassifyInput): Promise<ClassifyResult> {
  const { message } = input;

  const cached = await cachedClassification(input.userId, message.id, message.contentHash);
  if (cached) {
    return {
      classification: {
        category: cached.category as Category,
        priority: cached.priority as Priority,
        priorityScore: cached.priorityScore,
        needsReply: cached.needsReply,
        language: cached.language,
      },
      fromCache: true,
      model: cached.model,
    };
  }

  const { data, model } = await callStructured({
    userId: input.userId,
    feature: "classify",
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    schema: aiClassificationSchema,
    userContent: untrustedEmailBlock(messageForPrompt(message, input.mailboxAddress)),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    logContext: { messageId: message.id, mailAccountId: input.mailAccountId },
  });

  const priority = reconcilePriority(data, {
    userId: input.userId,
    messageId: message.id,
  });

  const fields = {
    category: data.category,
    priority,
    priorityScore: data.priorityScore,
    needsReply: data.needsReply,
    language: data.language,
    confidence: data.confidence,
    model,
    contentHash: message.contentHash,
    threatLevel: THREAT_PLACEHOLDER.threatLevel,
    threatScore: THREAT_PLACEHOLDER.threatScore,
    threatReasons: THREAT_PLACEHOLDER.threatReasons as unknown as Prisma.InputJsonValue,
    ruleSignals: THREAT_PLACEHOLDER.ruleSignals as unknown as Prisma.InputJsonValue,
  };

  // Upsert, not create: `messageId` is unique, and a re-classification after the
  // body changed must replace the stale row rather than fail the job.
  await dbForUser(input.userId).aiClassification.upsert({
    where: { messageId: message.id },
    create: { messageId: message.id, ...fields },
    update: fields,
  });

  return {
    classification: {
      category: data.category,
      priority,
      priorityScore: data.priorityScore,
      needsReply: data.needsReply,
      language: data.language,
    },
    fromCache: false,
    model,
  };
}
