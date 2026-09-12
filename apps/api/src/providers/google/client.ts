import { z } from "zod";
import { env } from "../../lib/env.js";
import { InternalError } from "../../lib/errors.js";
import { getWithToken, postRevokeRequest, postTokenRequest } from "../oauthHttp.js";
import type {
  AuthorizeUrlInput,
  ExchangeCodeInput,
  MailboxIdentity,
  OAuthProviderClient,
  RevokeOutcome,
  TokenSet,
} from "../types.js";

/**
 * Google OAuth for the *mailbox* connection. Sign-in is a separate flow owned by
 * Auth.js in `apps/web` and requests no mail scopes at all.
 */

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * Minimum viable scopes (§8): `gmail.modify` + `gmail.send`, never
 * `mail.google.com`. `userinfo.email` is what tells us which mailbox was
 * actually granted — the account picker need not be the signed-in user.
 */
const GOOGLE_MAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

/** Credentials are optional at boot; a flow that needs them says so plainly. */
function credentials(): { clientId: string; clientSecret: string } {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new InternalError(
      "Google OAuth is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
    );
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  };
}

const userinfoSchema = z.object({
  email: z.string().min(3),
  name: z.string().optional(),
});

export const googleOAuthClient: OAuthProviderClient = {
  slug: "google",
  providerType: "GMAIL",
  scopes: GOOGLE_MAIL_SCOPES,

  buildAuthorizeUrl({ state, redirectUri }: AuthorizeUrlInput): string {
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: credentials().clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_MAIL_SCOPES.join(" "),
      state,
      // Without BOTH of these Google issues no refresh token: `access_type` asks
      // for one, and `prompt=consent` forces a re-issue on reconnect — a second
      // consent for an already-approved app otherwise returns none.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    }).toString();
    return url.toString();
  },

  async exchangeCode({ code, redirectUri }: ExchangeCodeInput): Promise<TokenSet> {
    const { clientId, clientSecret } = credentials();
    return postTokenRequest(
      TOKEN_ENDPOINT,
      {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      },
      "Google",
    );
  },

  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    // Google returns no new refresh token here; the stored one stays valid.
    const { clientId, clientSecret } = credentials();
    return postTokenRequest(
      TOKEN_ENDPOINT,
      {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      },
      "Google",
    );
  },

  /**
   * Revoking the refresh token revokes the entire grant — the access token and
   * every other token issued from it die with it, and the app disappears from the
   * user's Google account permissions page.
   */
  async revokeAccess(refreshToken: string): Promise<RevokeOutcome> {
    await postRevokeRequest(REVOKE_ENDPOINT, { token: refreshToken }, "Google");
    return { revoked: true };
  },

  async fetchIdentity(accessToken: string): Promise<MailboxIdentity> {
    const raw = await getWithToken(USERINFO_ENDPOINT, accessToken, "Google");
    const info = userinfoSchema.parse(raw);
    const identity: MailboxIdentity = { emailAddress: info.email.toLowerCase() };
    if (info.name !== undefined) identity.displayName = info.name;
    return identity;
  },
};
