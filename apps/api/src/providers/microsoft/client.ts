import { z } from "zod";
import { env } from "../../lib/env.js";
import { InternalError } from "../../lib/errors.js";
import { getWithToken, postTokenRequest } from "../oauthHttp.js";
import type {
  AuthorizeUrlInput,
  ExchangeCodeInput,
  MailboxIdentity,
  OAuthProviderClient,
  RevokeOutcome,
  TokenSet,
} from "../types.js";

/**
 * Microsoft identity platform (v2.0) OAuth for the mailbox connection.
 *
 * Two things differ from Google and both matter:
 *   1. a refresh token exists only if `offline_access` was requested;
 *   2. every refresh ROTATES the refresh token — the old one dies immediately.
 *      Concurrent refreshes therefore invalidate each other, which is why
 *      tokenManager holds a Redis mutex across the whole read-refresh-write.
 */

const AUTHORIZE_ENDPOINT = (tenant: string): string =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
const TOKEN_ENDPOINT = (tenant: string): string =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me";

/**
 * Where a user removes our grant by hand. Work/school accounts manage consent at
 * myapplications.microsoft.com; personal Microsoft accounts at
 * account.live.com/consent/Manage. The former covers the common case and is safe
 * to show either way.
 */
const CONSENT_MANAGE_URL = "https://myapplications.microsoft.com/";

/**
 * Minimum viable scopes (§8). `User.Read` is what lets us read the mailbox
 * address; `offline_access` is what makes a refresh token exist at all.
 */
const MICROSOFT_MAIL_SCOPES = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
] as const;

/** Credentials are optional at boot; a flow that needs them says so plainly. */
function credentials(): { clientId: string; clientSecret: string } {
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) {
    throw new InternalError(
      "Microsoft OAuth is not configured: set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET",
    );
  }
  return {
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
  };
}

const meSchema = z.object({
  mail: z.string().min(3).nullish(),
  userPrincipalName: z.string().min(3).nullish(),
  displayName: z.string().nullish(),
});

export const microsoftOAuthClient: OAuthProviderClient = {
  slug: "microsoft",
  providerType: "OUTLOOK",
  scopes: MICROSOFT_MAIL_SCOPES,

  buildAuthorizeUrl({ state, redirectUri }: AuthorizeUrlInput): string {
    const url = new URL(AUTHORIZE_ENDPOINT(env.MICROSOFT_TENANT_ID));
    url.search = new URLSearchParams({
      client_id: credentials().clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: MICROSOFT_MAIL_SCOPES.join(" "),
      state,
      // Force the picker so a second mailbox can be connected even when a work
      // account is already signed in in this browser.
      prompt: "select_account",
    }).toString();
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }: ExchangeCodeInput): Promise<TokenSet> {
    const { clientId, clientSecret } = credentials();
    return postTokenRequest(
      TOKEN_ENDPOINT(env.MICROSOFT_TENANT_ID),
      {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: MICROSOFT_MAIL_SCOPES.join(" "),
      },
      "Microsoft",
    );
  },

  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    // The response carries a NEW refresh token; persisting it is mandatory.
    const { clientId, clientSecret } = credentials();
    return postTokenRequest(
      TOKEN_ENDPOINT(env.MICROSOFT_TENANT_ID),
      {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: MICROSOFT_MAIL_SCOPES.join(" "),
      },
      "Microsoft",
    );
  },

  /**
   * Entra ID has no app-initiated revocation we can reach.
   *
   * There is no RFC 7009 revoke endpoint on the v2.0 token API, and deleting the
   * `oAuth2PermissionGrant` through Graph needs `DelegatedPermissionGrant.
   * ReadWrite.All` — a tenant-admin scope we deliberately do not request for an
   * email client. So we drop our copy of the tokens (they are useless without our
   * client secret) and tell the user where to remove the grant itself.
   */
  async revokeAccess(): Promise<RevokeOutcome> {
    return { revoked: false, manageUrl: CONSENT_MANAGE_URL };
  },

  async fetchIdentity(accessToken: string): Promise<MailboxIdentity> {
    const raw = await getWithToken(ME_ENDPOINT, accessToken, "Microsoft");
    const me = meSchema.parse(raw);
    // Personal accounts have no `mail`; `userPrincipalName` is the fallback.
    const address = me.mail ?? me.userPrincipalName;
    if (!address) {
      throw new Error("Microsoft account exposes no mail address");
    }
    const identity: MailboxIdentity = { emailAddress: address.toLowerCase() };
    if (me.displayName) identity.displayName = me.displayName;
    return identity;
  },
};
