import { dbForUser } from "@inbox-copilot/db";
import {
  aiReplyVariantsSchema,
  type ReplyDraftDto,
  type ReplyDraftsResponseDto,
  type ReplyTone,
} from "@inbox-copilot/shared";
import { NotFoundError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { callStructured } from "./client.js";
import { threadForPrompt, MESSAGE_PROMPT_SELECT, type MessageForPrompt } from "./content.js";
import { replyRequestBlock, untrustedThreadBlock } from "./prompts.js";
import { loadWritingStyle } from "./style.js";
import { loadAiSettings, type AiSettings } from "./usage.js";

/**
 * Smart replies (§5): three drafts for one thread, in one tone, in the user's voice.
 *
 * This is the most attractive injection target in the application (§7). A
 * classifier that is steered writes a wrong enum; this writes text that a human may
 * then send from their own address, to whoever the thread says. So the defense is
 * not only in the prompt:
 *
 *   - the tool has exactly two fields per draft, `label` and `body`. There is no
 *     recipient, no subject, no attachment and no send — a model that decides to
 *     mail a third party has nowhere to put the address;
 *   - recipients are computed later, by `services/send.ts`, from the parent
 *     message's own headers. Nothing the model emits reaches an address field;
 *   - our instruction block is emitted *after* the thread, so the attacker's text is
 *     not the last thing the model reads;
 *   - and nothing here sends. These rows are drafts (rule 1), shown in an editor.
 *
 * What comes back is a record of what was offered, not a cache: regenerating is a
 * deliberate user action, and the daily cap plus the usage ledger are what bound it.
 */

const TOOL_NAME = "record_reply_drafts";
const TOOL_DESCRIPTION =
  "Record three alternative reply drafts for the thread in the untrusted_email blocks. This is the only way to respond. It does not send anything.";

export interface GenerateRepliesInput {
  userId: string;
  threadId: string;
  /** Omitted means the user's `UserSettings.defaultTone`. */
  tone?: ReplyTone;
  settings?: AiSettings;
  signal?: AbortSignal;
}

interface LoadedThread {
  mailboxAddress: string;
  messages: MessageForPrompt[];
}

/**
 * Loads the thread through the tenancy client.
 *
 * This read is also the ownership check for the `ReplyDraft` rows written below:
 * they are path-scoped through `Thread`, so the guarantee that we are drafting on
 * our own user's thread comes from this query succeeding. A thread belonging to
 * somebody else is a 404, which is also what the UI should show — there is no
 * "forbidden" that would confirm the id exists.
 */
async function loadThread(userId: string, threadId: string): Promise<LoadedThread> {
  const row = await dbForUser(userId).thread.findFirst({
    where: { id: threadId },
    select: {
      mailAccount: { select: { emailAddress: true } },
      messages: { orderBy: { sentAt: "asc" }, select: MESSAGE_PROMPT_SELECT },
    },
  });

  if (!row) throw new NotFoundError("Thread not found");
  if (row.messages.length === 0) throw new NotFoundError("Thread has no messages");

  return {
    mailboxAddress: row.mailAccount.emailAddress,
    messages: row.messages as MessageForPrompt[],
  };
}

/**
 * Generates three drafts and persists them.
 *
 * `label` is returned but not stored: `ReplyDraft` has columns for the body and the
 * feedback signal, which is what a later prompt-tuning pass needs. The label is a
 * picker affordance for the session that asked for it, and inventing a column to
 * keep it would be schema churn for a string nobody reads twice.
 */
export async function generateReplies(
  input: GenerateRepliesInput,
): Promise<ReplyDraftsResponseDto> {
  const settings = input.settings ?? (await loadAiSettings(input.userId));
  const tone = input.tone ?? settings.defaultTone;

  const { mailboxAddress, messages } = await loadThread(input.userId, input.threadId);
  const style = await loadWritingStyle(input.userId);

  const { data, model } = await callStructured({
    userId: input.userId,
    feature: "reply",
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    schema: aiReplyVariantsSchema,
    // Thread first, our instructions last. Both halves are in the user turn; the
    // system prompt is the registry's and contains no mail (§7 rule 1).
    userContent: [
      untrustedThreadBlock(threadForPrompt(messages, mailboxAddress)),
      replyRequestBlock({ tone, style }),
    ].join("\n\n"),
    settings,
    ...(input.signal ? { signal: input.signal } : {}),
    logContext: { threadId: input.threadId, tone, styleApplied: style !== null },
  });

  const drafts: ReplyDraftDto[] = [];
  for (const variant of data.variants) {
    const row = await dbForUser(input.userId).replyDraft.create({
      data: { threadId: input.threadId, tone, body: variant.body, model },
      select: { id: true, tone: true, body: true, model: true, createdAt: true },
    });

    drafts.push({
      id: row.id,
      tone: row.tone as ReplyTone,
      label: variant.label,
      body: row.body,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    });
  }

  logger.info(
    {
      userId: input.userId,
      threadId: input.threadId,
      tone,
      drafts: drafts.length,
      model,
      styleApplied: style !== null,
    },
    "reply drafts generated",
  );

  return { threadId: input.threadId, tone, drafts, styleApplied: style !== null };
}
