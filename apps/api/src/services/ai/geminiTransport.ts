import {
  FunctionCallingMode,
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  type FunctionDeclarationSchema,
  type GenerativeModel,
} from "@google/generative-ai";
import { logger } from "../../lib/logger.js";
import { resolveAiEndpoint } from "./endpoint.js";
import { toGeminiSchema } from "./geminiSchema.js";
import type { AiTransport, StructuredRequest, StructuredResponse } from "./transport.js";
import type { TokenCounts } from "./models.js";

/**
 * The Gemini wire format, for `AI_PROVIDER=gemini` on Google's free tier.
 *
 * Everything above this file is untouched: the same prompt registry, the same
 * `<untrusted_email>` escaping, the same Zod schemas, the same content-hash cache, the
 * same ledger. What differs is only how those four things are spelled:
 *
 *   | ours                  | Anthropic            | Gemini                        |
 *   |-----------------------|----------------------|-------------------------------|
 *   | system prompt         | `system`             | `systemInstruction`           |
 *   | the one untrusted turn| `messages[0]`        | `contents[0].parts[0].text`   |
 *   | the one tool, forced  | `tool_choice: tool`  | `functionCallingConfig: ANY`  |
 *   | tool arguments back   | `tool_use.input`     | `functionCalls()[0].args`     |
 *
 * §7 rule 1 survives the translation because `systemInstruction` is a genuinely separate
 * field, exactly like Anthropic's `system` — there is no concatenation of our
 * instructions into the user turn anywhere here, and `geminiTransport.test.ts` asserts
 * the email text appears in the user turn and nowhere else.
 *
 * Three places where this provider is not simply a renaming, all handled here because a
 * wire-format difference is precisely what a transport is for:
 *
 *   1. **the tool schema has to be reduced** (`geminiSchema.ts`). Gemini takes an
 *      OpenAPI subset, not JSON Schema, so value constraints are dropped. Safe, because
 *      the Zod parse in `client.ts` still runs over the answer — the constraint goes from
 *      advisory to enforced rather than disappearing.
 *   2. **safety filters are turned off.** See `SAFETY_SETTINGS`.
 *   3. **the output ceiling needs headroom.** See `outputBudgetFor`.
 */

/** Hard ceiling on one request, matching the Anthropic transport. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Safety filtering: off, as far as the API allows.
 *
 * This looks alarming and is the only correct setting for this application. The mail
 * this model is asked to read is *hostile by assumption* — §6 exists to classify
 * credential harvesting, extortion and invoice fraud, and a filter that refuses to
 * process a threatening email makes the threat detector fail on exactly the messages it
 * was built for. A blocked response is not a safe outcome here; it is an unassessed
 * phishing mail with a clean-looking UNKNOWN next to it.
 *
 * What makes this safe is that the filters were never the boundary. The boundary is
 * structural and unchanged: one tool that returns data, no state-mutating tool anywhere
 * in the layer, a Zod schema the answer has to fit, and a verdict that the deterministic
 * rules floor (§6). Turning off a content classifier does not widen any of that.
 *
 * `BLOCK_NONE` on some categories needs an allowlisted project; if the API refuses it,
 * the call fails loudly with Google's own message rather than silently filtering, which
 * is the right way round.
 */
const SAFETY_SETTINGS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));

/**
 * Extra output budget, because Gemini 2.5 spends `maxOutputTokens` on *thinking* as well
 * as on the answer.
 *
 * This is a real difference rather than a tuning preference, and it was **measured
 * against the live API** rather than guessed at. The same threat assessment, twice:
 *
 *     maxOutputTokens=768   finishReason=MAX_TOKENS   thoughts=468  output=92
 *     maxOutputTokens=4096  finishReason=STOP         thoughts=410  output=85
 *
 * On Anthropic, `MAX_OUTPUT_TOKENS.threat = 768` is 768 tokens of answer. On a thinking
 * model it is a budget shared with the reasoning — so at the §5 ceiling the response comes
 * back truncated, `client.ts` correctly refuses it, and **every threat assessment fails**,
 * for a reason nobody reading `models.ts` could guess. (Note the first row: a function
 * call was present and the answer was still rejected, which is right — a truncated tool
 * call can carry a half-written explanation.)
 *
 * So the semantic ceiling stays where §5 put it and the transport adds headroom. The floor
 * matters more than the multiplier: a small ceiling is where this bites, and `threat` at
 * 768 is the smallest one that runs per message.
 *
 * (The legacy `@google/generative-ai` SDK has no `thinkingConfig`, so the budget cannot
 * simply be set to zero. Newer `@google/genai` can; if this moves to it, this function is
 * what to delete.)
 */
export function outputBudgetFor(maxOutputTokens: number): number {
  const WITH_HEADROOM = maxOutputTokens * 4;
  const FLOOR = 4_096;
  return Math.max(FLOOR, WITH_HEADROOM);
}

let client: GoogleGenerativeAI | undefined;

/** Lazily constructed, so importing this module does not require a key. */
function gemini(): GoogleGenerativeAI {
  if (client) return client;

  const endpoint = resolveAiEndpoint();

  // Logged once, at INFO, for the same reason the Anthropic transport does it: "which
  // model answered" is the first question about any row in the database.
  logger.info(
    { provider: "gemini", stubbed: false, reason: endpoint.reason },
    "AI calls go to the Gemini API",
  );

  client = new GoogleGenerativeAI(endpoint.apiKey);
  return client;
}

/** Test hook: drop the memoized client so a mocked SDK is picked up. */
export function resetGeminiClient(): void {
  client = undefined;
}

/**
 * Gemini's token counts, mapped onto ours.
 *
 * `cachedContentTokenCount` is context caching, the nearest equivalent of Anthropic's
 * cache reads. There is no write counter to map, so `cacheWriteTokens` stays zero rather
 * than being invented — a ledger that guesses is worse than one that reports zero.
 *
 * `thoughtsTokenCount` (2.5 thinking) is *not* added to the output count: it is billed as
 * output by Google but it is not output we received, and folding it in would make
 * "outputTokens" mean two different things depending on the provider. It goes in the log
 * line instead. On the free tier this changes no cost either way.
 */
function tokensOf(usage: Record<string, unknown> | undefined): TokenCounts {
  const read = (key: string): number => {
    const value = usage?.[key];
    return typeof value === "number" ? value : 0;
  };

  return {
    inputTokens: read("promptTokenCount"),
    outputTokens: read("candidatesTokenCount"),
    cacheReadTokens: read("cachedContentTokenCount"),
    cacheWriteTokens: 0,
  };
}

/** The model handle for one request. Rebuilt per call: it carries the tool and prompt. */
function modelFor(request: StructuredRequest): GenerativeModel {
  return gemini().getGenerativeModel({
    model: request.model,
    /*
     * §7 rule 1: our instructions in the system position, mail nowhere near it. A
     * genuinely separate field, not a prefix on the user turn.
     */
    systemInstruction: request.system,
    tools: [
      {
        functionDeclarations: [
          {
            name: request.tool.name,
            description: request.tool.description,
            // JSON Schema reduced to Gemini's subset. Throws rather than silently
            // dropping anything structural (geminiSchema.ts).
            parameters: toGeminiSchema(
              request.tool.parameters,
            ) as FunctionDeclarationSchema,
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        /*
         * ANY plus an allowlist of one is Gemini's `tool_choice: {type: "tool"}`: the
         * model must call a function, and there is exactly one it may call. That is what
         * makes "it answered with prose instead" a case we reject rather than one we
         * handle by parsing prose (rule 6).
         */
        mode: FunctionCallingMode.ANY,
        allowedFunctionNames: [request.tool.name],
      },
    },
    safetySettings: SAFETY_SETTINGS,
    generationConfig: {
      maxOutputTokens: outputBudgetFor(request.maxOutputTokens),
      // Deterministic-ish, matching the Anthropic path: a labelling task, not a creative
      // one.
      temperature: 0,
    },
  });
}

export const geminiTransport: AiTransport = {
  providerName: "gemini",

  async complete(request: StructuredRequest): Promise<StructuredResponse> {
    const result = await modelFor(request).generateContent(
      {
        // The ONLY place email content appears, and it is a user turn.
        contents: [{ role: "user", parts: [{ text: request.userContent }] }],
      },
      {
        timeout: REQUEST_TIMEOUT_MS,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    const response = result.response;
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason ?? null;

    /*
     * `functionCalls()` is the SDK's own accessor over the parts, so this is not parsing:
     * a function call is a structured part, and its `args` is already an object. The
     * allowlist above means the name can only be ours, but it is checked anyway — a
     * transport should not rely on the server having honoured a constraint we asked for.
     */
    const call = response
      .functionCalls()
      ?.find((candidateCall) => candidateCall.name === request.tool.name);

    const usage = response.usageMetadata as unknown as
      Record<string, unknown> | undefined;

    /*
     * A prompt the safety filters blocked outright has no candidates at all, and the
     * reason lives in `promptFeedback` rather than in a finish reason. Surfaced as a
     * stop reason so the "no tool call" error `client.ts` raises says *why* — otherwise
     * a filtered phishing mail is indistinguishable from a model that just misbehaved.
     */
    const blockReason = response.promptFeedback?.blockReason;
    const stopReason =
      finishReason ?? (blockReason === undefined ? null : `blocked:${blockReason}`);

    if (usage?.["thoughtsTokenCount"] !== undefined) {
      // Not folded into outputTokens (see tokensOf); logged so a truncation at the
      // ceiling is diagnosable.
      logger.debug(
        {
          provider: "gemini",
          model: request.model,
          thoughtsTokenCount: usage["thoughtsTokenCount"],
          budget: outputBudgetFor(request.maxOutputTokens),
        },
        "gemini reported thinking tokens",
      );
    }

    return {
      // `undefined` when the model did not call the tool. Nothing is read out of the text
      // parts as a fallback: the absence is the error.
      toolInput: call?.args,
      // Gemini does not echo the model back on the response, so the requested id is the
      // honest answer for the ledger.
      model: request.model,
      tokens: tokensOf(usage),
      truncated: finishReason === "MAX_TOKENS",
      diagnostics: {
        stopReason,
        // Kinds only, never their text.
        blocks: (candidate?.content?.parts ?? []).map((part) =>
          part.functionCall !== undefined
            ? "functionCall"
            : part.text !== undefined
              ? "text"
              : "other",
        ),
      },
    };
  },
};
