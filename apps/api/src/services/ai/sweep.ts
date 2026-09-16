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
 * Enrichment is three calls, though, and the cap can fall between them: a message whose
 * classification succeeded and whose thread summary was refused looks complete to a
 * query about classifications. So the sweep looks for all three gaps — messages with no
 * classification, threads over the summary threshold with no summary, and messages that
 * were classified but never assessed for phishing — or a capped run would leave threads
 * permanently unsummarized and mail permanently unassessed. A message queued for any of
 * the later reasons costs no classification call: that is a cache hit.
 *
 * The third gap is not hypothetical, it is the normal state of an existing install:
 * every message classified before this phase has a row whose `threatLevel` is the
 * UNKNOWN that `classify.ts` honestly wrote. Those rows exist, so the "no
 * classification" query steps straight past them, and without this finder a mailbox
 * would only ever be assessed from the day it next received mail.
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

/**
 * Messages that have a classification but no threat verdict, newest first.
 *
 * `threatLevel: "UNKNOWN"` is the marker, and it is a deliberate one: `classify.ts`
 * writes it rather than SAFE precisely so that "not assessed" stays distinguishable
 * from "assessed and found clean" — which is what makes this query possible at all.
 *
 * Outbound mail is excluded, because the threat layer skips it: including it here would
 * hand the sweep a supply of work it can never finish.
 */
export async function findUnassessedMessages(input: {
  userId: string;
  mailAccountId?: string;
  limit?: number;
}): Promise<UnenrichedMessage[]> {
  const rows = await dbForUser(input.userId).message.findMany({
    where: {
      ...(input.mailAccountId === undefined ? {} : { mailAccountId: input.mailAccountId }),
      isOutbound: false,
      classification: { is: { threatLevel: "UNKNOWN" } },
    },
    orderBy: { sentAt: "desc" },
    take: input.limit ?? SWEEP_USER_LIMIT,
    select: { id: true, mailAccountId: true },
  });

  return rows as UnenrichedMessage[];
}

/**
 * One message per thread that a recompute should re-summarize.
 *
 * Returned alongside the message list so the caller can mark exactly one job per thread
 * with `resummarize`. Without it, forcing a five-message thread would pay for five
 * identical thread summaries — the summary is a property of the thread, and one job can
 * do it for all of them.
 *
 * The *newest* message of each thread is the one nominated, matching what the normal
 * summary finder does: it is also the message whose classification the thread's
 * denormalized columns reflect, so one job does both halves of the thread's work.
 */
export interface RecomputeWork {
  messages: UnenrichedMessage[];
  resummarizeIds: Set<string>;
}

/**
 * Every message, newest first — whether or not it already has AI rows.
 *
 * This is the finder behind `pnpm ai:sweep --force`, and it is deliberately the opposite
 * of the other three: they all exist to find *gaps*, and this one exists because there is
 * no gap. Switching provider is the case that motivated it — a mailbox whose every row
 * was written by a stubbed or previous model has nothing missing, so the ordinary sweep
 * correctly reports zero, and the only way to re-assess it is to ask for the work by name.
 *
 * Outbound mail is included. Classification runs on it (that is how the user's own sent
 * mail gets a language and a category); only the threat stage skips it, and it skips it
 * itself.
 */
export async function findMessagesToRecompute(input: {
  userId: string;
  mailAccountId?: string;
  limit?: number;
}): Promise<RecomputeWork> {
  const rows = await dbForUser(input.userId).message.findMany({
    where: {
      ...(input.mailAccountId === undefined ? {} : { mailAccountId: input.mailAccountId }),
    },
    orderBy: { sentAt: "desc" },
    take: input.limit ?? SWEEP_USER_LIMIT,
    select: { id: true, mailAccountId: true, threadId: true },
  });

  /*
   * Newest first, so the first message seen for a thread is its newest — the same rule
   * `findThreadsMissingSummaries` applies with `DISTINCT ON ... ORDER BY sentAt DESC`.
   */
  const resummarizeIds = new Set<string>();
  const seenThreads = new Set<string>();
  for (const row of rows) {
    if (seenThreads.has(row.threadId)) continue;
    seenThreads.add(row.threadId);
    resummarizeIds.add(row.id);
  }

  return {
    messages: rows.map((row) => ({ id: row.id, mailAccountId: row.mailAccountId })),
    resummarizeIds,
  };
}

/**
 * Groups messages by mailbox.
 *
 * Because the enrich job carries a `mailAccountId`, and a user with two connected
 * mailboxes must not have one's messages queued under the other's id — the tenancy read
 * in `runEnrich` filters on both, so a mismatched pair silently finds nothing.
 */
function groupByMailbox(
  messages: readonly UnenrichedMessage[],
): Map<string, string[]> {
  const byMailbox = new Map<string, string[]>();
  for (const message of messages) {
    const existing = byMailbox.get(message.mailAccountId);
    if (existing) existing.push(message.id);
    else byMailbox.set(message.mailAccountId, [message.id]);
  }
  return byMailbox;
}

export interface SweepResult {
  userId: string;
  found: number;
  queued: number;
  /** Set when the sweep stopped early: "cap" | "disabled". */
  skipped?: string;
  /** Calls the user has left in the current window, at sweep time. */
  budget?: number;
  /** True when this sweep queued recomputes rather than filling gaps. */
  recomputed?: boolean;
  /** Recompute only: messages that exist beyond the ones this run could take. */
  remaining?: number;
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
  /**
   * Ignore the remaining daily budget and queue up to `limit` anyway.
   *
   * Named for what it does rather than "force": this file now has a second, unrelated
   * override (`recompute`), and a single `force` covering both would make
   * "re-assess my mailbox" silently mean "and ignore the spend limit too".
   */
  ignoreCap?: boolean;
  /**
   * Re-run messages that **already have** classifications, verdicts and summaries,
   * replacing them (`pnpm ai:sweep --force`).
   *
   * This inverts what the sweep looks for. The three ordinary finders look for gaps; this
   * one takes every message, because the case it exists for — a provider switch — leaves
   * no gap to find.
   */
  recompute?: boolean;
}): Promise<SweepResult> {
  const log = logger.child({ userId: input.userId });
  const settings = await loadAiSettings(input.userId);

  if (!settings.aiEnabled) {
    return { userId: input.userId, found: 0, queued: 0, skipped: "disabled" };
  }

  const cap = await checkDailyCap(input.userId, settings);
  const budget = Math.max(0, settings.dailyAiCallCap - cap.used);

  if (!input.ignoreCap && budget === 0) {
    log.info({ used: cap.used, cap: cap.cap }, "sweep skipped: no budget left today");
    return { userId: input.userId, found: 0, queued: 0, skipped: "cap", budget };
  }

  const limit = Math.min(
    input.limit ?? SWEEP_USER_LIMIT,
    input.ignoreCap ? Number.MAX_SAFE_INTEGER : budget,
  );

  /*
   * The recompute path returns early: it does not run the three gap finders at all.
   *
   * Mixing them would be wrong rather than merely wasteful — "every message" is a
   * superset of "messages with no classification", so the gap finders would contribute
   * nothing but duplicates, and the budget arithmetic that shares `limit` between three
   * finders has no meaning when one of them wants everything.
   */
  if (input.recompute) {
    const work = await findMessagesToRecompute({
      userId: input.userId,
      ...(input.mailAccountId === undefined ? {} : { mailAccountId: input.mailAccountId }),
      limit,
    });

    if (work.messages.length === 0) {
      return { userId: input.userId, found: 0, queued: 0, budget, recomputed: true };
    }

    // How much is left over, so the caller can say "run it again" rather than leaving the
    // user to wonder why only part of the mailbox changed.
    const total = await dbForUser(input.userId).message.count({
      where: {
        ...(input.mailAccountId === undefined ? {} : { mailAccountId: input.mailAccountId }),
      },
    });

    let queued = 0;
    for (const [mailAccountId, messageIds] of groupByMailbox(work.messages)) {
      queued += await enqueueEnrichment({
        userId: input.userId,
        mailAccountId,
        messageIds,
        ignoreCache: true,
        resummarizeIds: work.resummarizeIds,
      });
    }

    log.info(
      {
        found: work.messages.length,
        queued,
        threads: work.resummarizeIds.size,
        budget,
        total,
      },
      "queued messages for recomputation",
    );

    return {
      userId: input.userId,
      found: work.messages.length,
      queued,
      budget,
      recomputed: true,
      remaining: Math.max(0, total - work.messages.length),
    };
  }

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
  const summaryWork = missingSummaries.filter((message) => !seen.has(message.id));
  for (const message of summaryWork) seen.add(message.id);

  /*
   * Unassessed messages come last, and only with what is left. Not because they matter
   * least — a forged invoice nobody flagged matters a great deal — but because this
   * gap is the largest by far on an existing install (every message that predates the
   * phase), and letting it consume the whole budget would starve the other two for
   * days. It drains over successive sweeps instead.
   */
  const afterSummaries = Math.max(0, remaining - summaryWork.length);
  const unassessed =
    afterSummaries === 0
      ? []
      : (
          await findUnassessedMessages({
            userId: input.userId,
            ...(input.mailAccountId === undefined ? {} : { mailAccountId: input.mailAccountId }),
            limit: afterSummaries,
          })
        ).filter((message) => !seen.has(message.id));

  const messages = [...unclassified, ...summaryWork, ...unassessed];

  if (messages.length === 0) {
    return { userId: input.userId, found: 0, queued: 0, budget };
  }

  const byMailbox = groupByMailbox(messages);

  let queued = 0;
  for (const [mailAccountId, messageIds] of byMailbox) {
    queued += await enqueueEnrichment({ userId: input.userId, mailAccountId, messageIds });
  }

  log.info(
    {
      found: messages.length,
      unclassified: unclassified.length,
      missingSummaries: summaryWork.length,
      unassessed: unassessed.length,
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
