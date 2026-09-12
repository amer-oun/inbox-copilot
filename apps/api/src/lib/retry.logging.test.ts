import { describe, expect, it, vi } from "vitest";

/**
 * The diagnostic log line, asserted against a real pino instance.
 *
 * `reason: "rateLimitExceeded"` is returned for several unrelated causes, so the
 * fix depends on the rest of the body. These tests pin that the whole body
 * survives serialization — a nested `error.errors[].message` included — because
 * the failure mode being guarded against is a log line that is technically
 * present and diagnostically useless.
 *
 * The logger is real, not a spy: pino's own redaction and depth handling are part
 * of what decides whether the body actually arrives.
 */

const sink = vi.hoisted(() => {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  };
});

vi.mock("./logger.js", async () => {
  const actual = await vi.importActual<typeof import("./logger.js")>("./logger.js");
  const { pino } = await import("pino");
  return {
    ...actual,
    logger: pino(
      { level: "trace", redact: { paths: ["*.accessToken"], censor: "[redacted]" } },
      sink.stream,
    ),
  };
});

const { errorBodyOf, withRetry } = await import("./retry.js");

/** A Gaxios-shaped 403 with the body Gmail actually returns. */
function gmailRateLimitError(): Error & Record<string, unknown> {
  const error = new Error(
    "Too many concurrent requests for user. Retry after 2026-09-12T10:00:00Z",
  ) as Error & Record<string, unknown>;
  error.code = 403;
  error.response = {
    status: 403,
    headers: { "content-type": "application/json" },
    data: {
      error: {
        code: 403,
        message: "Too many concurrent requests for user.",
        errors: [
          {
            domain: "usageLimits",
            reason: "rateLimitExceeded",
            message: "Too many concurrent requests for user.",
          },
        ],
        status: "PERMISSION_DENIED",
      },
    },
  };
  return error;
}

function emitted(): string {
  return sink.lines.join("\n");
}

describe("errorBodyOf", () => {
  it("keeps message, errors[].reason and errors[].message", () => {
    const body = errorBodyOf(gmailRateLimitError());
    const data = body?.data as { error: { message: string; errors: unknown[] } };

    expect(body?.message).toContain("Too many concurrent requests");
    expect(data.error.message).toBe("Too many concurrent requests for user.");
    expect(data.error.errors[0]).toMatchObject({
      reason: "rateLimitExceeded",
      domain: "usageLimits",
      message: "Too many concurrent requests for user.",
    });
  });

  it("keeps response headers, which carry the quota that was hit", () => {
    const error = gmailRateLimitError();
    (error.response as { headers: Record<string, string> }).headers["retry-after"] = "30";

    const body = errorBodyOf(error);

    expect(body?.responseHeaders).toMatchObject({ "retry-after": "30" });
  });

  it("censors token-shaped keys at any depth, where pino's wildcards cannot", () => {
    const error = new Error("boom") as Error & Record<string, unknown>;
    error.response = {
      data: {
        error: {
          nested: {
            access_token: "ya29.super-secret",
            refreshToken: "1//also-secret",
            id_token: "eyJ-secret",
            message: "kept",
          },
        },
      },
    };

    const serialized = JSON.stringify(errorBodyOf(error));

    expect(serialized).not.toContain("ya29.super-secret");
    expect(serialized).not.toContain("1//also-secret");
    expect(serialized).not.toContain("eyJ-secret");
    expect(serialized).toContain("kept");
  });

  it("falls back to the message for a socket error with no response body", () => {
    // No body to read, but the message is the only diagnostic such a failure has.
    expect(errorBodyOf(new Error("socket hang up"))).toEqual({
      message: "socket hang up",
    });
  });

  it("returns undefined when there is nothing at all to report", () => {
    expect(errorBodyOf("a bare string")).toBeUndefined();
  });

  it("never touches request config, which carries the Authorization header", () => {
    const error = gmailRateLimitError();
    error.config = { headers: { Authorization: "Bearer ya29.leaked" } };

    expect(JSON.stringify(errorBodyOf(error))).not.toContain("ya29.leaked");
  });
});

describe("withRetry diagnostic logging", () => {
  it("logs the full body on every backoff and again when giving up", async () => {
    sink.lines.length = 0;

    await expect(
      withRetry(
        async () => {
          throw gmailRateLimitError();
        },
        {
          label: "gmail.users.threads.get",
          attempts: 2,
          sleep: async () => {},
          random: () => 0,
        },
      ),
    ).rejects.toThrow();

    const log = emitted();
    expect(log).toContain("provider call failed; backing off");
    expect(log).toContain("provider call giving up");
    // The distinguishing detail, not just the reason.
    expect(log).toContain("Too many concurrent requests for user.");
    expect(log).toContain("PERMISSION_DENIED");
    expect(log).toContain("usageLimits");

    const lines = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.every((line) => line.level === 40)).toBe(true);
    const giveUp = lines.at(-1) as { providerError: { data: unknown }; retryable: boolean };
    expect(giveUp.retryable).toBe(true);
    expect(giveUp.providerError.data).toBeDefined();
  });

  it("logs the body for a non-retryable failure, which previously logged nothing", async () => {
    sink.lines.length = 0;
    const error = new Error("Precondition check failed.") as Error & Record<string, unknown>;
    error.code = 400;
    error.response = {
      status: 400,
      data: { error: { code: 400, message: "Precondition check failed.", errors: [{ reason: "failedPrecondition" }] } },
    };

    await expect(
      withRetry(
        async () => {
          throw error;
        },
        { label: "gmail.users.history.list", sleep: async () => {} },
      ),
    ).rejects.toThrow("Precondition check failed.");

    const log = emitted();
    expect(log).toContain("provider call giving up");
    expect(log).toContain("failedPrecondition");
    expect(JSON.parse(sink.lines.at(-1) as string).retryable).toBe(false);
  });

  it("does not log a give-up line when the work was cancelled", async () => {
    // An abort is not a provider failure and there is no body to diagnose.
    sink.lines.length = 0;
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(
        async () => {
          throw new DOMException("aborted", "AbortError");
        },
        { label: "gmail.users.threads.list", signal: controller.signal },
      ),
    ).rejects.toThrow();

    expect(emitted()).not.toContain("giving up");
  });
});
