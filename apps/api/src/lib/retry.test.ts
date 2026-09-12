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
import { AbortedError } from "./retry.js";

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
  /** No jitter, so the curve itself is visible. */
  const noJitter = { minDelayMs: 1_000, maxDelayMs: 30_000, random: () => 0 };

  it("starts at the floor and doubles up to the ceiling", () => {
    expect(backoffDelayMs(1, noJitter)).toBe(1_000);
    expect(backoffDelayMs(2, noJitter)).toBe(2_000);
    expect(backoffDelayMs(3, noJitter)).toBe(4_000);
    expect(backoffDelayMs(6, noJitter)).toBe(30_000);
    expect(backoffDelayMs(20, noJitter)).toBe(30_000);
  });

  it("never returns less than the floor, whatever the jitter rolls", () => {
    // The bug this replaces: full jitter (random() * delay) produced ~5ms retries,
    // which is not a backoff at all.
    for (const roll of [0, 0.01, 0.5, 0.999]) {
      const delay = backoffDelayMs(1, { ...noJitter, random: () => roll });
      expect(delay).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("applies jitter as a multiplier on top, so it only ever delays further", () => {
    const jittered = backoffDelayMs(2, { ...noJitter, random: () => 1 });
    expect(jittered).toBe(3_000); // 2000 * (1 + 0.5)
    expect(jittered).toBeGreaterThan(backoffDelayMs(2, noJitter));
  });

  it("never exceeds the ceiling, jitter included", () => {
    for (const roll of [0, 0.5, 1]) {
      for (const attempt of [1, 5, 6, 12]) {
        expect(
          backoffDelayMs(attempt, { ...noJitter, random: () => roll }),
        ).toBeLessThanOrEqual(30_000);
      }
    }
  });

  it("spreads a batch out rather than pulling any of it forward", () => {
    const delays = [0.1, 0.4, 0.9].map((roll) =>
      backoffDelayMs(3, { ...noJitter, random: () => roll }),
    );
    expect(new Set(delays).size).toBe(3);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(4_000);
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
      withRetry(fn, { label: "test", sleep, random: () => 0, minDelayMs: 1_000 }),
    ).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
  });

  it("honours Retry-After over its own backoff curve", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ status: 429, retryAfter: "7" }))
      .mockResolvedValue("ok");

    await withRetry(fn, { label: "test", sleep, random: () => 1, minDelayMs: 1_000 });
    expect(sleep).toHaveBeenCalledWith(7_000, undefined);
  });

  it("caps an absurd Retry-After rather than blocking the worker for an hour", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ status: 429, retryAfter: "3600" }))
      .mockResolvedValue("ok");

    await withRetry(fn, { label: "test", sleep, maxRetryAfterMs: 60_000 });
    expect(sleep).toHaveBeenCalledWith(60_000, undefined);
  });

  it("holds a Retry-After of zero to the floor", async () => {
    // A provider answering "retry after 0 seconds" is not an invitation to retry in
    // the same millisecond.
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ status: 429, retryAfter: "0" }))
      .mockResolvedValue("ok");

    await withRetry(fn, { label: "test", sleep, minDelayMs: 1_000 });
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
  });

  it("stops retrying once the signal is aborted", async () => {
    // The whole point of cancellation: a retried job must not have its predecessor
    // still firing requests beside it.
    const controller = new AbortController();
    const fn = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw apiError({ status: 429 });
    });

    await expect(
      withRetry(fn, { label: "test", sleep: noSleep, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry an abort error itself", async () => {
    const abort = new AbortedError();
    const fn = vi.fn().mockRejectedValue(abort);

    await expect(withRetry(fn, { label: "test", sleep: noSleep })).rejects.toBe(abort);
    expect(fn).toHaveBeenCalledTimes(1);
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

  it("stops launching tasks once aborted", async () => {
    const controller = new AbortController();
    const started: number[] = [];

    await expect(
      mapWithConcurrency(
        [1, 2, 3, 4, 5, 6],
        2,
        async (item) => {
          started.push(item);
          if (started.length === 2) controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 1));
          return item;
        },
        controller.signal,
      ),
    ).rejects.toThrow(AbortedError);

    // The remaining items are never requested — that is the quota saved.
    expect(started.length).toBeLessThan(6);
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
