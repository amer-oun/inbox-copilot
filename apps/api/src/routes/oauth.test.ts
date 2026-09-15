import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * The OAuth callback is the one browser-facing API route, so every outcome must
 * be a redirect back to the web app — never a JSON error, never a stack trace,
 * and never an authorization code in a log.
 */

const consumeOAuthState = vi.hoisted(() => vi.fn());
const completeMailAccountConnect = vi.hoisted(() => vi.fn());

class FakeInvalidOAuthStateError extends Error {}

vi.mock("../lib/oauthState.js", () => ({
  consumeOAuthState,
  InvalidOAuthStateError: FakeInvalidOAuthStateError,
}));
vi.mock("../services/mailAccounts.js", () => ({
  completeMailAccountConnect,
  listMailAccounts: vi.fn(),
  startMailAccountConnect: vi.fn(),
  disconnectMailAccount: vi.fn(),
}));
vi.mock("@inbox-copilot/db", () => ({ pingDatabase: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  pingRedis: vi.fn(),
  redis: { set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));

const { createApp } = await import("../app.js");

const USER_ID = "cldd4kzai000008l3a1b2c3d4";

describe("GET /oauth/:provider/callback", () => {
  beforeEach(() => {
    consumeOAuthState.mockReset();
    completeMailAccountConnect.mockReset();
  });

  it("connects the mailbox and redirects with the address", async () => {
    consumeOAuthState.mockResolvedValue({
      userId: USER_ID,
      provider: "google",
      nonce: "n",
      exp: 1,
      v: 1,
    });
    completeMailAccountConnect.mockResolvedValue({
      emailAddress: "person@example.com",
    });

    const res = await request(createApp()).get(
      "/oauth/google/callback?code=auth-code&state=signed-state",
    );

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe(
      "http://localhost:3000/settings/accounts?connected=person%40example.com",
    );
    expect(completeMailAccountConnect).toHaveBeenCalledWith({
      userId: USER_ID,
      provider: "google",
      code: "auth-code",
      requestId: expect.any(String),
    });
  });

  it("rejects a state signed for the other provider", async () => {
    consumeOAuthState.mockResolvedValue({
      userId: USER_ID,
      provider: "microsoft",
      nonce: "n",
      exp: 1,
      v: 1,
    });

    const res = await request(createApp()).get(
      "/oauth/google/callback?code=auth-code&state=signed-state",
    );

    expect(res.headers["location"]).toContain("error=invalid_state");
    expect(completeMailAccountConnect).not.toHaveBeenCalled();
  });

  it("rejects a replayed or expired state", async () => {
    consumeOAuthState.mockRejectedValue(
      new FakeInvalidOAuthStateError("state already used or expired"),
    );

    const res = await request(createApp()).get(
      "/oauth/google/callback?code=auth-code&state=stale",
    );

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("error=invalid_state");
    expect(completeMailAccountConnect).not.toHaveBeenCalled();
  });

  it("never processes a callback with no state at all", async () => {
    const res = await request(createApp()).get("/oauth/google/callback?code=auth-code");

    expect(res.headers["location"]).toContain("error=invalid_state");
    expect(consumeOAuthState).not.toHaveBeenCalled();
    expect(completeMailAccountConnect).not.toHaveBeenCalled();
  });

  it("reports a declined consent screen as denied, not as a failure", async () => {
    const res = await request(createApp()).get(
      "/oauth/google/callback?error=access_denied&state=signed-state",
    );

    expect(res.headers["location"]).toContain("error=denied");
    expect(consumeOAuthState).not.toHaveBeenCalled();
  });

  it("maps any other provider error to provider_error", async () => {
    const res = await request(createApp()).get(
      "/oauth/microsoft/callback?error=server_error&state=signed-state",
    );

    expect(res.headers["location"]).toContain("error=provider_error");
  });

  it("redirects rather than 500s when the exchange throws", async () => {
    consumeOAuthState.mockResolvedValue({
      userId: USER_ID,
      provider: "google",
      nonce: "n",
      exp: 1,
      v: 1,
    });
    completeMailAccountConnect.mockRejectedValue(new Error("token endpoint exploded"));

    const res = await request(createApp()).get(
      "/oauth/google/callback?code=auth-code&state=signed-state",
    );

    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("error=failed");
    expect(res.text).not.toContain("token endpoint exploded");
  });
});
