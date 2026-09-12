import { logger } from "./logger.js";
import { RateLimitError, UpstreamError } from "./errors.js";

/**
 * Retry with exponential backoff and full jitter (§4 safety rails).
 *
 * Two rules that matter more than the curve:
 *   1. `Retry-After` wins. When a provider tells us when to come back, guessing
 *      earlier just burns more quota and extends the block.
 *   2. Jitter is not decoration. A backfill fans out across many threads; without
 *      jitter every retry lands in the same millisecond and re-triggers the limit.
 */

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Ceiling for a provider-supplied Retry-After; longer waits belong to the queue. */
  maxRetryAfterMs?: number;
  /** Label for log lines, e.g. "gmail.threads.get". */
  label: string;
  /** Injected in tests so they do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to make the jitter deterministic. */
  random?: () => number;
}

const DEFAULTS = {
  attempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
  maxRetryAfterMs: 120_000,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Gmail's rate-limit reasons, which arrive as 403 rather than 429. */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "backendError",
]);

interface GoogleApiErrorish {
  code?: number;
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
  return e.response?.status ?? e.status ?? e.code;
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
 * Full jitter: `random() * min(cap, base * 2^attempt)`. Preferred over
 * equal-jitter here because the retries we care about are a thundering herd of
 * identical thread fetches, and full jitter spreads them widest.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(options.random() * exponential);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
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

      if (!isRetryable(error) || attempt === attempts) break;

      const serverAsked = retryAfterMs(error);
      const delay =
        serverAsked === null
          ? backoffDelayMs(attempt, { baseDelayMs, maxDelayMs, random })
          : Math.min(serverAsked, maxRetryAfterMs);

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

      await sleep(delay);
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
  const status = statusOf(error);
  const reason = reasonOf(error);
  const detail = { label, ...(status === undefined ? {} : { status }), ...(reason === undefined ? {} : { reason }) };

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
 * Runs tasks with a ceiling on how many are in flight.
 *
 * A 90-day backfill is thousands of `threads.get` calls; firing them all at once
 * is the fastest way to a 429 and to an unbounded memory spike. Order of results
 * matches order of inputs.
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  limit: number,
  task: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index] as In, index);
    }
  });

  await Promise.all(workers);
  return results;
}
