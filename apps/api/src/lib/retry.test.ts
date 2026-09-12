import { describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  isRetryable,
  mapWithConcurrency,
  reasonOf,
  retryAfterMs,
  withRetry,
} from "./retry.js";
import { RateLimitError, UnauthorizedError, UpstreamError } from "./errors.js";

/**
 * Backoff behaviour, tested without sleeping: `sleep` and `random` are injected so
 * the delays are asserted as values rather than waited on.
 */

/** Shapes a googleapis error the way the library actually throws them. */
function apiError(options: {
  status?: number;
  reason?: string;
  retryAfter?: string;
  code?: string;
}): Error {
  const error = new Error(options.reason ?? `HTTP ${options.status ?? 500}`) as Error & {
    code?: string | number;
    response?: { status?: number; headers?: Record<string, string>; data?: unknown };
  };
  if (options.code !== undefined) error.code = options.code;
  if (options.status !== undefined || options.retryAfter !== undefined) {
    error.response = {
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.retryAfter === undefined ? {} : { headers: { "retry-after": options.retryAfter } }),
      ...(options.reason === undefined
        ? {}
        : { data: { error: { errors: [{ reason: options.reason }] } } }),
    };
  }
  return error;
}

const noSleep = async (): Promise<void> => undefined;

describe("isRetryable", () => {
  it("retries a 429", () => {
    expect(isRetryable(apiError({ status: 429 }))).toBe(true);
  });

  it("retries Gmail's rateLimitExceeded, which arrives as a 403", () => {
    expect(isRetryable(apiError({ status: 403, reason: "rateLimitExceeded" }))).toBe(true);
    expect(isRetryable(apiError({ status: 403, reason: "userRateLimitExceeded" }))).toBe(true);
  });

  it("retries 5xx and socket faults", () => {
    expect(isRetryable(apiError({ status: 503 }))).toBe(true);
    expect(isRetryable(apiError({ code: "ECONNRESET" }))).toBe(true);
  });

  it("does not retry a 403 that is about scope, not rate", () => {
    // Retrying a missing-scope error just delays the real failure.
    expect(isRetryable(apiError({ status: 403, reason: "insufficientPermissions" }))).toBe(false);
  });

  it("does not retry 400, 401 or 404", () => {
    for (const status of [400, 401, 404]) {
      expect(isRetryable(apiError({ status }))).toBe(false);
    }
  });
});

describe("reasonOf", () => {
  it("reads the reason out of a nested Google error body", () => {
    expect(reasonOf(apiError({ status: 403, reason: "quotaExceeded" }))).toBe("quotaExceeded");
  });

  it("returns undefined when there is no reason", () => {
    expect(reasonOf(new Error("boom"))).toBeUndefined();
  });
});

describe("retryAfterMs", () => {
  it("reads delta-seconds", () => {
    expect(retryAfterMs(apiError({ status: 429, retryAfter: "30" }))).toBe(30_000);
  });

  it("reads an HTTP-date", () => {
    const now = Date.parse("2025-03-03T12:00:00Z");
    const error = apiError({ status: 429, retryAfter: "Mon, 03 Mar 2025 12:00:45 GMT" });
    expect(retryAfterMs(error, now)).toBe(45_000);
  });

  it("never returns a negative wait for a date in the past", () => {
    const now = Date.parse("2025-03-03T12:00:00Z");
    const error = apiError({ status: 429, retryAfter: "Mon, 03 Mar 2025 11:00:00 GMT" });
    expect(retryAfterMs(error, now)).toBe(0);
  });

  it("returns null when the header is absent or unparseable", () => {
    expect(retryAfterMs(apiError({ status: 429 }))).toBeNull();
    expect(retryAfterMs(apiError({ status: 429, retryAfter: "soon" }))).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and is capped", () => {
    const options = { baseDelayMs: 500, maxDelayMs: 4_000, random: () => 1 };
    expect(backoffDelayMs(1, options)).toBe(500);
    expect(backoffDelayMs(2, options)).toBe(1_000);
    expect(backoffDelayMs(3, options)).toBe(2_000);
    expect(backoffDelayMs(9, options)).toBe(4_000);
  });

  it("applies full jitter, so two clients do not retry in lockstep", () => {
    const options = { baseDelayMs: 1_000, maxDelayMs: 8_000, random: () => 0.25 };
    expect(backoffDelayMs(3, options)).toBe(1_000);
  });
});

describe("withRetry", () => {
  it("returns the first successful result without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withRetry(fn, { label: "test", sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a rate limit and succeeds", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ status: 429 }))
      .mockResolvedValue("ok");

    await expect(
      withRetry(fn, { label: "test", sleep, random: () => 1, baseDelayMs: 100 }),
    ).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("honours Retry-After over its own backoff curve", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ status: 429, retryAfter: "7" }))
      .mockResolvedValue("ok");

    await withRetry(fn, { label: "test", sleep, random: () => 1, baseDelayMs: 100 });
    expect(sleep).toHaveBeenCalledWith(7_000);
  });

  it("caps an absurd Retry-After rather than blocking the worker for an hour", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ status: 429, retryAfter: "3600" }))
      .mockResolvedValue("ok");

    await withRetry(fn, { label: "test", sleep, maxRetryAfterMs: 60_000 });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("gives up after the attempt budget and reports a rate limit as one", async () => {
    const fn = vi.fn().mockRejectedValue(apiError({ status: 429 }));

    await expect(
      withRetry(fn, { label: "gmail.threads.get", attempts: 3, sleep: noSleep }),
    ).rejects.toThrow(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("reports an exhausted 5xx as an upstream failure", async () => {
    const fn = vi.fn().mockRejectedValue(apiError({ status: 503 }));

    await expect(
      withRetry(fn, { label: "gmail.threads.list", attempts: 2, sleep: noSleep }),
    ).rejects.toThrow(UpstreamError);
  });

  it("does not retry a non-retryable error and passes it through untouched", async () => {
    // The token manager matches on specific error types, so wrapping would break
    // the revoked-grant path.
    const original = new UnauthorizedError("no");
    const fn = vi.fn().mockRejectedValue(original);

    await expect(withRetry(fn, { label: "test", sleep: noSleep })).rejects.toBe(original);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not leak a provider response body into the thrown error", async () => {
    const error = apiError({ status: 429 });
    (error as { response?: { status?: number; data?: unknown } }).response = {
      status: 429,
      data: { secret: "quota-token-abc" },
    };
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(fn, { label: "test", attempts: 2, sleep: noSleep }),
    ).rejects.toSatisfy((thrown: unknown) => !JSON.stringify(thrown).includes("quota-token-abc"));
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 5, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return item;
    });

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves input order in the results", async () => {
    const out = await mapWithConcurrency([3, 1, 2], 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("handles an empty input", async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
  });

  it("propagates a task failure", async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (item) => {
        if (item === 2) throw new Error("task failed");
        return item;
      }),
    ).rejects.toThrow("task failed");
  });
});
