import type { MailProviderType, ProviderSlug } from "@inbox-copilot/shared";

/** A freshly issued token set, as returned by a provider's token endpoint. */
export interface TokenSet {
  accessToken: string;
  /**
   * Absent when the provider did not re-issue one. Google omits it on refresh
   * (the original stays valid); Microsoft rotates it on every refresh, which is
   * why refreshes are serialized — see providers/tokenManager.ts.
   */
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
}

/** Who the tokens belong to. Enough to name the mailbox, nothing more. */
export interface MailboxIdentity {
  emailAddress: string;
  displayName?: string;
}

/**
 * Result of asking a provider to tear down the OAuth grant.
 *
 * Not every provider lets an app revoke its own delegated grant, so "we could not
 * do it for you" is a first-class outcome rather than an error: the user must be
 * told where to finish the job.
 */
export interface RevokeOutcome {
  revoked: boolean;
  /** Where the user can remove the grant themselves, when we cannot. */
  manageUrl?: string;
}

export interface AuthorizeUrlInput {
  state: string;
  redirectUri: string;
}

export interface ExchangeCodeInput {
  code: string;
  redirectUri: string;
}

/**
 * The OAuth half of a mail provider. Kept separate from the `MailProvider`
 * port (phase 2) because token plumbing has no business knowing about messages.
 *
 * Everything that touches a provider HTTP endpoint lives behind this interface
 * (rule 5) — no provider SDK is imported outside `providers/`.
 */
export interface OAuthProviderClient {
  readonly slug: ProviderSlug;
  readonly providerType: MailProviderType;
  /** Mailbox scopes requested at connect time. Never used for sign-in. */
  readonly scopes: readonly string[];

  buildAuthorizeUrl(input: AuthorizeUrlInput): string;
  exchangeCode(input: ExchangeCodeInput): Promise<TokenSet>;
  refreshAccessToken(refreshToken: string): Promise<TokenSet>;
  fetchIdentity(accessToken: string): Promise<MailboxIdentity>;
  /**
   * Tears down the grant at the provider. Must be idempotent: a token that is
   * already dead counts as revoked, because the user's goal is "no live grant".
   */
  revokeAccess(refreshToken: string): Promise<RevokeOutcome>;
}
