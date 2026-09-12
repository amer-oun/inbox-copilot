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
}): Promise<MailAccountDto> {
  const { userId, provider, code } = input;
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
    const row = (await db.mailAccount.update({
      where: { id: existing.id },
      data: writable,
      select: SAFE_SELECT,
    })) as SafeRow;
    log.info(
      { mailAccountId: row.id, provider: providerType },
      "reconnected existing mailbox",
    );
    return toDto(row);
  }

  try {
    const row = (await db.mailAccount.create({
      data: {
        // The tenancy extension stamps `userId` too; passing it keeps the create
        // input well-typed instead of casting the whole object.
        userId,
        provider: providerType,
        emailAddress: identity.emailAddress,
        ...writable,
      },
      select: SAFE_SELECT,
    })) as SafeRow;
    log.info(
      { mailAccountId: row.id, provider: providerType },
      "connected new mailbox",
    );
    return toDto(row);
  } catch (error) {
    // Two consent screens completed at once: the loser updates instead.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const row = (await db.mailAccount.update({
        where: {
          provider_emailAddress_userId: {
            provider: providerType,
            emailAddress: identity.emailAddress,
            userId,
          },
        },
        data: writable,
        select: SAFE_SELECT,
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
}): Promise<DisconnectMailAccountResponse> {
  const db = dbForUser(input.userId);
  const existing = await db.mailAccount.findFirst({
    where: { id: input.mailAccountId },
    select: { id: true },
  });
  if (!existing) {
    throw new NotFoundError("Mailbox not found");
  }

  // Revocation is best effort and deliberately not transactional: if it fails we
  // still delete, and the response says the grant may still be live so the user
  // can remove it themselves. Doing it the other way round would leave a live
  // grant with no row to find it by.
  const outcome = await revokeMailboxGrant(input.mailAccountId, input.userId);

  await db.mailAccount.delete({ where: { id: existing.id } });
  logger
    .child({ userId: input.userId, mailAccountId: input.mailAccountId })
    .info({ revoked: outcome.revoked }, "disconnected mailbox");

  return outcome.manageUrl === undefined
    ? { revoked: outcome.revoked }
    : { revoked: outcome.revoked, manageUrl: outcome.manageUrl };
}
