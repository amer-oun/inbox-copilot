import { Router } from "express";
import { prisma } from "@inbox-copilot/db";
import { logger } from "../lib/logger.js";
import { decodeGmailNotification, verifyPushRequest } from "../lib/pubsub.js";
import { enqueueDelta } from "../services/deltaSync.js";

/**
 * Provider push notifications (§4).
 *
 * The second unauthenticated route in the application, and the only one strangers can
 * find by guessing, so its contract is narrow on purpose:
 *
 *   - **A trigger, not data.** The body says which mailbox changed and nothing else is
 *     believed. No column is written from it, and the history id it carries is logged
 *     and discarded — the delta reads from our own cursor, so a hostile publisher
 *     cannot make us skip mail or re-read somebody else's mailbox.
 *   - **It does no work.** It verifies, enqueues, and answers. A webhook that synced
 *     inline would hold Pub/Sub's connection open for the length of a Gmail read, and
 *     a burst would arrive as concurrent syncs of the same mailbox.
 *   - **It acknowledges almost everything.** 204 for an unknown mailbox, an
 *     unparseable payload, a mailbox we no longer sync. Pub/Sub retries anything else
 *     with backoff for days, so a 500 on a message that will never succeed is a
 *     permanent retry loop. 5xx is reserved for "we could not enqueue", which a retry
 *     genuinely fixes.
 */
export const webhooksRouter: Router = Router();

webhooksRouter.post("/webhooks/gmail", async (req, res) => {
  try {
    await verifyPushRequest(req.get("authorization"));
  } catch {
    /*
     * 401 with no detail, whatever went wrong. An unauthenticated caller learns
     * nothing about which check failed, and nothing about whether the mailbox in their
     * payload exists here. The reason is in the log (lib/pubsub.ts).
     */
    res
      .status(401)
      .json({ error: { code: "UNAUTHORIZED", message: "Push verification failed" } });
    return;
  }

  const notification = decodeGmailNotification(req.body);
  if (notification === null) {
    // Nothing to act on, and a retry would produce the same nothing.
    res.status(204).end();
    return;
  }

  /*
   * The address is a *lookup key*, never data: it selects among rows we already own,
   * and a value that matches nothing is acknowledged and dropped. This read is
   * deliberately not tenant-scoped — there is no user in a push request, and finding
   * out which user a mailbox belongs to is the whole point of the query. Everything
   * downstream goes through `dbForUser` with the id it returns.
   */
  const mailboxes = await prisma.mailAccount.findMany({
    where: {
      provider: "GMAIL",
      emailAddress: notification.emailAddress,
      // A revoked mailbox is not synced, and asking Gmail about it would fail on every
      // notification until the user reconnects.
      syncStatus: { not: "REVOKED" },
    },
    select: { id: true, userId: true },
  });

  const log = logger.child({
    // The mailbox address is not logged: it identifies a person, and the ids below are
    // enough to follow the work. `messageId` is Pub/Sub's, for correlating a burst.
    pubsubMessageId: notification.messageId,
    mailboxes: mailboxes.length,
  });

  if (mailboxes.length === 0) {
    // A notification for a mailbox nobody here has connected — a stale watch from a
    // previous deployment against the same topic, most often.
    log.debug("gmail push for an unknown mailbox; acknowledged and dropped");
    res.status(204).end();
    return;
  }

  /*
   * The same address can be connected by more than one user (a shared team mailbox),
   * and each of them gets their own delta. The claimed history id is logged here, once,
   * and never used: it is the only place it is even visible.
   */
  let queued = 0;
  for (const mailbox of mailboxes) {
    const outcome = await enqueueDelta({
      userId: mailbox.userId,
      mailAccountId: mailbox.id,
      reason: "webhook",
    });
    if (outcome.queued) queued += 1;
  }

  log.info(
    { queued, collapsed: mailboxes.length - queued, claimedHistoryId: notification.claimedHistoryId },
    "gmail push accepted",
  );

  res.status(204).end();
});

/**
 * A GET on the same path, purely so a misconfigured subscription is diagnosable.
 *
 * Pub/Sub only ever POSTs; a human hitting this in a browser is checking whether the
 * endpoint is reachable, and answering 405 with a hint beats a 404 that looks like the
 * route does not exist at all.
 */
webhooksRouter.get("/webhooks/gmail", (_req, res) => {
  res.status(405).json({
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "This endpoint accepts POST from Google Pub/Sub only",
    },
  });
});
