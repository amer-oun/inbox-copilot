import type { TokenCounts } from "./models.js";

/**
 * The provider port for the AI layer (§5), in the spirit of `MailProvider` for mail.
 *
 * **A transport is a wire format and nothing else.** Read the shape of
 * `StructuredResponse` and what is missing from it is the point: no schema, no
 * validation, no decision about whether the answer is usable, no ledger write, no cap
 * check. Every one of those stays in `client.ts`, above this seam, so that adding a
 * provider cannot weaken them — the §7 guarantees are properties of the *caller*, not
 * promises each transport is trusted to keep.
 *
 * Concretely, what a transport may not do:
 *
 *   - **it never chooses the system prompt.** The prompt arrives as a string that
 *     `client.ts` has already checked against the registry by identity (§7 rule 1), so
 *     no transport can be the place mail reaches the system position;
 *   - **it never validates.** `toolInput` comes back as `unknown` and `client.ts` runs
 *     the Zod schema over it. That is rule 6, and `unknown` is how the type system
 *     enforces it: a transport physically cannot hand back something pre-approved;
 *   - **it never parses prose.** `toolInput` is absent when the model did not call the
 *     tool. It must not be reconstructed from text — the absence is the error, and
 *     `client.ts` raises it;
 *   - **it never decides retries or billing.** It reports `tokens` and `truncated` and
 *     lets the caller act: usage is billed *before* the response is judged, because the
 *     tokens were spent either way.
 *
 * What a transport does own is the translation: one system prompt, one user turn, one
 * tool that must be called, and the token counts back. Every provider has those four
 * things under different names.
 */

/** The single request shape. Built by `client.ts`; a transport only translates it. */
export interface StructuredRequest {
  /** Resolved from the feature and the provider by `models.ts`. */
  model: string;
  /**
   * The system prompt, already verified to be one of ours. A transport puts this where
   * its provider keeps system instructions and nowhere else.
   */
  system: string;
  /**
   * The user turn. **The only place email content is allowed to appear**, already
   * wrapped and defanged by `prompts.ts`. A transport must pass it through untouched
   * and must not concatenate the system prompt into it.
   */
  userContent: string;
  /** The one tool on offer. It returns data; there is nothing here that can act. */
  tool: {
    name: string;
    description: string;
    /** JSON Schema compiled from the Zod schema by `client.ts`. */
    parameters: Record<string, unknown>;
  };
  maxOutputTokens: number;
  signal?: AbortSignal;
}

/**
 * What came back, as facts rather than as a verdict.
 *
 * Note that this is expressible for a response that is unusable in every way — no tool
 * call, truncated, nonsense arguments. That is deliberate: judging it is the caller's
 * job, and a transport that could not *describe* a bad response would have to decide
 * about it instead.
 */
export interface StructuredResponse {
  /**
   * The tool call's arguments, **unvalidated**, or undefined when the model did not
   * call the tool. `unknown` rather than a generic: nothing may reach `client.ts`
   * already believed.
   */
  toolInput: unknown | undefined;
  /** The model that actually answered, which may differ from the one requested. */
  model: string;
  tokens: TokenCounts;
  /** True when generation stopped at the output ceiling rather than finishing. */
  truncated: boolean;
  /**
   * For the error raised when `toolInput` is absent. Diagnostics only — never a
   * fallback to read an answer out of.
   */
  diagnostics: {
    /** Why the model stopped, in the provider's own vocabulary. */
    stopReason: string | null;
    /** The kinds of content part that came back, e.g. ["text"]. Never their text. */
    blocks: string[];
  };
}

/** One provider's wire format. Constructed lazily; see `providerFor`. */
export interface AiTransport {
  readonly providerName: "anthropic" | "gemini";
  complete(request: StructuredRequest): Promise<StructuredResponse>;
}
