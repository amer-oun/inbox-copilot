import { z } from "zod";
import { InvalidGrantError, ProviderAuthError } from "../lib/errors.js";

/**
 * Shared plumbing for OAuth 2.0 token endpoints. Provider-specific detail stays
 * in `google/client.ts` and `microsoft/client.ts`.
 *
 * Nothing here logs: a token response body is a live credential.
 */

const REQUEST_TIMEOUT_MS = 10_000;

/** RFC 6749 §5.1. `refresh_token` is absent on a Google refresh. */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export interface RawTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
}

/** Default lifetime when the provider omits `expires_in`. Deliberately short. */
const FALLBACK_EXPIRES_IN_SECONDS = 300;

export async function postTokenRequest(
  tokenEndpoint: string,
  body: Record<string, string>,
  providerLabel: string,
): Promise<RawTokenResponse> {
  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderAuthError(`${providerLabel} token endpoint unreachable`, {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }

  const text = await response.text();

  if (!response.ok) {
    throw toTokenError(text, response.status, providerLabel);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderAuthError(`${providerLabel} returned a non-JSON token response`);
  }

  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    // Do not attach the body — it contains the token.
    throw new ProviderAuthError(
      `${providerLabel} token response did not match the expected shape`,
    );
  }

  const expiresIn = parsed.data.expires_in ?? FALLBACK_EXPIRES_IN_SECONDS;
  const result: RawTokenResponse = {
    accessToken: parsed.data.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1_000),
    scopes: parsed.data.scope?.split(" ").filter(Boolean) ?? [],
  };
  if (parsed.data.refresh_token !== undefined) {
    result.refreshToken = parsed.data.refresh_token;
  }
  return result;
}

/**
 * `invalid_grant` means the user revoked access, changed their password, or the
 * refresh token was rotated out from under us. Retrying cannot fix it — the
 * mailbox has to be reconnected, so it gets its own error type.
 */
function toTokenError(body: string, status: number, providerLabel: string): Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new ProviderAuthError(`${providerLabel} token request failed`, { status });
  }

  const error = tokenErrorSchema.safeParse(parsed);
  if (!error.success) {
    return new ProviderAuthError(`${providerLabel} token request failed`, { status });
  }

  if (error.data.error === "invalid_grant") {
    return new InvalidGrantError(
      `${providerLabel} rejected the refresh token: access was revoked or expired`,
    );
  }

  // Error codes are safe to surface; descriptions are provider prose, so they
  // are kept out of the client-visible details.
  return new ProviderAuthError(`${providerLabel} token request failed`, {
    status,
    providerError: error.data.error,
  });
}

/** GET a provider identity endpoint with a bearer token. */
export async function getWithToken(
  url: string,
  accessToken: string,
  providerLabel: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderAuthError(`${providerLabel} identity endpoint unreachable`, {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }

  if (!response.ok) {
    throw new ProviderAuthError(`${providerLabel} identity lookup failed`, {
      status: response.status,
    });
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderAuthError(`${providerLabel} identity response was not JSON`);
  }
}

/**
 * RFC 7009 token revocation. Idempotent by design: a provider that answers
 * "invalid_token" is telling us the grant is already gone, which is the outcome
 * we wanted. Only a real failure (network, 5xx, refusal) throws.
 */
export async function postRevokeRequest(
  revokeEndpoint: string,
  body: Record<string, string>,
  providerLabel: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(revokeEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderAuthError(`${providerLabel} revocation endpoint unreachable`, {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }

  if (response.ok) return;

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderAuthError(`${providerLabel} revocation failed`, {
      status: response.status,
    });
  }

  const error = tokenErrorSchema.safeParse(parsed);
  // Already revoked, expired, or unknown to the provider: nothing left to do.
  if (
    error.success &&
    (error.data.error === "invalid_token" || error.data.error === "invalid_grant")
  ) {
    return;
  }

  throw new ProviderAuthError(`${providerLabel} revocation failed`, {
    status: response.status,
    ...(error.success ? { providerError: error.data.error } : {}),
  });
}
