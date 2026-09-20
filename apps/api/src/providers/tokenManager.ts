import { dbForUser } from "@inbox-copilot/db";
import {
  InvalidGrantError,
  MailAccountRevokedError,
  NotFoundError,
} from "../lib/errors.js";
import { currentKeyVersion, decrypt, encrypt } from "../lib/crypto.js";
import { withMutex } from "../lib/mutex.js";
import { logger } from "../lib/logger.js";
import { oauthClientFor } from "./registry.js";
import type { ProviderSlug } from "@inbox-copilot/shared";
import type { RevokeOutcome, TokenSet } from "./types.js";

/**
 * The only place a mailbox access token is produced.
 *
 * Nothing outside this module reads the token vault columns, and no caller ever
 * sees a refresh token. Every log line here carries `userId` + `mailAccountId`
 * and never a token value (rule 3).
 */

/** Refresh this far ahead of expiry so an in-flight call cannot expire mid-request. */
const REFRESH_SKEW_MS = 5 * 60 * 1_000;

/** Long enough for a token endpoint round trip (10s) plus the DB write. */
const MUTEX_TTL_MS = 20_000;
const MUTEX_WAIT_MS = 15_000;

const SLUG_FOR_PROVIDER = {
  GMAIL: "google",
  OUTLOOK: "microsoft",
} as const satisfies Record<"GMAIL" | "OUTLOOK", ProviderSlug>;

/** Every column the vault needs. Selected explicitly — never `select: *`. */
const VAULT_SELECT = {
  id: true,
  userId: true,
  provider: true,
  emailAddress: true,
  syncStatus: true,
  keyVersion: true,
  accessTokenEnc: true,
  accessTokenIv: true,
  accessTokenAuthTag: true,
  refreshTokenEnc: true,
  refreshTokenIv: true,
  refreshTokenAuthTag: true,
  tokenExpiresAt: true,
} as const;

interface VaultRow {
  id: string;
  userId: string;
  provider: "GMAIL" | "OUTLOOK";
  emailAddress: string;
  syncStatus: string;
  keyVersion: number;
  accessTokenEnc: string | null;
  accessTokenIv: string | null;
  accessTokenAuthTag: string | null;
  refreshTokenEnc: string | null;
  refreshTokenIv: string | null;
  refreshTokenAuthTag: string | null;
  tokenExpiresAt: Date | null;
}

/**
 * The vault columns for a token set. Deliberately its own interface rather than
 * a Prisma input type: those make every field optional-and-widened, which would
 * silently swallow a typo in a spread at the call site.
 */
export interface TokenVaultFields {
  accessTokenEnc: string;
  accessTokenIv: string;
  accessTokenAuthTag: string;
  refreshTokenEnc?: string;
  refreshTokenIv?: string;
  refreshTokenAuthTag?: string;
  keyVersion: number;
  tokenExpiresAt: Date;
  tokenRefreshedAt: Date;
}

/**
 * Encrypts a token set into its storage columns.
 *
 * `refreshToken` is optional in a provider response: Google omits it on refresh,
 * so the previously stored ciphertext must be left untouched rather than nulled.
 */
export function tokenVaultFields(tokens: TokenSet): TokenVaultFields {
  const access = encrypt(tokens.accessToken);

  const fields: TokenVaultFields = {
    accessTokenEnc: access.ciphertext,
    accessTokenIv: access.iv,
    accessTokenAuthTag: access.authTag,
    keyVersion: access.keyVersion,
    tokenExpiresAt: tokens.expiresAt,
    tokenRefreshedAt: new Date(),
  };

  if (tokens.refreshToken !== undefined) {
    const refresh = encrypt(tokens.refreshToken);
    fields.refreshTokenEnc = refresh.ciphertext;
    fields.refreshTokenIv = refresh.iv;
    fields.refreshTokenAuthTag = refresh.authTag;
  }

  return fields;
}

function isFresh(row: VaultRow): boolean {
  return (
    row.accessTokenEnc !== null &&
    row.accessTokenIv !== null &&
    row.accessTokenAuthTag !== null &&
    row.tokenExpiresAt !== null &&
    row.tokenExpiresAt.getTime() - REFRESH_SKEW_MS > Date.now()
  );
}

function decryptAccessToken(row: VaultRow): string {
  if (!row.accessTokenEnc || !row.accessTokenIv || !row.accessTokenAuthTag) {
    throw new MailAccountRevokedError("Mailbox has no stored access token", {
      mailAccountId: row.id,
      needsReconnect: true,
    });
  }
  return decrypt({
    ciphertext: row.accessTokenEnc,
    iv: row.accessTokenIv,
    authTag: row.accessTokenAuthTag,
    keyVersion: row.keyVersion,
  });
}

function decryptRefreshToken(row: VaultRow): string {
  if (!row.refreshTokenEnc || !row.refreshTokenIv || !row.refreshTokenAuthTag) {
    // Google without `access_type=offline` + `prompt=consent` lands here.
    throw new MailAccountRevokedError(
      "Mailbox has no refresh token; reconnect it to grant offline access",
      { mailAccountId: row.id, needsReconnect: true },
    );
  }
  return decrypt({
    ciphertext: row.refreshTokenEnc,
    iv: row.refreshTokenIv,
    authTag: row.refreshTokenAuthTag,
    keyVersion: row.keyVersion,
  });
}

/**
 * Returns a usable access token for a connected mailbox, refreshing it first if
 * it expires within five minutes.
 *
 * `userId` is required because rule 4 admits no unscoped query — and because
 * every log line in this path needs it anyway. Callers (routes, sync jobs) always
 * have it.
 */
export async function getAccessToken(
  mailAccountId: string,
  userId: string,
): Promise<string> {
  const db = dbForUser(userId);
  const log = logger.child({ userId, mailAccountId });

  // findFirst, not findUnique: the tenancy extension narrows `where` with
  // `userId`, which findUnique does not accept.
  const row = (await db.mailAccount.findFirst({
    where: { id: mailAccountId },
    select: VAULT_SELECT,
  })) as VaultRow | null;

  if (!row) {
    throw new NotFoundError("Mailbox not found");
  }
  if (row.syncStatus === "REVOKED") {
    // Already known-dead. Do not spend a round trip finding out again.
    throw new MailAccountRevokedError("Mailbox access was revoked; reconnect it", {
      mailAccountId,
      needsReconnect: true,
    });
  }
  if (isFresh(row) && row.keyVersion === currentKeyVersion) {
    return decryptAccessToken(row);
  }

  // Microsoft rotates the refresh token on every use, so two concurrent
  // refreshes for one mailbox invalidate each other and leave it unusable. The
  // mutex makes read-refresh-write atomic across processes.
  return withMutex(
    `token-refresh:${mailAccountId}`,
    async () => {
      // Re-read inside the lock: whoever held it before us may have just done
      // the work, and reusing their result avoids a pointless rotation.
      const current = (await db.mailAccount.findFirst({
        where: { id: mailAccountId },
        select: VAULT_SELECT,
      })) as VaultRow | null;

      if (!current) throw new NotFoundError("Mailbox not found");
      if (current.syncStatus === "REVOKED") {
        throw new MailAccountRevokedError("Mailbox access was revoked; reconnect it", {
          mailAccountId,
          needsReconnect: true,
        });
      }
      if (isFresh(current) && current.keyVersion === currentKeyVersion) {
        log.debug("access token refreshed by a concurrent request");
        return decryptAccessToken(current);
      }

      const client = oauthClientFor(SLUG_FOR_PROVIDER[current.provider]);
      const refreshToken = decryptRefreshToken(current);

      let tokens: TokenSet;
      try {
        tokens = await client.refreshAccessToken(refreshToken);
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          await markRevoked(userId, mailAccountId, error.message);
          log.warn({ provider: current.provider }, "mailbox revoked by provider");
          throw new MailAccountRevokedError(
            "Mailbox access was revoked by the provider; reconnect it",
            { mailAccountId, needsReconnect: true },
          );
        }
        throw error;
      }

      await db.mailAccount.update({
        where: { id: mailAccountId },
        data: {
          ...tokenVaultFields(tokens),
          // A refresh that works clears a previous transient failure.
          ...(current.syncStatus === "ERROR"
            ? { syncStatus: "PENDING", syncError: null }
            : {}),
          ...(tokens.scopes.length > 0 ? { scopes: tokens.scopes } : {}),
        },
      });

      log.info(
        { provider: current.provider, expiresAt: tokens.expiresAt.toISOString() },
        "refreshed mailbox access token",
      );
      return tokens.accessToken;
    },
    { ttlMs: MUTEX_TTL_MS, waitMs: MUTEX_WAIT_MS },
  );
}

/**
 * Marks a mailbox as needing reconnection and drops the dead ciphertexts —
 * keeping a token we know is rejected buys nothing and widens the blast radius.
 */
async function markRevoked(
  userId: string,
  mailAccountId: string,
  reason: string,
): Promise<void> {
  await dbForUser(userId).mailAccount.update({
    where: { id: mailAccountId },
    data: {
      syncStatus: "REVOKED",
      syncError: reason.slice(0, 500),
      accessTokenEnc: null,
      accessTokenIv: null,
      accessTokenAuthTag: null,
      refreshTokenEnc: null,
      refreshTokenIv: null,
      refreshTokenAuthTag: null,
      tokenExpiresAt: null,
    },
  });
}

/**
 * Asks the provider to tear down the grant for a mailbox we are about to forget.
 *
 * Deleting our row is not the same as revoking: without this, a user who presses
 * "Disconnect" is told the mailbox is gone while a live OAuth grant stays on the
 * provider's side. So this runs first — but it never blocks the disconnect, because
 * the user asked for the mailbox to go and a provider outage must not veto that.
 *
 * Lives here rather than in the service because it decrypts.
 */
export async function revokeMailboxGrant(
  mailAccountId: string,
  userId: string,
): Promise<RevokeOutcome> {
  const log = logger.child({ userId, mailAccountId });

  const row = (await dbForUser(userId).mailAccount.findFirst({
    where: { id: mailAccountId },
    select: VAULT_SELECT,
  })) as VaultRow | null;

  if (!row) {
    throw new NotFoundError("Mailbox not found");
  }

  // Nothing to revoke: the tokens were already dropped (a REVOKED mailbox) or
  // never stored. The grant is gone from our side either way.
  if (!row.refreshTokenEnc || !row.refreshTokenIv || !row.refreshTokenAuthTag) {
    log.info("no refresh token to revoke; skipping provider revocation");
    return { revoked: true };
  }

  const client = oauthClientFor(SLUG_FOR_PROVIDER[row.provider]);

  try {
    const outcome = await client.revokeAccess(decryptRefreshToken(row));
    log.info(
      { provider: row.provider, revoked: outcome.revoked },
      outcome.revoked
        ? "revoked mailbox grant at the provider"
        : "provider does not support app-initiated revocation",
    );
    return outcome;
  } catch (error) {
    // Best effort: report the failure rather than keeping the mailbox connected.
    log.warn(
      { provider: row.provider, err: error },
      "provider revocation failed; disconnecting anyway",
    );
    return { revoked: false };
  }
}
