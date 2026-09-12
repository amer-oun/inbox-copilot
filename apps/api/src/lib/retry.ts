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
 *   1. `Retry-After` wins. When a provider tells us when to come back, guessing
 *      earlier just burns more quota and extends the block.
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
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
    data?: unknown;
  };
  errors?: { reason?: string; message?: string }[];
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
  const header = asErrorish(error).response?.headers?.["retry-after"];
  const value = Array.isArray(header) ? header[0] : header;
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
      const delay =
        serverAsked === null
          ? backoffDelayMs(attempt, { minDelayMs, maxDelayMs, random })
          : // Even an explicit Retry-After is held to the floor: a provider saying
            // "0" is not an invitation to retry in the same millisecond.
            Math.max(minDelayMs, Math.min(serverAsked, maxRetryAfterMs));

      logger.warn(
        {
          label: options.label,
          attempt,
          attempts,
          delayMs: delay,
          status: statusOf(error),
          reason: reasonOf(error),
          honoredRetryAfter: serverAsked !== null,
        },
        "provider call failed; backing off",
      );

      await sleep(delay, options.signal);
    }
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
