import { dbForUser, type Prisma } from "@inbox-copilot/db";
import { aiSummarySchema, type AiSummaryOutput } from "@inbox-copilot/shared";
import { callStructured } from "./client.js";
import { cachedSummary, threadContentHash } from "./cache.js";
import { needsSummary, threadForPrompt, type MessageForPrompt } from "./content.js";
import { untrustedThreadBlock } from "./prompts.js";
import type { AiSettings } from "./usage.js";

/**
 * Thread summarization (§5). Sonnet, because the output is read by a person.
 *
 * Only runs for threads worth summarizing — three or more messages, or a body over
 * 1500 characters. A two-line exchange does not need a headline and a key-points
 * list; generating one would cost money to tell the user what they can already see.
 */

const TOOL_NAME = "record_summary";
const TOOL_DESCRIPTION =
  "Record the summary of the thread in the untrusted_email blocks. This is the only way to respond.";

export interface SummarizeInput {
  userId: string;
  threadId: string;
  mailboxAddress: string;
  /** Oldest first. */
  messages: readonly MessageForPrompt[];
  settings?: AiSettings;
  signal?: AbortSignal;
  /** Skips the §5 threshold — for a user explicitly asking for a summary. */
  force?: boolean;
}

export interface SummarizeResult {
  summary: AiSummaryOutput | null;
  fromCache: boolean;
  /** Set when nothing was done: "below-threshold". */
  skipped?: string;
  model?: string;
}

/**
 * Summarizes a thread, or returns the cached summary, or declines.
 *
 * The cache key is the hash of the ordered message hashes: a thread whose messages
 * have not changed is never re-summarized, and one that gained a reply always is.
 */
export async function summarizeThread(input: SummarizeInput): Promise<SummarizeResult> {
  if (input.messages.length === 0) {
    return { summary: null, fromCache: false, skipped: "empty-thread" };
  }

  if (input.force !== true && !needsSummary(input.messages)) {
    return { summary: null, fromCache: false, skipped: "below-threshold" };
  }

  const contentHash = threadContentHash(input.messages.map((message) => message.contentHash));

  const cached = await cachedSummary(input.userId, input.threadId, contentHash);
  if (cached) {
    return {
      summary: {
        headline: cached.headline,
        summary: cached.summary,
        keyPoints: cached.keyPoints as string[],
        actionItems: cached.actionItems as AiSummaryOutput["actionItems"],
      },
      fromCache: true,
      model: cached.model,
    };
  }

  const { data, model } = await callStructured({
    userId: input.userId,
    feature: "summarize",
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    schema: aiSummarySchema,
    userContent: untrustedThreadBlock(threadForPrompt(input.messages, input.mailboxAddress)),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    logContext: { threadId: input.threadId, messages: input.messages.length },
  });

  const fields = {
    model,
    headline: data.headline,
    summary: data.summary,
    keyPoints: data.keyPoints as unknown as Prisma.InputJsonValue,
    actionItems: data.actionItems as unknown as Prisma.InputJsonValue,
  };

  /*
   * Upsert on `(threadId, contentHash)`: the unique key is the pair, so a thread
   * accumulates one row per distinct state rather than overwriting its history. Two
   * workers racing the same thread therefore collide on the key instead of writing
   * two rows for one state.
   */
  await dbForUser(input.userId).aiSummary.upsert({
    where: { threadId_contentHash: { threadId: input.threadId, contentHash } },
    create: { threadId: input.threadId, contentHash, ...fields },
    update: fields,
  });

  return { summary: data, fromCache: false, model };
}
