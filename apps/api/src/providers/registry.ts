import type { ProviderSlug } from "@inbox-copilot/shared";
import { googleOAuthClient } from "./google/client.js";
import { microsoftOAuthClient } from "./microsoft/client.js";
import type { OAuthProviderClient } from "./types.js";

const CLIENTS: Readonly<Record<ProviderSlug, OAuthProviderClient>> = {
  google: googleOAuthClient,
  microsoft: microsoftOAuthClient,
};

/** The single lookup point for provider OAuth clients (rule 5). */
export function oauthClientFor(slug: ProviderSlug): OAuthProviderClient {
  return CLIENTS[slug];
}

/**
 * Callback URL handed to the provider. It must match the value registered in the
 * provider console byte-for-byte, and is sent again at code-exchange time.
 */
export function redirectUriFor(slug: ProviderSlug, apiPublicUrl: string): string {
  return new URL(`/oauth/${slug}/callback`, apiPublicUrl).toString();
}
