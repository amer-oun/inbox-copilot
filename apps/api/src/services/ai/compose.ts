import { dbForUser, prisma } from "@inbox-copilot/db";
import {
  aiComposedMessageSchema,
  type ComposeResultDto,
  type ReplyTone,
} from "@inbox-copilot/shared";
import { logger } from "../../lib/logger.js";
import { callStructured } from "./client.js";
import {
  messageForPrompt,
  MESSAGE_PROMPT_SELECT,
  type MessageForPrompt,
} from "./content.js";
import { composeRequestBlock, untrustedCorrespondenceBlock } from "./prompts.js";
import { loadWritingStyle } from "./style.js";
import { loadAiSettings, type AiSettings } from "./usage.js";

/**
 * The composer (§5): a new message from an intent, a recipient, and whatever history
 * the user already has with that person.
 *
 * The history is what makes the output usable — the same intent to a colleague and
 * to a bank is not the same email — and it is also the injection surface, because it
 * is mail somebody else wrote. So it goes in the untrusted block like any other
 * body, and the two things a composer could be steered into are both impossible by
 * construction rather than by instruction:
 *
 *   - the recipient comes from the user's own request, never from the model's
 *     output. The tool has `subject` and `body` and nothing else;
 *   - nothing is sent. This returns text for an editor (rule 1).
 */

const TOOL_NAME = "record_composed_message";
const TOOL_DESCRIPTION =
  "Record the subject and body of the message the user asked for. This is the only way to respond. It does not send anything.";

/**
 * How much history to show. Enough to establish the register and any open business,
 * short enough that composing a mail to a frequent correspondent is not a
 * thread-summarization bill.
 */
export const COMPOSE_CONTEXT_MESSAGES = 8;

/**
 * Ids of the last messages exchanged with one address, newest first.
 *
 * Raw SQL, for a storage reason: `Message.to`/`cc` hold formatted addresses
 * (`"Ada <ada@example.com>"`), so Postgres array containment — the only array
 * predicate Prisma offers — cannot find an address inside them. Matching only
 * `fromEmail` instead would give the model half a conversation: everything the
 * correspondent said and nothing the user replied, which is precisely the half that
 * carries the user's register.
 *
 * Tenancy is written out (`MailAccount."userId" = $1`) because this bypasses the
 * Prisma extension — the same trade, and the same comment, as
 * `sweep.ts:findThreadsMissingSummaries`. Only ids come back; the bodies are then
 * read through `dbForUser`, so the rows a prompt is built from are still fetched by
 * a query the extension narrowed.
 *
 * `%` and `_` in the needle are escaped: an address is allowed to contain an
 * underscore, and an unescaped one would silently widen the match by a character.
 */
async function findCorrespondenceIds(
  userId: string,
  recipient: string,
  limit: number,
): Promise<string[]> {
  const needle = `%${recipient.toLowerCase().replace(/([%_\\])/g, "\\$1")}%`;

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m."id"
    FROM "Message" m
    JOIN "MailAccount" a ON a."id" = m."mailAccountId"
    WHERE a."userId" = ${userId}
      AND m."isDraft" = false
      AND (
        lower(m."fromEmail") = ${recipient.toLowerCase()}
        OR EXISTS (
          SELECT 1
          FROM unnest(m."to" || m."cc") AS addr
          WHERE lower(addr) LIKE ${needle} ESCAPE '\\'
        )
      )
    ORDER BY m."sentAt" DESC
    LIMIT ${limit}
  `;

  return rows.map((row) => row.id);
}

/** The messages themselves, oldest first, read through the tenancy client. */
async function loadCorrespondence(
  userId: string,
  ids: readonly string[],
): Promise<{ message: MessageForPrompt; mailboxAddress: string }[]> {
  if (ids.length === 0) return [];

  const rows = await dbForUser(userId).message.findMany({
    where: { id: { in: [...ids] } },
    orderBy: { sentAt: "asc" },
    select: { ...MESSAGE_PROMPT_SELECT, mailAccount: { select: { emailAddress: true } } },
  });

  return rows.map((row) => {
    const { mailAccount, ...message } = row;
    return {
      message: message as MessageForPrompt,
      mailboxAddress: mailAccount.emailAddress,
    };
  });
}

export interface ComposeInput {
  userId: string;
  /** What the user wants to say, in their own words. */
  intent: string;
  /** Who it goes to. This — not the model — decides the recipient. */
  to: string;
  tone?: ReplyTone;
  settings?: AiSettings;
  signal?: AbortSignal;
}

/**
 * Composes one message.
 *
 * Nothing is persisted. `ReplyDraft` is scoped to a thread and a new message has
 * none, and a composed draft the user abandoned in the editor is not a feedback
 * signal about anything — the ledger already records that the call happened.
 */
export async function composeMessage(input: ComposeInput): Promise<ComposeResultDto> {
  const settings = input.settings ?? (await loadAiSettings(input.userId));
  const tone = input.tone ?? settings.defaultTone;

  const ids = await findCorrespondenceIds(input.userId, input.to, COMPOSE_CONTEXT_MESSAGES);
  const history = await loadCorrespondence(input.userId, ids);
  const style = await loadWritingStyle(input.userId);

  const blocks = history.map((entry) =>
    messageForPrompt(entry.message, entry.mailboxAddress),
  );

  const { data, model } = await callStructured({
    userId: input.userId,
    feature: "compose",
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    schema: aiComposedMessageSchema,
    /*
     * History first, our request last — the same ordering as `reply.ts`, for the same
     * reason: the final instruction the model reads should be one we wrote. When
     * there is no history the block is omitted entirely rather than sent empty, so
     * the model is not shown an empty relationship to infer from.
     */
    userContent: [
      ...(blocks.length > 0 ? [untrustedCorrespondenceBlock(blocks)] : []),
      composeRequestBlock({ intent: input.intent, recipient: input.to, tone, style }),
    ].join("\n\n"),
    settings,
    ...(input.signal ? { signal: input.signal } : {}),
    logContext: { recipientDomain: input.to.split("@").at(-1), context: blocks.length },
  });

  logger.info(
    {
      userId: input.userId,
      // The domain, not the address: a log line about composing mail does not need
      // to record who the user is writing to.
      recipientDomain: input.to.split("@").at(-1),
      tone,
      model,
      contextMessages: blocks.length,
      styleApplied: style !== null,
    },
    "message composed",
  );

  return {
    subject: data.subject,
    body: data.body,
    model,
    contextMessages: blocks.length,
    styleApplied: style !== null,
  };
}
