import { dbForUser } from "@inbox-copilot/db";
import {
  aiTranslationSchema,
  translationSchema,
  type TranslationDto,
} from "@inbox-copilot/shared";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { callStructured } from "./client.js";
import { MESSAGE_PROMPT_SELECT, messageForPrompt, type MessageForPrompt } from "./content.js";
import { translationRequestBlock, untrustedEmailBlock } from "./prompts.js";
import type { AiSettings } from "./usage.js";

/**
 * Translation (§9), cached per `(messageId, targetLang)`.
 *
 * Rule 7 is easy here and worth being precise about, because the cache key is not the
 * one the rest of the AI layer uses. `Translation` is unique on `(messageId,
 * targetLang)` and *also* stores a `contentHash`, and both are needed:
 *
 *   - the unique pair is what makes "translate this to French" idempotent, so the
 *     second reader of the same message pays nothing;
 *   - the hash is what stops a *stale* translation being served. A message can be
 *     re-fetched with a corrected body (a delta re-read, a provider fixing its own
 *     truncation), and a translation of the old text is then a translation of
 *     something the user is no longer looking at. So a row whose hash does not match
 *     is a miss, and it is overwritten rather than duplicated.
 *
 * On the injection question, the honest statement of the risk is in the prompt's own
 * comment (`TRANSLATE_SYSTEM_PROMPT`) and in the output schema
 * (`aiTranslationSchema`): this is the one output the reader receives *as* the sender's
 * words, so the defense is a schema with two fields and an instruction to reproduce
 * rather than obey. What this file adds is the plumbing that keeps it there — the body
 * goes through `untrustedEmailBlock` like every other prompt, our request block is
 * emitted after it, and the translated text is written to a column the UI renders as
 * text.
 */

const TOOL_NAME = "record_translation";
const TOOL_DESCRIPTION =
  "Record the translation of the email in the untrusted_email block. This is the only way to respond.";

export interface TranslateMessageInput {
  userId: string;
  messageId: string;
  /** BCP-47. Ours: the route resolves it from the request or from UserSettings. */
  targetLang: string;
  settings?: AiSettings;
  signal?: AbortSignal;
}

/**
 * Translates one message body, or returns what we already have.
 *
 * Outbound messages are translatable too, and deliberately: the user's own sent mail in
 * a thread they are reading in translation should not be the one paragraph they cannot
 * read. Unlike threat assessment there is nothing absurd about it.
 */
export async function translateMessage(
  input: TranslateMessageInput,
): Promise<TranslationDto> {
  const targetLang = normalizeLang(input.targetLang);
  const db = dbForUser(input.userId);

  const message = await db.message.findFirst({
    where: { id: input.messageId },
    select: {
      ...MESSAGE_PROMPT_SELECT,
      mailAccount: { select: { emailAddress: true } },
    },
  });

  // The tenancy filter makes somebody else's message not exist, so this 404 is also
  // the ownership check.
  if (!message) throw new NotFoundError("Message not found");

  const cached = await db.translation.findFirst({
    where: { messageId: input.messageId, targetLang },
    select: {
      targetLang: true,
      sourceLang: true,
      translatedText: true,
      model: true,
      contentHash: true,
      createdAt: true,
    },
  });

  if (cached && cached.contentHash === message.contentHash) {
    // Rule 7: a cache hit is the whole point, and it costs no tokens and no ledger row.
    logger.debug(
      { userId: input.userId, messageId: input.messageId, targetLang },
      "translation cache hit",
    );
    return translationSchema.parse({
      messageId: input.messageId,
      targetLang: cached.targetLang,
      sourceLang: cached.sourceLang,
      translatedText: cached.translatedText,
      model: cached.model,
      fromCache: true,
      createdAt: cached.createdAt.toISOString(),
    });
  }

  if (cached) {
    logger.debug(
      { userId: input.userId, messageId: input.messageId, targetLang },
      "stored translation is of an older body; re-translating",
    );
  }

  const prompt = messageForPrompt(
    message as unknown as MessageForPrompt,
    message.mailAccount.emailAddress,
  );

  if (prompt.body.trim() === "") {
    throw new BadRequestError("This message has no text to translate");
  }

  const { data, model } = await callStructured({
    userId: input.userId,
    feature: "translate",
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    schema: aiTranslationSchema,
    // Our instruction block last, as everywhere else in this layer: the final thing the
    // model reads must be ours rather than the sender's.
    userContent: [untrustedEmailBlock(prompt), translationRequestBlock({ targetLang })].join(
      "\n",
    ),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    logContext: { messageId: input.messageId, targetLang },
  });

  const fields = {
    sourceLang: data.sourceLang,
    translatedText: data.translatedText,
    contentHash: message.contentHash,
    model,
  };

  /*
   * Upsert on the unique pair, so two readers asking for the same language at once
   * collide on the key rather than writing two rows — and a re-translation after a
   * body correction replaces the stale text instead of accumulating beside it.
   */
  const row = await db.translation.upsert({
    where: { messageId_targetLang: { messageId: input.messageId, targetLang } },
    create: { messageId: input.messageId, targetLang, ...fields },
    update: fields,
    select: { createdAt: true },
  });

  logger.info(
    {
      userId: input.userId,
      messageId: input.messageId,
      targetLang,
      sourceLang: data.sourceLang,
      model,
      chars: data.translatedText.length,
    },
    "message translated",
  );

  return translationSchema.parse({
    messageId: input.messageId,
    targetLang,
    sourceLang: data.sourceLang,
    translatedText: data.translatedText,
    model,
    fromCache: false,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * The stored form of a language tag.
 *
 * Lowercased region and all, because the tag is half of a unique key: `"fr-CA"` and
 * `"fr-ca"` are the same language and must not become two rows and two Sonnet calls.
 * Cosmetic casing is the UI's business.
 */
export function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase();
}

/**
 * The language to translate into when the request does not name one.
 *
 * A user with no `translationLang` is a 400 rather than a guess. The alternatives are
 * all worse: the browser's `Accept-Language` is the language of their *interface*, and
 * defaulting to English would be this application deciding what its user reads.
 */
export async function resolveTargetLang(input: {
  userId: string;
  requested?: string;
}): Promise<string> {
  if (input.requested !== undefined) return normalizeLang(input.requested);

  const settings = await dbForUser(input.userId).userSettings.findFirst({
    where: { userId: input.userId },
    select: { translationLang: true },
  });

  if (settings?.translationLang) return normalizeLang(settings.translationLang);

  throw new BadRequestError(
    "No translation language set. Choose one, or set a default in your settings.",
  );
}
