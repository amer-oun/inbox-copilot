import { dbForUser } from "@inbox-copilot/db";
import {
  DEMO_SAMPLE_MODEL,
  type ReplyDraftsResponseDto,
  type ReplyTone,
  type TranslationDto,
} from "@inbox-copilot/shared";
import { AiCapExceededError, DemoLimitError, NotFoundError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { connectRedis, redis } from "../../lib/redis.js";
import type { AuthenticatedUser } from "../../middleware/auth.js";
import { generateReplies } from "../ai/reply.js";
import { normalizeLang, translateMessage } from "../ai/translate.js";
import { DEMO_THREADS, type DemoThread } from "./fixtures.js";
import { threadIdFor } from "./seed.js";

/**
 * The demo's two model-calling buttons: "Draft 3 replies" and "Translate".
 *
 * Browsing the demo makes no model calls at all — every summary, verdict and
 * classification is in the seed. These two buttons are the only way a visitor can ask
 * for one, and they are answered in this order:
 *
 *   1. **Pre-written results.** Drafts for the threads a visitor is likely to try, in
 *      the default tone, and English translations of the two foreign-language
 *      messages. Served with no model call, and labelled `DEMO_SAMPLE_MODEL` so the UI
 *      says they were written in advance.
 *   2. **A rationed live call** for anything else — another tone, another language, a
 *      thread without drafts. Rationed three ways, because the demo runs on the
 *      owner's free Gemini quota and a public button is a button anyone can script:
 *        - per visitor: `PER_SESSION_PER_HOUR`, so one visitor cannot use it all;
 *        - per hour across every visitor: `ALL_SESSIONS_PER_HOUR`;
 *        - per day: `DEMO_DAILY_AI_CALL_CAP`, enforced by the ordinary cap check on
 *          the ledger (`services/ai/client.ts`), which a restore never clears.
 *
 * Redis unavailable means no live calls: the allowance fails closed. The pre-written
 * results still work, which is most of what a visitor will click.
 */

export const PER_SESSION_PER_HOUR = 6;
export const ALL_SESSIONS_PER_HOUR = 30;

const HOUR_MS = 60 * 60 * 1000;

const LIMITED_MESSAGE =
  "The demo's live AI allowance is used up for now. Drafts on the highlighted threads and the English translations still work without it.";

const THREAD_BY_ID: ReadonlyMap<string, DemoThread> = new Map(
  DEMO_THREADS.map((thread) => [threadIdFor(thread.n), thread]),
);

/**
 * Spends one live call from the visitor's and the demo's hourly allowance, or refuses.
 *
 * Counted with INCR on hour-bucketed keys, so the window is fixed rather than sliding —
 * simpler, and at these numbers the edge case (a burst either side of the hour) costs
 * at most one extra hour's allowance.
 */
export async function takeDemoAiAllowance(
  user: AuthenticatedUser,
  now: Date = new Date(),
): Promise<void> {
  const bucket = Math.floor(now.getTime() / HOUR_MS);
  const sessionKey = `demo:ai:session:${user.demoSessionId ?? "none"}:${bucket}`;
  const allKey = `demo:ai:all:${bucket}`;

  let session: number;
  let all: number;
  try {
    await connectRedis();
    const results = await redis
      .multi()
      .incr(sessionKey)
      .expire(sessionKey, 2 * 60 * 60)
      .incr(allKey)
      .expire(allKey, 2 * 60 * 60)
      .exec();
    session = Number(results?.[0]?.[1]);
    all = Number(results?.[2]?.[1]);
  } catch (error) {
    logger.warn(
      { err: error, userId: user.id },
      "demo AI allowance unavailable; refusing",
    );
    throw new DemoLimitError(LIMITED_MESSAGE);
  }

  if (!Number.isFinite(session) || !Number.isFinite(all)) {
    throw new DemoLimitError(LIMITED_MESSAGE);
  }
  if (session > PER_SESSION_PER_HOUR || all > ALL_SESSIONS_PER_HOUR) {
    logger.info({ userId: user.id, session, all }, "demo AI allowance refused");
    throw new DemoLimitError(LIMITED_MESSAGE);
  }
}

/** The ordinary cap error, reworded so it does not read like a quota on the visitor. */
async function liveCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AiCapExceededError) throw new DemoLimitError(LIMITED_MESSAGE);
    throw error;
  }
}

/** `POST /threads/:id/replies` for a demo session. */
export async function demoReplies(input: {
  user: AuthenticatedUser;
  threadId: string;
  tone?: ReplyTone;
}): Promise<ReplyDraftsResponseDto> {
  const { user, threadId } = input;
  const db = dbForUser(user.id);
  const tone = input.tone ?? "PROFESSIONAL";

  // The tenancy read is the ownership check, as on the live path.
  const thread = await db.thread.findFirst({
    where: { id: threadId },
    select: { id: true },
  });
  if (!thread) throw new NotFoundError("Thread not found");

  const written = THREAD_BY_ID.get(threadId)?.drafts?.[tone];
  if (written !== undefined) {
    const drafts = [];
    for (const draft of written) {
      // Stored like live drafts, so the composer's `draftId` feedback path is the same.
      const row = await db.replyDraft.create({
        data: { threadId, tone, body: draft.body, model: DEMO_SAMPLE_MODEL },
        select: { id: true, createdAt: true },
      });
      drafts.push({
        id: row.id,
        tone,
        label: draft.label,
        body: draft.body,
        model: DEMO_SAMPLE_MODEL,
        createdAt: row.createdAt.toISOString(),
      });
    }
    return { threadId, tone, drafts, styleApplied: true };
  }

  await takeDemoAiAllowance(user);
  return liveCall(() => generateReplies({ userId: user.id, threadId, tone }));
}

/** `POST /messages/:id/translate` for a demo session. */
export async function demoTranslate(input: {
  user: AuthenticatedUser;
  messageId: string;
  targetLang: string;
}): Promise<TranslationDto> {
  const { user, messageId } = input;
  const targetLang = normalizeLang(input.targetLang);
  const db = dbForUser(user.id);

  const message = await db.message.findFirst({
    where: { id: messageId },
    select: { contentHash: true },
  });
  if (!message) throw new NotFoundError("Message not found");

  const cached = await db.translation.findFirst({
    where: { messageId, targetLang },
    select: { contentHash: true },
  });

  // A fresh cached translation costs nothing, so it needs no allowance — this is what
  // serves the pre-written English and anything a previous visitor already paid for.
  if (cached === null || cached.contentHash !== message.contentHash) {
    await takeDemoAiAllowance(user);
  }
  return liveCall(() => translateMessage({ userId: user.id, messageId, targetLang }));
}
