import { dbForUser, prisma } from "@inbox-copilot/db";
import { env } from "../lib/env.js";
import { NotFoundError, PushNotConfiguredError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { mailProviderFor } from "../providers/registry.js";
import { enqueueDelta } from "./deltaSync.js";

/**
 * Push subscriptions and their upkeep (§4).
 *
 * A Gmail watch lasts at most seven days, and a mailbox whose watch has quietly
 * expired is the worst failure this application can have: it looks like an inbox where
 * nobody has written, which is indistinguishable from a working one. So the keeper
 * does two things on every run — renew what is close to expiring, and *catch up*
 * anything whose push is not currently live.
 */

/**
 * Renew this far ahead of expiry.
 *
 * Two days inside a seven-day window, so a renewal has to fail for two consecutive
 * days before push lapses — and the run is hourly, which makes that 48 chances.
 */
export const WATCH_RENEW_BEFORE_MS = 2 * 24 * 60 * 60_000;

/**
 * A mailbox not synced in this long gets a delta even if its watch looks healthy.
 *
 * The defense against the failure that leaves no trace: a watch that Google considers
 * live but whose notifications are not arriving (a deleted subscription, a topic
 * permission revoked, our endpoint 500ing for an hour). Nothing in our own data says
 * that is happening; the only symptom is silence, so silence is what this checks.
 */
export const STALE_SYNC_MS = 60 * 60_000;

interface WatchRow {
  id: string;
  userId: string;
  provider: "GMAIL" | "OUTLOOK";
  emailAddress: string;
  syncStatus: string;
  syncCursor: string | null;
  watchExpiresAt: Date | null;
  lastSyncedAt: Date | null;
}

const WATCH_SELECT = {
  id: true,
  userId: true,
  provider: true,
  emailAddress: true,
  syncStatus: true,
  syncCursor: true,
  watchExpiresAt: true,
  lastSyncedAt: true,
} as const;

/** Whether push is configured at all for this deployment. */
export function pushConfigured(): boolean {
  return env.GMAIL_PUBSUB_TOPIC !== "";
}

export interface EnsureWatchResult {
  mailAccountId: string;
  started: boolean;
  expiresAt: Date | null;
  /** Set when nothing was done: "not-configured" | "fresh" | "not-gmail" | "inactive". */
  skipped?: string;
}

/**
 * Starts (or renews) the watch for one mailbox.
 *
 * Idempotent by way of Gmail's own semantics: `users.watch` replaces any existing
 * watch for the mailbox, so "renew" and "start" are the same call. The `fresh` skip is
 * ours, to avoid spending 100 quota units an hour per mailbox to re-assert something
 * that has six days left.
 */
export async function ensureWatch(input: {
  userId: string;
  mailAccountId: string;
  force?: boolean;
}): Promise<EnsureWatchResult> {
  const row = (await dbForUser(input.userId).mailAccount.findFirst({
    where: { id: input.mailAccountId },
    select: WATCH_SELECT,
  })) as WatchRow | null;

  if (!row) throw new NotFoundError("Mailbox not found");
  return ensureWatchForMailbox(row, input.force === true);
}

/**
 * The same, for a caller that already has the row — which the keeper does, having just
 * listed every mailbox. Re-reading each one would be a second query per mailbox per
 * hour to learn what the list already said.
 */
export async function ensureWatchForMailbox(
  row: WatchRow,
  force = false,
): Promise<EnsureWatchResult> {
  const db = dbForUser(row.userId);
  const log = logger.child({ userId: row.userId, mailAccountId: row.id });

  if (!pushConfigured()) {
    throw new PushNotConfiguredError(
      "GMAIL_PUBSUB_TOPIC is not set; real-time sync is unavailable",
    );
  }
  if (row.provider !== "GMAIL") {
    return {
      mailAccountId: row.id,
      started: false,
      expiresAt: null,
      skipped: "not-gmail",
    };
  }
  if (row.syncStatus === "REVOKED") {
    // Watching a mailbox we can no longer read would fail on every renewal and log an
    // error an hour, for a grant only the user can restore.
    return {
      mailAccountId: row.id,
      started: false,
      expiresAt: null,
      skipped: "inactive",
    };
  }

  if (
    !force &&
    row.watchExpiresAt !== null &&
    row.watchExpiresAt.getTime() - Date.now() > WATCH_RENEW_BEFORE_MS
  ) {
    return {
      mailAccountId: row.id,
      started: false,
      expiresAt: row.watchExpiresAt,
      skipped: "fresh",
    };
  }

  const provider = mailProviderFor(row.provider, {
    mailAccountId: row.id,
    userId: row.userId,
    emailAddress: row.emailAddress,
  });

  const watch = await provider.startWatch();

  /*
   * `watchResourceId` holds the topic. Gmail issues no per-watch handle — one mailbox
   * has one watch, and `stop` takes no argument — so the topic is the only fact worth
   * storing: it says where notifications will arrive, and a deployment that changes
   * topics can tell which mailboxes are still pointed at the old one.
   *
   * The cursor Gmail returns is deliberately *not* written over `syncCursor`. It is
   * "now", and our cursor is "the last point we have actually read": overwriting would
   * skip everything in between — exactly the silent gap this phase exists to avoid.
   */
  await db.mailAccount.update({
    where: { id: row.id },
    data: {
      watchResourceId: env.GMAIL_PUBSUB_TOPIC,
      watchExpiresAt: watch.expiresAt,
      ...(row.syncStatus === "ERROR" ? { syncStatus: "ACTIVE" as const } : {}),
    },
  });

  log.info(
    { expiresAt: watch.expiresAt.toISOString(), providerCursor: watch.cursor },
    "gmail watch ensured",
  );

  return { mailAccountId: row.id, started: true, expiresAt: watch.expiresAt };
}

/** The fields `stopWatchForMailbox` needs. A caller that already has the row passes it. */
export interface StoppableMailbox {
  id: string;
  provider: "GMAIL" | "OUTLOOK";
  emailAddress: string;
  watchExpiresAt: Date | null;
}

/**
 * Stops the watch and clears its columns, for a mailbox the caller has already loaded.
 *
 * Takes the row rather than an id because of *when* it is called: disconnect stops push
 * while the row and its encrypted tokens still exist, because `users.stop` needs an
 * access token and after the delete there is nothing left to authenticate with. Asking
 * for the row again there would be a second query for something the caller is holding.
 *
 * A failure at the provider is logged rather than thrown: the user asked to disconnect,
 * and a watch we could not stop expires within a week — while refusing to disconnect
 * over it would leave them stuck with a mailbox they no longer want connected. Its
 * notifications resolve to no mailbox in the meantime, which the webhook drops.
 */
export async function stopWatchForMailbox(
  userId: string,
  mailbox: StoppableMailbox,
): Promise<{ stopped: boolean }> {
  const log = logger.child({ userId, mailAccountId: mailbox.id });
  let stopped = false;

  if (mailbox.provider === "GMAIL" && mailbox.watchExpiresAt !== null) {
    try {
      await mailProviderFor(mailbox.provider, {
        mailAccountId: mailbox.id,
        userId,
        emailAddress: mailbox.emailAddress,
      }).stopWatch();
      stopped = true;
    } catch (error) {
      log.warn(
        { err: error },
        "could not stop the gmail watch; it will expire on its own",
      );
    }
  }

  await dbForUser(userId).mailAccount.update({
    where: { id: mailbox.id },
    data: { watchResourceId: null, watchExpiresAt: null },
  });

  return { stopped };
}

/** The same, for a caller that has only an id. */
export async function stopWatch(input: {
  userId: string;
  mailAccountId: string;
}): Promise<{ stopped: boolean }> {
  const row = (await dbForUser(input.userId).mailAccount.findFirst({
    where: { id: input.mailAccountId },
    select: WATCH_SELECT,
  })) as WatchRow | null;

  if (!row) throw new NotFoundError("Mailbox not found");
  return stopWatchForMailbox(input.userId, row);
}

export interface WatchKeeperResult {
  checked: number;
  renewed: number;
  failed: number;
  /** Mailboxes given a catch-up delta because their push is not live or has gone quiet. */
  caughtUp: number;
  skipped: number;
}

/**
 * The repeatable keeper: renew what is expiring, catch up what has gone quiet.
 *
 * One non-tenant read to find the mailboxes, then everything per mailbox goes through
 * `dbForUser` — the same shape as the AI sweep, and for the same reason: "which
 * mailboxes exist" is not a user-scoped question, and everything after it is.
 */
export async function runWatchKeeper(
  input: { force?: boolean } = {},
): Promise<WatchKeeperResult> {
  const result: WatchKeeperResult = {
    checked: 0,
    renewed: 0,
    failed: 0,
    caughtUp: 0,
    skipped: 0,
  };

  if (!pushConfigured()) {
    logger.debug("watch keeper: no Pub/Sub topic configured, nothing to renew");
    return result;
  }

  const mailboxes = (await prisma.mailAccount.findMany({
    where: {
      provider: "GMAIL",
      // PENDING and BACKFILLING are included: a mailbox connected an hour ago should
      // come out of its backfill with push already live.
      syncStatus: { in: ["PENDING", "BACKFILLING", "ACTIVE", "ERROR"] },
    },
    select: WATCH_SELECT,
  })) as WatchRow[];

  const now = Date.now();

  for (const row of mailboxes) {
    result.checked += 1;
    const log = logger.child({ userId: row.userId, mailAccountId: row.id });

    /*
     * Was push live *before* this run? Read first, because renewing is what makes it
     * live again — and a mailbox whose watch had lapsed has missed notifications that
     * only a delta will recover.
     */
    const watchWasLive =
      row.watchExpiresAt !== null && row.watchExpiresAt.getTime() > now;

    try {
      const outcome = await ensureWatchForMailbox(row, input.force === true);

      if (outcome.started) result.renewed += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      // Logged and moved past: one mailbox with a revoked grant must not stop the
      // keeper from renewing everybody else's.
      log.error({ err: error }, "could not renew the gmail watch");
    }

    /*
     * A catch-up delta when push was not live, or when it was live but nothing has
     * arrived for an hour. The second case is the one with no other symptom: a
     * subscription deleted in the console leaves a perfectly valid-looking
     * `watchExpiresAt` and total silence.
     *
     * It is a queued delta rather than a sync here: the delta job already knows how to
     * hold the cursor, fall back to a backfill on an expired one, and collapse with a
     * notification that arrives in the meantime.
     */
    const quiet =
      row.lastSyncedAt === null || now - row.lastSyncedAt.getTime() > STALE_SYNC_MS;

    if (row.syncCursor !== null && (!watchWasLive || quiet)) {
      const queued = await enqueueDelta({
        userId: row.userId,
        mailAccountId: row.id,
        reason: watchWasLive ? "sweep" : "watch-renewed",
      });
      if (queued.queued) {
        result.caughtUp += 1;
        log.info(
          { watchWasLive, quiet, lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null },
          "queued a catch-up delta",
        );
      }
    }
  }

  if (result.renewed > 0 || result.caughtUp > 0 || result.failed > 0) {
    logger.info({ ...result }, "watch keeper run complete");
  }
  return result;
}
