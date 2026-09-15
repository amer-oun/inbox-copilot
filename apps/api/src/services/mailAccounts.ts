import { dbForUser, Prisma } from "@inbox-copilot/db";
import {
  PROVIDER_SLUG_TO_TYPE,
  mailAccountSchema,
  type DisconnectMailAccountResponse,
  type MailAccountDto,
  type ProviderSlug,
} from "@inbox-copilot/shared";
import { env } from "../lib/env.js";
import { NotFoundError, ProviderAuthError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { recordMailAccountEvent } from "./mailAccountEvents.js";
import { stopWatchForMailbox } from "./watch.js";
import { createOAuthState } from "../lib/oauthState.js";
import { oauthClientFor, redirectUriFor } from "../providers/registry.js";
import { revokeMailboxGrant, tokenVaultFields } from "../providers/tokenManager.js";

/**
 * Mailbox connection lifecycle. This is a *separate* OAuth flow from sign-in:
 * signing in never asks for mail scopes, and connecting a mailbox never creates
 * a session. See `apps/web/auth.ts` for the other half.
 */

/** Columns that may leave this module. Token columns are not among them. */
const SAFE_SELECT = {
  id: true,
  provider: true,
  emailAddress: true,
  displayName: true,
  scopes: true,
  syncStatus: true,
  syncError: true,
  lastSyncedAt: true,
  createdAt: true,
} as const;

interface SafeRow {
  id: string;
  provider: "GMAIL" | "OUTLOOK";
  emailAddress: string;
  displayName: string | null;
  scopes: string[];
  syncStatus: string;
  syncError: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
}

function toDto(row: SafeRow): MailAccountDto {
  // Parsed rather than cast: the schema is the guarantee that no token-shaped
  // field can be added to the response by accident.
  return mailAccountSchema.parse({
    id: row.id,
    provider: row.provider,
    emailAddress: row.emailAddress,
    displayName: row.displayName,
    scopes: row.scopes,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    needsReconnect: row.syncStatus === "REVOKED",
  });
}

export async function listMailAccounts(userId: string): Promise<MailAccountDto[]> {
  const rows = (await dbForUser(userId).mailAccount.findMany({
    select: SAFE_SELECT,
    orderBy: { createdAt: "asc" },
  })) as SafeRow[];
  return rows.map(toDto);
}

/**
 * Step 1 of the connect flow: mint a signed, single-use state and build the
 * provider consent URL. No DB row exists yet — we do not know which mailbox the
 * user will pick.
 */
export async function startMailAccountConnect(input: {
  userId: string;
  provider: ProviderSlug;
}): Promise<{ authorizeUrl: string }> {
  const client = oauthClientFor(input.provider);
  const state = await createOAuthState({
    userId: input.userId,
    provider: input.provider,
  });

  return {
    authorizeUrl: client.buildAuthorizeUrl({
      state,
      redirectUri: redirectUriFor(input.provider, env.API_PUBLIC_URL),
    }),
  };
}

/**
 * Step 2: exchange the code, identify the mailbox, and store the encrypted
 * tokens with `syncStatus = PENDING` — phase 2 picks it up from there.
 */
export async function completeMailAccountConnect(input: {
  userId: string;
  provider: ProviderSlug;
  code: string;
  /** For the audit trail, so a connect can be traced to its request. */
  requestId?: string | null;
}): Promise<MailAccountDto> {
  const { userId, provider, code } = input;
  const requestId = input.requestId ?? null;
  const client = oauthClientFor(provider);

  const tokens = await client.exchangeCode({
    code,
    redirectUri: redirectUriFor(provider, env.API_PUBLIC_URL),
  });

  if (!tokens.refreshToken) {
    // Without a refresh token the mailbox dies within the hour, so the
    // connection is refused rather than stored half-working. On Google this
    // means the consent screen was skipped (see `prompt=consent`).
    throw new ProviderAuthError(
      "Provider issued no refresh token; offline access was not granted",
      { provider },
    );
  }

  const identity = await client.fetchIdentity(tokens.accessToken);

  const db = dbForUser(userId);
  const providerType = PROVIDER_SLUG_TO_TYPE[provider];
  const scopes = tokens.scopes.length > 0 ? tokens.scopes : [...client.scopes];

  const vault = tokenVaultFields(tokens);
  const writable = {
    displayName: identity.displayName ?? null,
    scopes,
    syncStatus: "PENDING" as const,
    syncError: null,
    ...vault,
  };

  // Reconnecting an already-connected mailbox must reuse its row, or the
  // threads already synced against it would be orphaned.
  const existing = await db.mailAccount.findFirst({
    where: { provider: providerType, emailAddress: identity.emailAddress },
    select: { id: true },
  });

  const log = logger.child({ userId });

  if (existing) {
    /*
     * The audit row goes in with the update, in one transaction. A record written
     * afterwards is a record that is missing precisely when something failed in
     * between — which is the case it exists for (services/mailAccountEvents.ts).
     */
    const row = (await db.$transaction(async (tx) => {
      const updated = await tx.mailAccount.update({
        where: { id: existing.id },
        data: writable,
        select: SAFE_SELECT,
      });
      await recordMailAccountEvent(tx, {
        kind: "RECONNECTED",
        userId,
        mailAccountId: existing.id,
        provider: providerType,
        emailAddress: identity.emailAddress,
        requestId,
      });
      return updated;
    })) as SafeRow;

    log.info(
      { mailAccountId: row.id, provider: providerType, requestId, audit: "mail-account-event" },
      "reconnected existing mailbox",
    );
    return toDto(row);
  }

  try {
    /*
     * A new mailbox, so its id does not exist until the create returns — which is why
     * this is an interactive transaction rather than a batch: the audit row needs the
     * id the create produced, and both must still land together or not at all.
     */
    const row = (await db.$transaction(async (tx) => {
      const created = await tx.mailAccount.create({
        data: {
          // The tenancy extension stamps `userId` too; passing it keeps the create
          // input well-typed instead of casting the whole object.
          userId,
          provider: providerType,
          emailAddress: identity.emailAddress,
          ...writable,
        },
        select: SAFE_SELECT,
      });
      await recordMailAccountEvent(tx, {
        kind: "CONNECTED",
        userId,
        mailAccountId: created.id,
        provider: providerType,
        emailAddress: identity.emailAddress,
        requestId,
      });
      return created;
    })) as SafeRow;

    log.info(
      { mailAccountId: row.id, provider: providerType, requestId, audit: "mail-account-event" },
      "connected new mailbox",
    );
    return toDto(row);
  } catch (error) {
    // Two consent screens completed at once: the loser updates instead.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const row = (await db.$transaction(async (tx) => {
        const updated = await tx.mailAccount.update({
          where: {
            provider_emailAddress_userId: {
              provider: providerType,
              emailAddress: identity.emailAddress,
              userId,
            },
          },
          data: writable,
          select: SAFE_SELECT,
        });
        // RECONNECTED rather than CONNECTED: the row the winner created is the one
        // being written to, and the trail should say so.
        await recordMailAccountEvent(tx, {
          kind: "RECONNECTED",
          userId,
          mailAccountId: updated.id,
          provider: providerType,
          emailAddress: identity.emailAddress,
          requestId,
        });
        return updated;
      })) as SafeRow;
      return toDto(row);
    }
    throw error;
  }
}

/**
 * Forgets a mailbox, ciphertexts and all — and revokes the grant at the provider
 * first, so "disconnected" means disconnected rather than "we stopped looking".
 * Cascades to the mailbox's threads and messages.
 */
export async function disconnectMailAccount(input: {
  userId: string;
  mailAccountId: string;
  /** For the audit trail, so a disappearing mailbox can be traced to its request. */
  requestId?: string | null;
}): Promise<DisconnectMailAccountResponse> {
  const db = dbForUser(input.userId);
  const existing = await db.mailAccount.findFirst({
    where: { id: input.mailAccountId },
    // The watch fields ride along: stopping push needs them, and this is the last
    // moment the row exists.
    select: {
      id: true,
      provider: true,
      emailAddress: true,
      watchExpiresAt: true,
    },
  });
  if (!existing) {
    throw new NotFoundError("Mailbox not found");
  }

  /*
   * Stop push first, while the row and its tokens still exist: `users.stop` needs an
   * access token, and after the delete there is nothing left to authenticate with. A
   * failure here is logged, not thrown (services/watch.ts) — an unstoppable watch
   * expires within a week, and its notifications already resolve to no mailbox.
   */
  await stopWatchForMailbox(input.userId, existing);

  // Revocation is best effort and deliberately not transactional: if it fails we
  // still delete, and the response says the grant may still be live so the user
  // can remove it themselves. Doing it the other way round would leave a live
  // grant with no row to find it by.
  const outcome = await revokeMailboxGrant(input.mailAccountId, input.userId);

  /*
   * The audit row and the delete, in one transaction, the row first.
   *
   * This is the whole reason the table exists: a mailbox that disappears must leave
   * something behind that says when, for whom, and from which request. Because
   * `MailAccountEvent` has no foreign key to `MailAccount`, the cascade that takes the
   * threads and messages does not take this row with them.
   *
   * If the insert fails the delete rolls back, and the mailbox stays connected. That is
   * deliberate: a disconnect the system cannot account for is worse than a disconnect
   * the user has to click twice.
   */
  await db.$transaction(async (tx) => {
    await recordMailAccountEvent(tx, {
      kind: "DISCONNECTED",
      userId: input.userId,
      mailAccountId: existing.id,
      provider: existing.provider,
      emailAddress: existing.emailAddress,
      requestId: input.requestId ?? null,
      grantRevoked: outcome.revoked,
    });
    await tx.mailAccount.delete({ where: { id: existing.id } });
  });

  logger
    .child({ userId: input.userId, mailAccountId: input.mailAccountId })
    .info(
      {
        revoked: outcome.revoked,
        requestId: input.requestId ?? null,
        audit: "mail-account-event",
      },
      "disconnected mailbox",
    );

  return outcome.manageUrl === undefined
    ? { revoked: outcome.revoked }
    : { revoked: outcome.revoked, manageUrl: outcome.manageUrl };
}
