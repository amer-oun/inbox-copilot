import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Rule 3, for logs rather than responses.
 *
 * An OAuth authorization code is a one-time credential that arrives in the query
 * string of the callback, and pino-http logs request URLs by default — this file
 * is what caught that. It drives the app through every callback outcome with a
 * known code in the URL and asserts no emitted log line contains it.
 *
 * Unlike the other route tests, the logger here is a REAL pino instance writing
 * into an array: the thing under test is the transport wiring in `createApp()`,
 * so stubbing the logger away would test nothing. `redactUrl` is the real one.
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

vi.mock("../lib/logger.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/logger.js")>("../lib/logger.js");
  const { pino } = await import("pino");
  return {
    ...actual,
    // trace level: nothing may be hidden from this test by a level filter.
    logger: pino({ level: "trace" }, sink.stream),
  };
});

const consumeOAuthState = vi.hoisted(() => vi.fn());
const completeMailAccountConnect = vi.hoisted(() => vi.fn());
const startMailAccountConnect = vi.hoisted(() => vi.fn());

class FakeInvalidOAuthStateError extends Error {}

vi.mock("../lib/oauthState.js", () => ({
  consumeOAuthState,
  InvalidOAuthStateError: FakeInvalidOAuthStateError,
}));
vi.mock("../services/mailAccounts.js", () => ({
  completeMailAccountConnect,
  startMailAccountConnect,
  listMailAccounts: vi.fn(),
  disconnectMailAccount: vi.fn(),
}));
vi.mock("@inbox-copilot/db", () => ({ pingDatabase: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  pingRedis: vi.fn(),
  redis: { set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));

const { createApp } = await import("../app.js");

/** Distinctive enough that a substring match cannot be a false negative. */
const CODE = "4%2F0AX4XfWjZZZ-authorization-code-must-never-be-logged";
const DECODED_CODE = "4/0AX4XfWjZZZ-authorization-code-must-never-be-logged";
const CODE_FRAGMENT = "authorization-code-must-never-be-logged";

const USER_ID = "cldd4kzai000008l3a1b2c3d4";

const VALID_STATE = {
  v: 1,
  userId: USER_ID,
  provider: "google",
  nonce: "nonce",
  exp: Math.floor(Date.now() / 1000) + 60,
};

function loggedOutput(): string {
  return sink.lines.join("");
}

/** Fails loudly if the request produced no log line — otherwise this all passes vacuously. */
function expectSomethingWasLogged(): void {
  expect(sink.lines.length).toBeGreaterThan(0);
}

function expectNoCodeAnywhere(): void {
  const output = loggedOutput();
  expect(output).not.toContain(CODE_FRAGMENT);
  expect(output).not.toContain(DECODED_CODE);
  expect(output).not.toContain(CODE);
}

describe("the OAuth callback code never reaches a log line", () => {
  beforeEach(() => {
    sink.lines.length = 0;
    consumeOAuthState.mockReset();
    completeMailAccountConnect.mockReset();
    startMailAccountConnect.mockReset();
  });

  it("logs the request but not the code on a successful connect", async () => {
    consumeOAuthState.mockResolvedValue(VALID_STATE);
    completeMailAccountConnect.mockResolvedValue({
      emailAddress: "person@example.com",
    });

    const res = await request(createApp()).get(
      `/oauth/google/callback?code=${CODE}&state=signed-state`,
    );

    expect(res.status).toBe(302);
    expectSomethingWasLogged();
    // Proof the completion line really was emitted for this URL...
    expect(loggedOutput()).toContain("/oauth/google/callback");
    // ...with the credential replaced rather than the line dropped.
    expect(loggedOutput()).toContain("redacted");
    expectNoCodeAnywhere();
  });

  it("does not log the code when the state is rejected", async () => {
    consumeOAuthState.mockRejectedValue(
      new FakeInvalidOAuthStateError("state already used or expired"),
    );

    await request(createApp()).get(`/oauth/google/callback?code=${CODE}&state=replayed`);

    expectSomethingWasLogged();
    // This path logs a warning of its own; it must stay code-free too.
    expect(loggedOutput()).toContain("rejected oauth callback state");
    expectNoCodeAnywhere();
  });

  it("does not log the code when the token exchange throws", async () => {
    consumeOAuthState.mockResolvedValue(VALID_STATE);
    completeMailAccountConnect.mockRejectedValue(new Error("token endpoint exploded"));

    await request(createApp()).get(
      `/oauth/google/callback?code=${CODE}&state=signed-state`,
    );

    expectSomethingWasLogged();
    expect(loggedOutput()).toContain("failed to complete mailbox connection");
    expectNoCodeAnywhere();
  });

  it("does not log the code when the provider reports an error alongside it", async () => {
    await request(createApp()).get(
      `/oauth/google/callback?error=access_denied&code=${CODE}&state=signed-state`,
    );

    expectSomethingWasLogged();
    expectNoCodeAnywhere();
  });

  it("does not log the code on an unroutable path (404 handler)", async () => {
    await request(createApp()).get(`/oauth/yahoo/callback?code=${CODE}&state=s`);

    expectSomethingWasLogged();
    expectNoCodeAnywhere();
  });

  it("does not log the code on a validation failure (error middleware)", async () => {
    // Unknown provider slug: the params schema throws, the error middleware logs.
    await request(createApp())
      .post(`/mail-accounts/yahoo/connect?code=${CODE}`)
      .set("authorization", "Bearer not-a-real-token");

    expectSomethingWasLogged();
    expectNoCodeAnywhere();
  });

  it("does not log the code when it arrives in an unexpected parameter name", async () => {
    consumeOAuthState.mockRejectedValue(new FakeInvalidOAuthStateError("nope"));

    await request(createApp()).get(
      `/oauth/google/callback?authuser=0&code=${CODE}&scope=email&state=s`,
    );

    expectSomethingWasLogged();
    expectNoCodeAnywhere();
    // Non-sensitive parameters are still logged — redaction is targeted, not a
    // blanket drop of the query string, which would make logs useless.
    expect(loggedOutput()).toContain("authuser=0");
  });

  it("keeps the redaction when the code is the only query parameter", async () => {
    await request(createApp()).get(`/oauth/google/callback?code=${CODE}`);

    expectSomethingWasLogged();
    expectNoCodeAnywhere();
  });

  it("redacts an id_token or access_token arriving on the callback", async () => {
    consumeOAuthState.mockRejectedValue(new FakeInvalidOAuthStateError("nope"));

    await request(createApp()).get(
      "/oauth/google/callback?state=s&id_token=ID-TOKEN-VALUE&access_token=ACCESS-TOKEN-VALUE",
    );

    expectSomethingWasLogged();
    expect(loggedOutput()).not.toContain("ID-TOKEN-VALUE");
    expect(loggedOutput()).not.toContain("ACCESS-TOKEN-VALUE");
  });

  it("logs no authorization header or cookie for the callback request", async () => {
    consumeOAuthState.mockResolvedValue(VALID_STATE);
    completeMailAccountConnect.mockResolvedValue({
      emailAddress: "person@example.com",
    });

    await request(createApp())
      .get(`/oauth/google/callback?code=${CODE}&state=signed-state`)
      .set("cookie", "session-token=COOKIE-VALUE")
      .set("authorization", "Bearer HEADER-VALUE");

    expectSomethingWasLogged();
    expect(loggedOutput()).not.toContain("COOKIE-VALUE");
    expect(loggedOutput()).not.toContain("HEADER-VALUE");
    expectNoCodeAnywhere();
  });
});
