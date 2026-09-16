import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../lib/env.js";
import { UpstreamError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { resolveAiEndpoint } from "./endpoint.js";
import type { AiTransport, StructuredRequest, StructuredResponse } from "./transport.js";
import type { TokenCounts } from "./models.js";

/**
 * The Anthropic wire format — the original `callStructured` body, lifted behind the
 * transport port and otherwise unchanged.
 *
 * It is also the transport the **dev stub** runs on: the stub speaks the Messages API, so
 * pointing this at `127.0.0.1:4010` exercises the whole path with no key and no network.
 * That is why "which provider" and "is it stubbed" are separate questions in
 * `endpoint.ts`.
 */

/** Hard ceiling on one request. A model call is not allowed to hang a worker. */
const REQUEST_TIMEOUT_MS = 60_000;

let client: Anthropic | undefined;

/**
 * Lazily constructed, so importing this module (or the whole app) does not require an
 * API key. The key is read once here and never logged.
 */
export function anthropic(): Anthropic {
  if (client) return client;

  const endpoint = resolveAiEndpoint();

  /*
   * Logged at INFO, once, and never quietly: "which model answered" is the first
   * question about any classification in the database, and a stubbed answer must be
   * obvious from the logs rather than deduced from the data.
   */
  logger.info(
    {
      provider: "anthropic",
      baseURL: endpoint.baseURL ?? "https://api.anthropic.com",
      stubbed: endpoint.stubbed,
      reason: endpoint.reason,
    },
    endpoint.stubbed
      ? "AI calls are STUBBED: responses are canned, nothing leaves this machine"
      : "AI calls go to the Anthropic API",
  );

  if (endpoint.stubbed && env.NODE_ENV === "production") {
    logger.error(
      { baseURL: endpoint.baseURL },
      "refusing to trust stubbed AI output in production",
    );
    throw new UpstreamError("AI stub endpoint configured in production");
  }

  client = new Anthropic({
    apiKey: endpoint.apiKey,
    ...(endpoint.baseURL === undefined ? {} : { baseURL: endpoint.baseURL }),
    timeout: REQUEST_TIMEOUT_MS,
    // Our own retry wrapper owns this: one backoff policy, one set of log lines,
    // and a floor the SDK's defaults do not have (lib/retry.ts).
    maxRetries: 0,
  });
  return client;
}

/** Test hook: drop the memoized client so a mocked SDK is picked up. */
export function resetAnthropicClient(): void {
  client = undefined;
}

function tokensOf(usage: Anthropic.Usage | undefined): TokenCounts {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

export const anthropicTransport: AiTransport = {
  providerName: "anthropic",

  async complete(request: StructuredRequest): Promise<StructuredResponse> {
    const tool: Anthropic.Tool = {
      name: request.tool.name,
      description: request.tool.description,
      // Anthropic takes JSON Schema directly, so nothing is lost on this path — unlike
      // the Gemini transport, which has to reduce it (see geminiSchema.ts).
      input_schema: request.tool.parameters as Anthropic.Tool.InputSchema,
    };

    const response = await anthropic().messages.create(
      {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.system,
        // The ONLY place email content appears, and it is a user turn.
        messages: [{ role: "user", content: request.userContent }],
        // Exactly one tool, which returns data. Nothing here can act.
        tools: [tool],
        // Pins it, so "the model replied with prose instead" is a case we reject rather
        // than one we handle by parsing prose.
        tool_choice: { type: "tool", name: request.tool.name },
        // Deterministic-ish: this is a labelling task, not a creative one.
        temperature: 0,
      },
      request.signal ? { signal: request.signal } : {},
    );

    const block = response.content.find(
      (part): part is Anthropic.ToolUseBlock =>
        part.type === "tool_use" && part.name === request.tool.name,
    );

    return {
      // `undefined` when the model did not call the tool. Never reconstructed from text:
      // the absence is the error, and `client.ts` raises it (rule 6).
      toolInput: block?.input,
      model: response.model ?? request.model,
      tokens: tokensOf(response.usage),
      truncated: response.stop_reason === "max_tokens",
      diagnostics: {
        stopReason: response.stop_reason ?? null,
        // Kinds only, never their text: a prose refusal must not reach a log line as a
        // thing somebody might read as the answer.
        blocks: response.content.map((part) => part.type),
      },
    };
  },
};
