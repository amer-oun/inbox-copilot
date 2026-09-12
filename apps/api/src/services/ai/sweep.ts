import { dbForUser, prisma } from "@inbox-copilot/db";
import { logger } from "../../lib/logger.js";
import { enqueueEnrichment } from "./enrich.js";
import { SUMMARY_MIN_BODY_CHARS, SUMMARY_MIN_MESSAGES } from "./content.js";
import { checkDailyCap, loadAiSettings } from "./usage.js";

/**
 * The sweep that closes the cap loop.
 *
 * When the daily cap is reached, `runEnrich` completes with `skipped: ["cap"]` and
 * the message keeps no classification. Without something to find those messages
 * again they would stay unclassified forever — the cap would silently become a
 * permanent hole in the index rather than a delay.
 *
 * "Skipped by the cap" needs no flag to record it: a message with no
 * `AiClassification` row is exactly a message that has not been classified, whatever
 * the reason — capped, AI switched off at the time, a worker killed mid-job, a queue
 * lost to a Redis flush, or a backfill that predates this phase. One query covers
 * every one of those, which is why there is no `capSkippedAt` column.
 *
 * The sweep is also the tool for enriching a mailbox that synced before the AI layer
 * existed: `pnpm ai:sweep` on a freshly backfilled account classifies all of it.
 *
 * Enrichment is two calls, though, and the cap can fall between them: a message whose
 * classification succeeded and whose thread summary was refused looks complete to a
 * query about classifications. So the sweep looks for both halves — messages with no
 * classification, and threads over the summary threshold with no summary — or a capped
 * run would leave threads permanently unsummarized. A message queued for the second
 * reason costs no classification call: that is a cache hit.
 */

/** Per-user ceiling for one sweep, so a big mailbox cannot flood the queue. */
export const SWEEP_USER_LIMIT = 200;

export interface UnenrichedMessage {
  id: string;
  mailAccountId: string;
}

/**
 * Messages with no classification, newest first.
 *
 * Newest first because these are what the user is most likely to look at, and a
 * sweep that is cut short by a cap should spend its budget on recent mail.
 */
export async function findUnenrichedMessages(input: {
  userId: string;
  mailAccountId?: string;
  limit?: number;
}): Promise<UnenrichedMessage[]> {
  const rows = await dbForUser(input.userId).message.findMany({
    where: {
      ...(input.mailAccountId === undefined ? {} : { mailAccountId: input.mailAccountId }),
      // The relation filter is the whole point: no row means never classified.
      classification: { is: null },
    },
    orderBy: { sentAt: "desc" },
    take: input.limit ?? SWEEP_USER_LIMIT,
    select: { id: true, mailAccountId: true },
  });

  return rows as UnenrichedMessage[];
}

/**
 * Newest message of each thread that should have a summary and does not.
 *
 * Raw SQL, for one reason: a thread qualifies for a summary at three messages **or** a
 * body over 1500 characters, and the second half is a string-length predicate Prisma
 * cannot express. Skipping it is not an option — a real mailbox is mostly
 * single-message threads (this one is 60 of 61), so a `messageCount >= 3` filter alone
 * finds almost none of the threads a capped run left unsummarized.
 *
 * Tenancy: this bypasses the Prisma extension, so the ownership predicate is written
 * out — `MailAccount."userId" = $1`, joined from the thread. Rule 4 still holds; it is
 * enforced by this query rather than for it, which is why the join is here and not
 * hidden behind a helper. The threshold constants are the same ones `content.ts` uses,
 * so the two cannot drift apart.
 *
 * The thread's newest message is the one returned: `runEnrich` summarizes a whole
 * thread from whichever message it is handed, and the newest is also the one whose
 * classification the thread's denormalized fields should reflect. Its classification is
 * already cached, so the job costs a summary call and nothing else.
 */
export async function findThreadsMissingSummaries(input: {
  userId: string;
  mailAccountId?: string;
  limit?: number;
}): Promise<UnenrichedMessage[]> {
  const mailAccountId = input.mailAccountId ?? null;
  const limit = input.limit ?? SWEEP_USER_LIMIT;

  return prisma.$queryRaw<UnenrichedMessage[]>`
    SELECT x."id", x."mailAccountId"
    FROM (
      SELECT DISTINCT ON (t."id")
             m."id", m."mailAccountId", t."lastMessageAt"
      FROM "Thread" t
      JOIN "MailAccount" a ON a."id" = t."mailAccountId"
      JOIN "Message" m ON m."threadId" = t."id"
      WHERE a."userId" = ${input.userId}
        AND (${mailAccountId}::text IS NULL OR t."mailAccountId" = ${mailAccountId})
        AND NOT EXISTS (SELECT 1 FROM "AiSummary" s WHERE s."threadId" = t."id")
        AND (
          t."messageCount" >= ${SUMMARY_MIN_MESSAGES}
          OR EXISTS (
            SELECT 1 FROM "Message" lm
            WHERE lm."threadId" = t."id"
              AND length(COALESCE(lm."bodyText", lm."snippet", '')) > ${SUMMARY_MIN_BODY_CHARS}
          )
        )
      ORDER BY t."id", m."sentAt" DESC
    ) x
    ORDER BY x."lastMessageAt" DESC
    LIMIT ${limit}
  `;
}

export interface SweepResult {
  userId: string;
  found: number;
  queued: number;
  /** Set when the sweep stopped early: "cap" | "disabled". */
  skipped?: string;
  /** Calls the user has left in the current window, at sweep time. */
  budget?: number;
}

/**
 * Sweeps one user.
 *
 * The batch is trimmed to the *remaining* daily budget. Queueing five thousand jobs
 * that will each discover the cap is not a fix: it turns a spend limit into a
 * thousand pointless DB reads and log lines, and it buries the messages that could
 * have been done. Enrichment costs one call per message plus one per thread worth
 * summarizing, so the budget is an upper bound rather than an exact reservation —
 * the cap check inside every call is what actually holds the line.
 */
export async function sweepUserEnrichment(input: {
  userId: string;
  mailAccountId?: string;
  limit?: number;
  /** Ignore the remaining budget and queue up to `limit` anyway. */
  force?: boolean;
}): Promise<SweepResult> {
  const log = logger.child({ userId: input.userId });
  const settings = await loadAiSettings(input.userId);

  if (!settings.aiEnabled) {
    return { userId: input.userId, found: 0, queued: 0, skipped: "disabled" };
  }

  const cap = await checkDailyCap(input.userId, settings);
  const budget = Math.max(0, settings.dailyAiCallCap - cap.used);

  if (!input.force && budget === 0) {
    log.info({ used: cap.used, cap: cap.cap }, "sweep skipped: no budget left today");
    return { userId: input.userId, found: 0, queued: 0, skipped: "cap", budget };
  }

  const limit = Math.min(
    input.limit ?? SWEEP_USER_LIMIT,
    input.force ? Number.MAX_SAFE_INTEGER : budget,
  );

  const unclassified = await findUnenrichedMessages({
    userId: input.userId,
    ...(input.mailAccountId === undefined ? {} : { mailAccountId: input.mailAccountId }),
    limit,
  });

  /*
   * Unclassified messages first: they are the expensive, more visible gap. Threads
   * missing a summary fill whatever budget is left, and are deduplicated against the
   * first list — a thread whose newest message is already being enqueued needs no
   * second job, because that one job does both halves.
   */
  const remaining = Math.max(0, limit - unclassified.length);
  const missingSummaries =
    remaining === 0
      ? []
      : await findThreadsMissingSummaries({
          userId: input.userId,
          ...(input.mailAccountId === undefined ? {} : { mailAccountId: input.mailAccountId }),
          limit: remaining,
        });

  const seen = new Set(unclassified.map((message) => message.id));
  const messages = [
    ...unclassified,
    ...missingSummaries.filter((message) => !seen.has(message.id)),
  ];

  if (messages.length === 0) {
    return { userId: input.userId, found: 0, queued: 0, budget };
  }

  /*
   * Grouped by mailbox because the enrich job carries a mailAccountId, and a user
   * with two connected mailboxes must not have one's messages queued under the
   * other's id — the tenancy read in `runEnrich` filters on both.
   */
  const byMailbox = new Map<string, string[]>();
  for (const message of messages) {
    const existing = byMailbox.get(message.mailAccountId);
    if (existing) existing.push(message.id);
    else byMailbox.set(message.mailAccountId, [message.id]);
  }

  let queued = 0;
  for (const [mailAccountId, messageIds] of byMailbox) {
    queued += await enqueueEnrichment({ userId: input.userId, mailAccountId, messageIds });
  }

  log.info(
    {
      found: messages.length,
      unclassified: unclassified.length,
      missingSummaries: messages.length - unclassified.length,
      queued,
      budget,
      mailboxes: byMailbox.size,
    },
    "queued unenriched messages",
  );
  return { userId: input.userId, found: messages.length, queued, budget };
}

/**
 * Sweeps every user with a connected mailbox.
 *
 * This is the one place that reads outside a tenant scope, and it does so
 * deliberately and narrowly: the scheduled sweep has no user to act as, so it asks
 * the base client for mailbox *owners only* — two id columns, no mail — and then
 * does all real work through `dbForUser` per owner. Rule 4 is about mail never
 * crossing tenants; enumerating who exists is a different question, and doing it
 * here keeps it to one auditable query.
 */
export async function sweepAllEnrichment(
  input: { perUserLimit?: number | undefined } = {},
): Promise<SweepResult[]> {
  const owners = await prisma.mailAccount.findMany({
    where: { syncStatus: { in: ["ACTIVE", "BACKFILLING"] } },
    select: { userId: true },
    distinct: ["userId"],
  });

  const results: SweepResult[] = [];
  for (const owner of owners) {
    try {
      results.push(
        await sweepUserEnrichment({
          userId: owner.userId,
          ...(input.perUserLimit === undefined ? {} : { limit: input.perUserLimit }),
        }),
      );
    } catch (error) {
      // One user's failure must not stop the others: this runs on a schedule, and a
      // sweep that aborts halfway leaves an arbitrary subset done.
      logger.error({ err: error, userId: owner.userId }, "sweep failed for user");
    }
  }

  const totals = results.reduce(
    (sum, result) => ({ found: sum.found + result.found, queued: sum.queued + result.queued }),
    { found: 0, queued: 0 },
  );
  logger.info({ users: owners.length, ...totals }, "enrichment sweep complete");

  return results;
}
