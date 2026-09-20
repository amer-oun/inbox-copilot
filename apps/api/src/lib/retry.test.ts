import { describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  headerValue,
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
/**
 * Header representations a provider error can carry. `headers` is the default
 * because it is what production sees: Gaxios 7 is fetch-based, so the real error
 * holds a WHATWG `Headers`. The old plain-lowercase-record fixture is what let a
 * broken `headers["retry-after"]` lookup pass this suite for a whole phase.
 */
type HeaderStyle = "headers" | "record" | "mixedCaseRecord" | "arrayRecord";

function buildHeaders(style: HeaderStyle, retryAfter: string): unknown {
  switch (style) {
    case "headers":
      return new Headers({ "retry-after": retryAfter, "x-ratelimit-limit": "250" });
    case "record":
      return { "retry-after": retryAfter };
    case "mixedCaseRecord":
      // HTTP header names are case-insensitive; the lowercase spelling is a
      // client convention, not something the wire guarantees.
      return { "Retry-After": retryAfter };
    case "arrayRecord":
      return { "retry-after": [retryAfter, "99"] };
  }
}

function apiError(options: {
  status?: number;
  reason?: string;
  retryAfter?: string;
  code?: string;
  headerStyle?: HeaderStyle;
}): Error {
  const error = new Error(options.reason ?? `HTTP ${options.status ?? 500}`) as Error & {
    code?: string | number;
    response?: { status?: number; headers?: unknown; data?: unknown };
  };
  if (options.code !== undefined) error.code = options.code;
  if (options.status !== undefined || options.retryAfter !== undefined) {
    error.response = {
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.retryAfter === undefined
        ? {}
        : {
            headers: buildHeaders(options.headerStyle ?? "headers", options.retryAfter),
          }),
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
    expect(isRetryable(apiError({ status: 403, reason: "rateLimitExceeded" }))).toBe(
      true,
    );
    expect(isRetryable(apiError({ status: 403, reason: "userRateLimitExceeded" }))).toBe(
      true,
    );
  });

  it("retries 5xx and socket faults", () => {
    expect(isRetryable(apiError({ status: 503 }))).toBe(true);
    expect(isRetryable(apiError({ code: "ECONNRESET" }))).toBe(true);
  });

  it("does not retry a 403 that is about scope, not rate", () => {
    // Retrying a missing-scope error just delays the real failure.
    expect(
      isRetryable(apiError({ status: 403, reason: "insufficientPermissions" })),
    ).toBe(false);
  });

  it("does not retry 400, 401 or 404", () => {
    for (const status of [400, 401, 404]) {
      expect(isRetryable(apiError({ status }))).toBe(false);
    }
  });
});

describe("reasonOf", () => {
  it("reads the reason out of a nested Google error body", () => {
    expect(reasonOf(apiError({ status: 403, reason: "quotaExceeded" }))).toBe(
      "quotaExceeded",
    );
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

  it("reads a WHATWG Headers instance, which is what Gaxios 7 actually sends", () => {
    // Regression: bracket access on Headers is undefined, so this returned null
    // for every real 429 while the fixtures said otherwise.
    const error = apiError({ status: 429, retryAfter: "47", headerStyle: "headers" });
    expect(retryAfterMs(error)).toBe(47_000);
  });

  it("is case-insensitive on a plain record", () => {
    expect(
      retryAfterMs(
        apiError({ status: 429, retryAfter: "12", headerStyle: "mixedCaseRecord" }),
      ),
    ).toBe(12_000);
  });

  it("takes the first value when a record repeats the header", () => {
    expect(
      retryAfterMs(
        apiError({ status: 429, retryAfter: "8", headerStyle: "arrayRecord" }),
      ),
    ).toBe(8_000);
  });

  it("treats a Headers miss as absent rather than as the string 'null'", () => {
    const error = new Error("429") as Error & { response?: { headers?: unknown } };
    error.response = { headers: new Headers({ "x-ratelimit-limit": "250" }) };
    expect(retryAfterMs(error)).toBeNull();
  });
});

describe("headerValue", () => {
  it("reads through Headers, records and mixed casing alike", () => {
    expect(headerValue(new Headers({ "retry-after": "5" }), "retry-after")).toBe("5");
    expect(headerValue({ "Retry-After": "5" }, "retry-after")).toBe("5");
    expect(headerValue({ "retry-after": ["5", "9"] }, "retry-after")).toBe("5");
  });

  it("is undefined for missing headers and non-objects", () => {
    expect(headerValue(new Headers(), "retry-after")).toBeUndefined();
    expect(headerValue(undefined, "retry-after")).toBeUndefined();
    expect(headerValue(null, "retry-after")).toBeUndefined();
    expect(headerValue("not headers", "retry-after")).toBeUndefined();
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

  it("waits longer than the 30s curve ceiling when Retry-After says so", async () => {
    // The ceiling bounds the *curve*. A provider-supplied wait is not a guess to
    // be capped: coming back at 30s when Gmail said 47 is a certain rejection.
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ status: 429, retryAfter: "47" }))
      .mockResolvedValue("ok");

    await withRetry(fn, {
      label: "test",
      sleep,
      minDelayMs: 1_000,
      maxDelayMs: 30_000,
    });

    expect(sleep).toHaveBeenCalledWith(47_000, undefined);
  });

  it("does not jitter a Retry-After", async () => {
    // random() => 1 would add 50% to a curve delay; the server's number is exact.
    const sleep = vi.fn(noSleep);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError({ status: 429, retryAfter: "20" }))
      .mockResolvedValue("ok");

    await withRetry(fn, { label: "test", sleep, random: () => 1 });
    expect(sleep).toHaveBeenCalledWith(20_000, undefined);
  });

  it("reports honoredRetryAfter for a real Headers instance", async () => {
    // The symptom that exposed the bug was this flag reading false on every
    // failure while the response carried the header.
    const error = apiError({ status: 429, retryAfter: "47", headerStyle: "headers" });
    const sleep = vi.fn(noSleep);
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok");

    await withRetry(fn, { label: "test", sleep });

    // 47s is only reachable via the header: the curve's first delay is 1s.
    expect(sleep).toHaveBeenCalledWith(47_000, undefined);
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
    ).rejects.toSatisfy(
      (thrown: unknown) => !JSON.stringify(thrown).includes("quota-token-abc"),
    );
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      5,
      async (item) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return item;
      },
    );

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
