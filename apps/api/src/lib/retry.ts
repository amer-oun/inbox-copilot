import { logger } from "./logger.js";
import { RateLimitError, UpstreamError } from "./errors.js";

/**
 * Retry with exponential backoff and jitter — the *fallback* for rate limiting, not
 * the strategy. Pacing is the strategy: every provider call passes through the token
 * bucket in lib/rateLimiter.ts before it fires, so the limit should not be reached.
 * Retry covers what pacing cannot predict: shared project quota, another client on
 * the same mailbox, a quota change.
 *
 * Three rules that matter more than the curve:
 *   1. `Retry-After` wins, and wins completely: it overrides the curve and its
 *      30s ceiling, unjittered. Guessing earlier than the provider told us just
 *      burns more quota and extends the block.
 *   2. There is a floor. Jitter is a multiplier applied *on top of* the delay, never
 *      a fraction of it — full jitter (`random() * delay`) produced 5ms retries,
 *      which is not a backoff, it is the same request again.
 *   3. Jitter still matters: a backfill fans out, and without it every retry in a
 *      batch lands in the same millisecond and re-triggers the limit together.
 */

export interface RetryOptions {
  /** Total attempts including the first. Raising this is not a rate-limit fix. */
  attempts?: number;
  /** Floor: no wait, however computed, is ever shorter than this. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Ceiling for a provider-supplied Retry-After; longer waits belong to the queue. */
  maxRetryAfterMs?: number;
  /** Label for log lines, e.g. "gmail.threads.get". */
  label: string;
  /** Injected in tests so they do not actually sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected in tests to make the jitter deterministic. */
  random?: () => number;
  /** Cancels the wait and stops further attempts when the job is being retried. */
  signal?: AbortSignal;
}

const DEFAULTS = {
  attempts: 5,
  /** A retry sooner than this is indistinguishable from not backing off at all. */
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
} as const;

/** Jitter adds up to 50% on top of the computed delay, and never subtracts. */
const JITTER_RATIO = 0.5;

/** Thrown when a wait is cut short because the work was cancelled. */
export class AbortedError extends Error {
  constructor(message = "operation aborted") {
    super(message);
    this.name = "AbortedError";
  }
}

/** True for the several shapes an abort arrives in (ours, Gaxios, undici, Node). */
export function isAbortError(error: unknown): boolean {
  if (error instanceof AbortedError) return true;
  const name = (error as { name?: string } | null)?.name;
  const code = (error as { code?: string | number } | null)?.code;
  return (
    name === "AbortError" || name === "RateLimiterAbortError" || code === "ABORT_ERR"
  );
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Gmail's rate-limit reasons, which arrive as 403 rather than 429. */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "backendError",
]);

interface GoogleApiErrorish {
  code?: number | string;
  status?: number;
  message?: string;
  /**
   * Anthropic's `APIError` hangs headers off the error itself rather than off a
   * `response`. Same job, different shape, so both are checked.
   */
  headers?: unknown;
  response?: {
    status?: number;
    /**
     * `unknown` on purpose. Gaxios 7 is fetch-based, so this is a WHATWG
     * `Headers` instance, not the plain record gaxios 6 gave us — typing it as a
     * record is what let `headers["retry-after"]` compile and always miss.
     */
    headers?: unknown;
    data?: unknown;
  };
  errors?: { reason?: string; message?: string }[];
}

/**
 * Reads one response header regardless of how the HTTP client represents them.
 *
 * Gaxios 7 hands back a WHATWG `Headers`: bracket access is `undefined` on it,
 * `Object.keys` is `[]` and spreading it yields `{}` — which is why every failure
 * logged `honoredRetryAfter: false` while the response carried `Retry-After: 47`.
 * `instanceof Headers` is not a safe test either (it was false for the real error
 * object, the class coming from a different realm), so this duck-types on `.get`.
 *
 * Plain objects are still handled: an undici/Node record, or a fixture, and with
 * case-insensitive lookup because HTTP header names are case-insensitive and the
 * lowercase spelling is a convention, not a guarantee.
 */
export function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== "object") return undefined;

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => string | null).call(headers, name);
    return value ?? undefined;
  }

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

/** Flattens any header representation into something loggable. */
function headersToObject(headers: unknown): Record<string, string> | undefined {
  if (headers === null || typeof headers !== "object") return undefined;

  const entries = (headers as { entries?: unknown }).entries;
  if (typeof entries === "function") {
    return Object.fromEntries(
      (entries as () => Iterable<[string, string]>).call(headers),
    );
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function asErrorish(error: unknown): GoogleApiErrorish {
  return (typeof error === "object" && error !== null ? error : {}) as GoogleApiErrorish;
}

function statusOf(error: unknown): number | undefined {
  const e = asErrorish(error);
  const candidate = e.response?.status ?? e.status ?? e.code;
  return typeof candidate === "number" ? candidate : undefined;
}

/** Pulls the `reason` out of a Google JSON error body, wherever it is hiding. */
export function reasonOf(error: unknown): string | undefined {
  const e = asErrorish(error);
  const fromErrors = e.errors?.find((entry) => entry.reason !== undefined)?.reason;
  if (fromErrors !== undefined) return fromErrors;

  const data = e.response?.data;
  if (typeof data === "object" && data !== null && "error" in data) {
    const inner = (data as { error?: { errors?: { reason?: string }[] } }).error;
    return inner?.errors?.find((entry) => entry.reason !== undefined)?.reason;
  }
  return undefined;
}

/** Keys whose values never reach a log line, at any depth (rule 3). */
const TOKEN_KEY = /(^|_|\.)(access_?token|refresh_?token|id_?token|authorization|bearer)$/i;

/**
 * Deep copy with token-shaped values censored.
 *
 * pino's redact wildcards only reach one level down, and a provider error body is
 * arbitrarily nested, so the stripping happens here instead of in the transport.
 * Nothing else is removed: the point of logging the body is to see all of it.
 */
function stripTokens(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => stripTokens(entry, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = TOKEN_KEY.test(key) ? "[redacted]" : stripTokens(entry, depth + 1);
  }
  return out;
}

/**
 * The provider's error body in full, for diagnostics.
 *
 * `reason` alone is not actionable: `rateLimitExceeded` is returned for several
 * distinct causes — per-user rate, per-project rate, the daily quota, too many
 * concurrent requests for one mailbox — which differ only in `error.message` and
 * `error.errors[].message`, and each has a different fix. So the body goes to the
 * log whole rather than being reduced to a status and a reason.
 *
 * Only the *response* is taken, never `config` or `request`: those carry the
 * Authorization header. Token-shaped keys inside the body are censored anyway.
 */
export function errorBodyOf(error: unknown): Record<string, unknown> | undefined {
  const e = asErrorish(error);
  const body: Record<string, unknown> = {};

  if (e.message !== undefined) body.message = e.message;
  if (e.errors !== undefined) body.errors = stripTokens(e.errors);
  if (e.response?.data !== undefined) body.data = stripTokens(e.response.data);
  // Flattened first: a `Headers` instance serializes to `{}`, so logging it
  // directly would have printed an empty object next to the body.
  const responseHeaders = headersToObject(e.response?.headers);
  if (responseHeaders !== undefined) {
    // Rate-limit headers explain the quota that was hit; the request headers,
    // which would carry the token, are not touched.
    body.responseHeaders = stripTokens(responseHeaders);
  }

  return Object.keys(body).length > 0 ? body : undefined;
}

/**
 * Worth trying again: rate limits (429, or 403 with a rate-limit reason) and
 * transient server faults. A 400/401/403-for-scope is a bug or a revoked grant,
 * and retrying it only delays the real error.
 */
export function isRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false;

  const status = statusOf(error);
  const reason = reasonOf(error);

  if (status === 429) return true;
  if (reason !== undefined && RATE_LIMIT_REASONS.has(reason)) return true;
  if (status !== undefined && status >= 500 && status <= 599) return true;

  // Socket-level faults: no HTTP status at all.
  const code = asErrorish(error).code;
  if (typeof code === "string") {
    return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"].includes(
      code,
    );
  }
  return false;
}

/** Reads `Retry-After` in either of its RFC forms: delta-seconds or HTTP-date. */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | null {
  const e = asErrorish(error);
  const value =
    headerValue(e.response?.headers, "retry-after") ??
    headerValue(e.headers, "retry-after");
  if (value === undefined) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }

  const date = Date.parse(String(value));
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * `min(ceiling, floor * 2^(attempt-1))`, then jitter as a multiplier on top.
 *
 * The result is never below the floor and never below the un-jittered delay — the
 * jitter only ever pushes a retry later, spreading a batch out instead of pulling
 * part of it forward into the window that just rejected it.
 */
export function backoffDelayMs(
  attempt: number,
  options: { minDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  const exponential = Math.min(
    options.maxDelayMs,
    options.minDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const jittered = exponential * (1 + options.random() * JITTER_RATIO);
  // The ceiling is a hard bound on the result, not just on the curve before jitter:
  // "exponential to 30s" should mean no retry ever waits longer than 30s.
  return Math.min(
    options.maxDelayMs,
    Math.max(options.minDelayMs, Math.round(jittered)),
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const minDelayMs = options.minDelayMs ?? DEFAULTS.minDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // A cancelled job must not keep retrying: its next attempt is already
      // running, and two attempts firing at once is what stacked the load.
      if (isAbortError(error) || options.signal?.aborted) break;
      if (!isRetryable(error) || attempt === attempts) break;

      const serverAsked = retryAfterMs(error);
      /*
       * A Retry-After replaces the curve outright — it is not clamped to
       * `maxDelayMs` and carries no jitter. The provider has told us when the
       * window reopens; coming back before that is a guaranteed rejection that
       * spends quota and extends the block, so "exponential to 30s" does not
       * apply here and a 47s wait is honoured as 47s.
       *
       * Two bounds remain, and neither is the curve's:
       *   - the floor, because `Retry-After: 0` is not an invitation to retry in
       *     the same millisecond;
       *   - `maxRetryAfterMs`, because a wait of minutes should not sit in-process
       *     holding a worker slot — past that it belongs to the queue's own
       *     job-level backoff, and the attempt fails so BullMQ reschedules it.
       */
      const delay =
        serverAsked === null
          ? backoffDelayMs(attempt, { minDelayMs, maxDelayMs, random })
          : Math.max(minDelayMs, Math.min(serverAsked, maxRetryAfterMs));

      logger.warn(
        {
          label: options.label,
          attempt,
          attempts,
          delayMs: delay,
          status: statusOf(error),
          reason: reasonOf(error),
          honoredRetryAfter: serverAsked !== null,
          providerError: errorBodyOf(error),
        },
        "provider call failed; backing off",
      );

      await sleep(delay, options.signal);
    }
  }

  if (!isAbortError(lastError) && !options.signal?.aborted) {
    logger.warn(
      {
        label: options.label,
        status: statusOf(lastError),
        reason: reasonOf(lastError),
        retryable: isRetryable(lastError),
        providerError: errorBodyOf(lastError),
      },
      "provider call giving up",
    );
  }

  throw toAppError(lastError, options.label);
}

/**
 * Turns an exhausted provider error into one of ours, so the error middleware and
 * the worker both see a typed failure. The provider's message is kept (it names
 * the API and reason) but nothing from the response body is attached.
 */
function toAppError(error: unknown, label: string): Error {
  if (isAbortError(error)) {
    return error instanceof Error ? error : new AbortedError();
  }

  const status = statusOf(error);
  const reason = reasonOf(error);
  const detail = {
    label,
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
  };

  if (status === 429 || (reason !== undefined && RATE_LIMIT_REASONS.has(reason))) {
    return new RateLimitError(`${label} exhausted retries against a rate limit`, detail);
  }
  if (isRetryable(error)) {
    return new UpstreamError(`${label} failed after retries`, detail);
  }
  // Not retryable: hand the original back so callers can match on it (a revoked
  // grant has to reach the token manager's invalid_grant handling intact).
  return error instanceof Error ? error : new UpstreamError(`${label} failed`, detail);
}

/**
 * Runs tasks with a ceiling on how many are in flight, stopping early if aborted.
 *
 * The cap is a quota decision as much as a memory one: each in-flight `threads.get`
 * is 10 quota units, so the ceiling here multiplies against the token bucket's
 * budget. Order of results matches order of inputs.
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  limit: number,
  task: (item: In, index: number) => Promise<Out>,
  signal?: AbortSignal,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        // Checked before each task, not only at the start: an abort part-way
        // through a page must stop the rest of that page being requested.
        if (signal?.aborted) throw new AbortedError();
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await task(items[index] as In, index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
