import { env } from "../../lib/env.js";
import { UpstreamError } from "../../lib/errors.js";

/**
 * Which provider AI calls go to, where, and with what key.
 *
 * `AI_PROVIDER` decides, and when it is unset the decision is *inferred exactly as it
 * was before that variable existed* — which is why every branch below is still keyed on
 * the Anthropic settings. That back-compatibility is deliberate: an existing `.env`, a
 * running deployment and `pnpm dev` must all behave identically after this file grew a
 * second provider.
 *
 * The resolution, in order:
 *
 *   1. `AI_PROVIDER=gemini` — Google's API with `GEMINI_API_KEY`. Free tier.
 *   2. `AI_PROVIDER=stub` — the local canned-response server, explicitly. Refused in
 *      production, like the inferred stub below.
 *   3. `AI_PROVIDER=anthropic`, or unset, then:
 *      a. `ANTHROPIC_BASE_URL` set — calls go there: the local stub in development
 *         (`pnpm ai:stub`), or a proxy/gateway in a deployment.
 *      b. `ANTHROPIC_API_KEY` set, no base URL — the real API.
 *      c. Neither, outside production — the stub, on `AI_STUB_PORT`. This is what makes
 *         `pnpm dev` work with no key at all: the whole enrich path runs and no request
 *         leaves the machine.
 *
 * In production with nothing configured, the call fails loudly. A production deploy
 * silently classifying mail against a canned-response server would be worse than an
 * outage.
 *
 * Note that `stubbed` is a property of the *endpoint*, not of the provider: the stub is
 * reached by pointing the Anthropic transport at a local server that speaks the Messages
 * API, which is what lets the whole path — prompts, tool definitions, schema validation,
 * cache, ledger — run unchanged with no key.
 */

export interface AiEndpoint {
  /** Which SDK to talk to. `stubbed` is orthogonal: the stub speaks Anthropic's API. */
  provider: "anthropic" | "gemini";
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
  /*
   * Gemini first, and only when asked for by name. Never inferred from the presence of
   * `GEMINI_API_KEY`: a key left in an `.env` from an experiment must not silently
   * redirect a deployment's mail classification to a different model. Switching provider
   * is a decision, so it is written down.
   */
  if (env.AI_PROVIDER === "gemini") {
    if (env.GEMINI_API_KEY === "") {
      throw new UpstreamError("AI_PROVIDER=gemini but GEMINI_API_KEY is empty");
    }
    return {
      provider: "gemini",
      apiKey: env.GEMINI_API_KEY,
      // The SDK's own default endpoint. There is no Gemini equivalent of the stub base
      // URL here, because `AI_PROVIDER=stub` already covers "do not call anything".
      baseURL: undefined,
      stubbed: false,
      reason: "AI_PROVIDER=gemini",
    };
  }

  /*
   * The stub, asked for explicitly. Same refusal in production as the inferred stub: the
   * reason a production deploy must not run on canned answers has nothing to do with
   * whether somebody chose it on purpose.
   */
  if (env.AI_PROVIDER === "stub") {
    if (env.NODE_ENV === "production") {
      throw new UpstreamError("AI_PROVIDER=stub is refused in production");
    }
    return {
      provider: "anthropic",
      apiKey: STUB_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL === "" ? stubBaseUrl() : env.ANTHROPIC_BASE_URL,
      stubbed: true,
      reason: "AI_PROVIDER=stub",
    };
  }

  if (env.ANTHROPIC_BASE_URL !== "") {
    const stubbed = env.ANTHROPIC_BASE_URL === stubBaseUrl();
    return {
      provider: "anthropic",
      apiKey: env.ANTHROPIC_API_KEY === "" ? STUB_API_KEY : env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL,
      stubbed,
      reason: "ANTHROPIC_BASE_URL is set",
    };
  }

  if (env.ANTHROPIC_API_KEY !== "") {
    return {
      provider: "anthropic",
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: undefined,
      stubbed: false,
      reason: "ANTHROPIC_API_KEY is set",
    };
  }

  if (env.NODE_ENV === "production") {
    throw new UpstreamError(
      "AI is not configured: set ANTHROPIC_API_KEY, GEMINI_API_KEY with AI_PROVIDER=gemini, or ANTHROPIC_BASE_URL to point at a gateway",
    );
  }

  return {
    provider: "anthropic",
    apiKey: STUB_API_KEY,
    baseURL: stubBaseUrl(),
    stubbed: true,
    reason: "no ANTHROPIC_API_KEY outside production, so the local stub is used",
  };
}
