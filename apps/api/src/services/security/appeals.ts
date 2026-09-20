import { dbForUser, type Prisma } from "@inbox-copilot/db";
import {
  threatLevelSchema,
  type ThreatAppealDto,
  type ThreatLevel,
} from "@inbox-copilot/shared";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

/**
 * "This is safe" — the appeal path §6 asks for.
 *
 * Two things this deliberately does **not** do.
 *
 * It does not change the verdict. The rules found what they found and the model read
 * what it read; rewriting `threatLevel` because somebody clicked a button would destroy
 * the only record of a false positive, and a false-positive rate we cannot measure is a
 * detector we cannot improve. The appeal is stored beside the verdict, and the UI reads
 * it to stand the banner down — so the user gets what they asked for while the evidence
 * survives.
 *
 * It does not feed anything back into the model. A note saying "this is safe, I know
 * this sender" is a user's opinion, and an attacker who can get a user to click "safe"
 * once must not thereby be able to influence how their next message is assessed. The
 * appeal is read by the UI and by whoever reviews the rule weights. Nothing else.
 */

/** What the user was looking at, recorded with their disagreement. */
interface AppealTarget {
  level: ThreatLevel;
  score: number;
  reasons: string[];
}

function asReasons(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Records that a user considers a flagged message safe.
 *
 * The message is loaded through the tenancy client first, which is both the 404 for
 * somebody else's message and the ownership check for the write — `ThreatAppeal` is
 * tenant-scoped on `userId`, so the row cannot be created for another user, but it
 * *could* otherwise be created pointing at another user's message.
 */
export async function recordThreatAppeal(input: {
  userId: string;
  messageId: string;
  note?: string;
}): Promise<{ messageId: string; appeal: ThreatAppealDto }> {
  const db = dbForUser(input.userId);

  const message = await db.message.findFirst({
    where: { id: input.messageId },
    select: {
      id: true,
      threadId: true,
      classification: {
        select: { threatLevel: true, threatScore: true, threatReasons: true },
      },
    },
  });

  if (message === null) throw new NotFoundError("Message not found");

  const raw = message.classification;
  const level = threatLevelSchema.safeParse(raw?.threatLevel ?? "UNKNOWN");
  const target: AppealTarget = {
    level: level.success ? level.data : "UNKNOWN",
    score: raw?.threatScore ?? 0,
    reasons: asReasons(raw?.threatReasons),
  };

  /*
   * Nothing to appeal is a 400, not a silent success. An appeal against a verdict that
   * was never made would sit in the table as a false positive that never happened, and
   * this endpoint's whole value is that its rows mean something.
   */
  if (target.level === "UNKNOWN" || target.level === "SAFE") {
    throw new BadRequestError(
      "This message is not flagged, so there is nothing to appeal",
    );
  }

  const data = {
    claimedLevel: target.level,
    claimedScore: target.score,
    shownReasons: target.reasons as unknown as Prisma.InputJsonValue,
    note: input.note === undefined || input.note === "" ? null : input.note,
  };

  /*
   * Read-then-write rather than an upsert: `ThreatAppeal` is unique on `messageId`
   * while its tenancy key is `userId`, and the extension stamps `userId` into an
   * upsert's `where` — which is not a valid unique input for this model. `updateMany`
   * takes a filter, so both branches stay inside the tenant scope.
   */
  const existing = await db.threatAppeal.findFirst({
    where: { messageId: input.messageId },
    select: { id: true },
  });

  const row =
    existing === null
      ? await db.threatAppeal.create({
          // `userId` is written explicitly as well as stamped by the extension: the
          // generated create input requires it, and the redundancy is the convention
          // the ledger already follows (`services/ai/usage.ts`).
          data: { userId: input.userId, messageId: input.messageId, ...data },
          select: { createdAt: true, note: true, claimedLevel: true, claimedScore: true },
        })
      : await (async () => {
          await db.threatAppeal.updateMany({
            where: { messageId: input.messageId },
            data,
          });
          const updated = await db.threatAppeal.findFirst({
            where: { messageId: input.messageId },
            select: {
              createdAt: true,
              note: true,
              claimedLevel: true,
              claimedScore: true,
            },
          });
          if (updated === null) throw new NotFoundError("Appeal not found");
          return updated;
        })();

  logger.info(
    {
      userId: input.userId,
      messageId: input.messageId,
      threadId: message.threadId,
      claimedLevel: target.level,
      claimedScore: target.score,
      reasons: target.reasons.length,
      hadNote: data.note !== null,
      // Deliberately logged: a rise in this rate is the signal that a rule weight is
      // wrong, and it is the only place that number is observable.
      appeal: "threat-false-positive",
    },
    "user marked a flagged message as safe",
  );

  return {
    messageId: input.messageId,
    appeal: {
      createdAt: row.createdAt.toISOString(),
      note: row.note,
      claimedLevel: threatLevelSchema.parse(row.claimedLevel),
      claimedScore: row.claimedScore,
    },
  };
}
