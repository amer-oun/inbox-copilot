import type { MailProviderType, ProviderSlug } from "@inbox-copilot/shared";
import { createGmailProvider } from "./gmail/client.js";
import { googleOAuthClient } from "./google/client.js";
import { microsoftOAuthClient } from "./microsoft/client.js";
import type { MailProvider, MailProviderContext } from "./mailProvider.js";
import type { OAuthProviderClient } from "./types.js";
import { InternalError } from "../lib/errors.js";

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

/**
 * The single lookup point for mail providers (rule 5). Outlook arrives in phase 8
 * behind this same port; until then asking for one is a programming error, not a
 * user-facing condition.
 */
export function mailProviderFor(
  providerType: MailProviderType,
  context: MailProviderContext,
): MailProvider {
  switch (providerType) {
    case "GMAIL":
      return createGmailProvider(context);
    case "OUTLOOK":
      throw new InternalError("Outlook sync is not implemented until phase 8");
  }
}
