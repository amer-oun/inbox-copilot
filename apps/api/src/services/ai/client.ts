import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../../lib/env.js";
import { AiCapExceededError, AiDisabledError, UpstreamError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { withRetry } from "../../lib/retry.js";
import { FEATURE_MODELS, MAX_OUTPUT_TOKENS, type AiFeature } from "./models.js";
import { isRegisteredSystemPrompt, SYSTEM_PROMPTS } from "./prompts.js";
import type { TokenCounts } from "./models.js";
import { checkDailyCap, loadAiSettings, recordUsage, type AiSettings } from "./usage.js";

/**
 * The Anthropic client (§5) and the one path by which this application talks to a
 * model.
 *
 * Everything that must be true of every AI call is true here rather than at each
 * call site:
 *   - the system prompt comes from the registry, so email content cannot reach it;
 *   - exactly one tool is offered, and it returns data — there is no tool that
 *     mutates state (§7 rule 3);
 *   - the response is parsed by validating the tool input against a Zod schema,
 *     never by reading prose (rule 6);
 *   - the daily cap is checked before, and the ledger is written after — including
 *     when the response turns out to be unusable, because the tokens were spent.
 */

/** Hard ceiling on one request. A model call is not allowed to hang a worker. */
const REQUEST_TIMEOUT_MS = 60_000;

let client: Anthropic | undefined;

/**
 * Lazily constructed, so importing this module (or the whole app) does not require
 * an API key. The key is read once here and never logged.
 */
export function anthropic(): Anthropic {
  if (client) return client;

  if (env.ANTHROPIC_API_KEY === "") {
    throw new UpstreamError("AI is not configured: ANTHROPIC_API_KEY is unset");
  }

  client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
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

function tokensOf(usage: Anthropic.Usage | undefined): TokenCounts {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * One structured-output call: send the prompt, get the tool input back, validate it.
 *
 * `tool_choice` pins the single tool, so "the model replied with prose instead" is
 * not a case we have to handle by parsing prose — it is a case we reject.
 */
export async function callStructured<T>(
  input: StructuredCallInput<T>,
): Promise<StructuredCallResult<T>> {
  const settings = input.settings ?? (await loadAiSettings(input.userId));
  const log = logger.child({ userId: input.userId, feature: input.feature });

  if (!settings.aiEnabled) {
    throw new AiDisabledError("AI features are disabled for this user");
  }

  const cap = await checkDailyCap(input.userId, settings);
  if (!cap.allowed) {
    // Refused before the call, so the cap bounds spend rather than reporting it.
    log.warn({ used: cap.used, cap: cap.cap }, "daily AI call cap reached");
    throw new AiCapExceededError("Daily AI call cap reached", {
      used: cap.used,
      cap: cap.cap,
    });
  }

  const model = FEATURE_MODELS[input.feature];
  const system = SYSTEM_PROMPTS[input.feature];

  // Backstop for §7 rule 1: the prompt must be one of ours, by identity.
  if (!isRegisteredSystemPrompt(system)) {
    throw new UpstreamError("refusing to call the model with an unregistered prompt");
  }

  const tool: Anthropic.Tool = {
    name: input.toolName,
    description: input.toolDescription,
    input_schema: z.toJSONSchema(input.schema, {
      target: "draft-7",
      io: "output",
    }) as Anthropic.Tool.InputSchema,
  };

  const response = await withRetry(
    async () =>
      anthropic().messages.create(
        {
          model,
          max_tokens: MAX_OUTPUT_TOKENS[input.feature],
          system,
          // The ONLY place email content appears, and it is a user turn.
          messages: [{ role: "user", content: input.userContent }],
          // Exactly one tool, which returns data. Nothing here can act.
          tools: [tool],
          tool_choice: { type: "tool", name: input.toolName },
          // Deterministic-ish: this is a labelling task, not a creative one.
          temperature: 0,
        },
        input.signal ? { signal: input.signal } : {},
      ),
    {
      label: `anthropic.${input.feature}`,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );

  const tokens = tokensOf(response.usage);

  // Billed before the response is judged: spent tokens are spent whatever came back.
  await recordUsage({
    userId: input.userId,
    feature: input.feature,
    model: response.model ?? model,
    tokens,
  });

  if (response.stop_reason === "max_tokens") {
    throw new UpstreamError(`${input.feature} response hit the output ceiling`, {
      maxTokens: MAX_OUTPUT_TOKENS[input.feature],
    });
  }

  const block = response.content.find(
    (part): part is Anthropic.ToolUseBlock =>
      part.type === "tool_use" && part.name === input.toolName,
  );

  if (!block) {
    // No prose fallback on purpose: parsing an unstructured answer is exactly the
    // path by which email text becomes a field value (rule 6).
    throw new UpstreamError(`${input.feature} returned no ${input.toolName} tool call`, {
      stopReason: response.stop_reason,
      blocks: response.content.map((part) => part.type),
    });
  }

  const parsed = input.schema.safeParse(block.input);
  if (!parsed.success) {
    log.warn(
      {
        ...input.logContext,
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
    { ...input.logContext, model: response.model, ...tokens },
    "ai structured call complete",
  );

  return { data: parsed.data, model: response.model ?? model, tokens };
}
