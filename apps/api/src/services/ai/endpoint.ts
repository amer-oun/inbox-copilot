import { env } from "../../lib/env.js";
import { UpstreamError } from "../../lib/errors.js";

/**
 * Where AI calls go, and with what key.
 *
 * Three configurations, resolved here so the decision is in one place and can be
 * logged and tested rather than inferred from behaviour:
 *
 *   1. `ANTHROPIC_BASE_URL` set — calls go there. That is the local stub in
 *      development (`pnpm ai:stub`), or a proxy/gateway in a deployment.
 *   2. `ANTHROPIC_API_KEY` set, no base URL — the real API.
 *   3. Neither, outside production — the stub, on `AI_STUB_PORT`. This is what
 *      makes `pnpm dev` work with no key at all: the whole enrich path runs, and
 *      no request leaves the machine.
 *
 * In production with neither, the call fails loudly. A production deploy silently
 * classifying mail against a canned-response server would be worse than an outage.
 */

export interface AiEndpoint {
  apiKey: string;
  /** Undefined means the SDK's own default: the real API. */
  baseURL: string | undefined;
  /** True when responses are canned rather than from a model. */
  stubbed: boolean;
  /** Why this endpoint was chosen — logged once, at client construction. */
  reason: string;
}

/**
 * The SDK requires a non-empty key even when the endpoint ignores it. This value
 * is deliberately not key-shaped: if it ever appears in a request to the real API
 * the failure is an obvious 401, not a confusing one.
 */
export const STUB_API_KEY = "stub-no-key-required";

function stubBaseUrl(): string {
  return `http://127.0.0.1:${env.AI_STUB_PORT}`;
}

export function resolveAiEndpoint(): AiEndpoint {
  if (env.ANTHROPIC_BASE_URL !== "") {
    const stubbed = env.ANTHROPIC_BASE_URL === stubBaseUrl();
    return {
      apiKey: env.ANTHROPIC_API_KEY === "" ? STUB_API_KEY : env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL,
      stubbed,
      reason: "ANTHROPIC_BASE_URL is set",
    };
  }

  if (env.ANTHROPIC_API_KEY !== "") {
    return {
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: undefined,
      stubbed: false,
      reason: "ANTHROPIC_API_KEY is set",
    };
  }

  if (env.NODE_ENV === "production") {
    throw new UpstreamError(
      "AI is not configured: set ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL to point at a gateway",
    );
  }

  return {
    apiKey: STUB_API_KEY,
    baseURL: stubBaseUrl(),
    stubbed: true,
    reason: "no ANTHROPIC_API_KEY outside production, so the local stub is used",
  };
}
