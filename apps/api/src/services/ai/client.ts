import { z } from "zod";
import { AiCapExceededError, AiDisabledError, UpstreamError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { withRetry } from "../../lib/retry.js";
import { MAX_OUTPUT_TOKENS, modelFor, type AiFeature } from "./models.js";
import { isRegisteredSystemPrompt, SYSTEM_PROMPTS } from "./prompts.js";
import { resolveAiEndpoint } from "./endpoint.js";
import { anthropicTransport, resetAnthropicClient } from "./anthropicTransport.js";
import { geminiTransport, resetGeminiClient } from "./geminiTransport.js";
import type { AiTransport, StructuredRequest } from "./transport.js";
import type { TokenCounts } from "./models.js";
import { checkDailyCap, loadAiSettings, recordUsage, type AiSettings } from "./usage.js";

/**
 * The one path by which this application talks to a model (§5).
 *
 * Everything that must be true of every AI call is true *here* rather than at each call
 * site — and, since there is now more than one provider, rather than in each transport:
 *
 *   - the system prompt comes from the registry, checked by identity, so email content
 *     cannot reach it;
 *   - exactly one tool is offered, and it returns data — there is no tool that mutates
 *     state (§7 rule 3);
 *   - the response is parsed by validating the tool input against a Zod schema, never by
 *     reading prose (rule 6);
 *   - the daily cap is checked before, and the ledger is written after — including when
 *     the response turns out to be unusable, because the tokens were spent.
 *
 * **Which provider answered changes none of that.** A transport
 * (`services/ai/transport.ts`) translates one request into one wire format and reports
 * what came back; it does not validate, does not judge, and cannot supply a prompt. So
 * "a different model gets the same boundary" is a property of this file's structure
 * rather than of four transports being careful — which is the only way it stays true.
 */

/** The transports, by the name `endpoint.ts` resolves. */
const TRANSPORTS: Readonly<Record<"anthropic" | "gemini", AiTransport>> = {
  anthropic: anthropicTransport,
  gemini: geminiTransport,
};

/** Which transport this process is configured to use. */
export function activeTransport(): AiTransport {
  return TRANSPORTS[resolveAiEndpoint().provider];
}

/** Test hook: drop both memoized clients so a mocked SDK is picked up. */
export function resetAiClients(): void {
  resetAnthropicClient();
  resetGeminiClient();
}

/**
 * Kept under its old name because the Anthropic tests and the stub path both call it.
 * `resetAiClients` is the one to use from new code.
 */
export { resetAnthropicClient };

export interface StructuredCallInput<T> {
  userId: string;
  /** Selects the model, the output ceiling, the system prompt and the ledger label. */
  feature: AiFeature;
  toolName: string;
  toolDescription: string;
  schema: z.ZodType<T>;
  /**
   * The user message. Email content must already be wrapped by
   * `untrustedEmailBlock`/`untrustedThreadBlock` — this function will not wrap it
   * for you, and never puts it anywhere but here.
   */
  userContent: string;
  settings?: AiSettings;
  signal?: AbortSignal;
  /** Extra ids for the log lines. Never body text. */
  logContext?: Record<string, unknown>;
}

export interface StructuredCallResult<T> {
  data: T;
  model: string;
  tokens: TokenCounts;
}

/**
 * One structured-output call: send the prompt, get the tool arguments back, validate.
 *
 * The ordering below is load-bearing and is the same on every provider:
 *
 *   1. settings, then the cap — so a refusal costs nothing;
 *   2. resolve the prompt from the registry and assert it is ours;
 *   3. compile the Zod schema to JSON Schema and hand the transport the request;
 *   4. **bill**, before judging anything: spent tokens are spent;
 *   5. reject a truncated answer, then an answer with no tool call — no prose fallback;
 *   6. validate the tool arguments against the schema.
 */
export async function callStructured<T>(
  input: StructuredCallInput<T>,
): Promise<StructuredCallResult<T>> {
  const settings = input.settings ?? (await loadAiSettings(input.userId));
  const transport = activeTransport();
  const log = logger.child({
    userId: input.userId,
    feature: input.feature,
    provider: transport.providerName,
  });

  if (!settings.aiEnabled) {
    throw new AiDisabledError("AI features are disabled for this user");
  }

  const cap = await checkDailyCap(input.userId, settings);
  if (!cap.allowed) {
    // Refused before the call, so the cap bounds spend rather than reporting it. On a
    // free tier it bounds the *request* count, which is what the free tier rations.
    log.warn({ used: cap.used, cap: cap.cap }, "daily AI call cap reached");
    throw new AiCapExceededError("Daily AI call cap reached", {
      used: cap.used,
      cap: cap.cap,
    });
  }

  const model = modelFor(input.feature, transport.providerName);
  const system = SYSTEM_PROMPTS[input.feature];

  // Backstop for §7 rule 1: the prompt must be one of ours, by identity. Checked here,
  // above the transports, so no provider can be the place this is skipped.
  if (!isRegisteredSystemPrompt(system)) {
    throw new UpstreamError("refusing to call the model with an unregistered prompt");
  }

  const request: StructuredRequest = {
    model,
    system,
    userContent: input.userContent,
    tool: {
      name: input.toolName,
      description: input.toolDescription,
      parameters: z.toJSONSchema(input.schema, {
        target: "draft-7",
        io: "output",
      }) as Record<string, unknown>,
    },
    maxOutputTokens: MAX_OUTPUT_TOKENS[input.feature],
    ...(input.signal ? { signal: input.signal } : {}),
  };

  const response = await withRetry(async () => transport.complete(request), {
    label: `${transport.providerName}.${input.feature}`,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  // Billed before the response is judged: spent tokens are spent whatever came back.
  await recordUsage({
    userId: input.userId,
    feature: input.feature,
    model: response.model,
    tokens: response.tokens,
  });

  if (response.truncated) {
    throw new UpstreamError(`${input.feature} response hit the output ceiling`, {
      maxTokens: MAX_OUTPUT_TOKENS[input.feature],
      provider: transport.providerName,
    });
  }

  if (response.toolInput === undefined) {
    // No prose fallback on purpose: parsing an unstructured answer is exactly the path
    // by which email text becomes a field value (rule 6).
    throw new UpstreamError(`${input.feature} returned no ${input.toolName} tool call`, {
      stopReason: response.diagnostics.stopReason,
      blocks: response.diagnostics.blocks,
      provider: transport.providerName,
    });
  }

  const parsed = input.schema.safeParse(response.toolInput);
  if (!parsed.success) {
    /*
     * The enforcement point, and it matters more on the Gemini path than on the
     * Anthropic one: Gemini's tool declaration cannot carry `minimum`, `maxItems` or
     * `maxLength` (see geminiSchema.ts), so for those constraints this parse is the only
     * thing standing between a model's guess and a database column.
     */
    log.warn(
      {
        ...input.logContext,
        model: response.model,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
      "model output failed schema validation",
    );
    throw new UpstreamError(`${input.feature} returned output that failed validation`);
  }

  log.debug(
    { ...input.logContext, model: response.model, ...response.tokens },
    "ai structured call complete",
  );

  return { data: parsed.data, model: response.model, tokens: response.tokens };
}
