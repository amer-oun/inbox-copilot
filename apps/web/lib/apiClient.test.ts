// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { z } from "zod";

/**
 * The BFF's half of the session split, and how it reads a sleeping API.
 *
 * The token must say which kind of session it carries — the API refuses a mismatch —
 * and a host that is still waking the API must come back as `ApiUnavailableError`, the
 * one failure a page answers with "Starting up" instead of an error.
 */

vi.mock("server-only", () => ({}));

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

vi.mock("./env", () => ({
  env: {
    API_BASE_URL: "https://api.example.test",
    INTERNAL_JWT_PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
    INTERNAL_JWT_ISSUER: "inbox-copilot-web",
    INTERNAL_JWT_AUDIENCE: "inbox-copilot-api",
  },
}));

const { ApiError, ApiUnavailableError, apiFetch } = await import("./apiClient");

const fetchMock = vi.fn();
const USER = { userId: "cldd4kzai000008l3a1b2c3d4" };
const DEMO = {
  userId: "cdemouser0000000000000001",
  demoSessionId: "visit_aaaaaaaaaaaaaaaa",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bearerClaims(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  const header = (init.headers as Record<string, string>)["authorization"] ?? "";
  return decodeJwt(header.replace("Bearer ", ""));
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(json(200, { ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the session claim", () => {
  it("marks a real account's token as a user session", async () => {
    await apiFetch(USER, "/threads", z.unknown());

    const claims = bearerClaims();
    expect(claims.sub).toBe(USER.userId);
    expect(claims["ses"]).toBe("user");
    expect(claims).not.toHaveProperty("sid");
  });

  it("marks a demo visit's token as demo, with the visit id", async () => {
    await apiFetch(DEMO, "/threads", z.unknown());

    const claims = bearerClaims();
    expect(claims.sub).toBe(DEMO.userId);
    expect(claims["ses"]).toBe("demo");
    expect(claims["sid"]).toBe(DEMO.demoSessionId);
  });
});

describe("a sleeping API", () => {
  it("reads a refused connection as unavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(apiFetch(USER, "/threads", z.unknown())).rejects.toBeInstanceOf(
      ApiUnavailableError,
    );
  });

  it("reads the host's own 502/503 page as unavailable", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>Service waking up</html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(apiFetch(USER, "/threads", z.unknown())).rejects.toBeInstanceOf(
      ApiUnavailableError,
    );
  });

  it("keeps the API's own 503 as the error it is", async () => {
    fetchMock.mockResolvedValue(
      json(503, { error: { code: "PUSH_NOT_CONFIGURED", message: "No topic" } }),
    );

    const error = await apiFetch(USER, "/threads", z.unknown()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ApiUnavailableError);
    expect(error).toMatchObject({ code: "PUSH_NOT_CONFIGURED" });
  });

  it("gives reads a timeout short enough to beat the platform's", async () => {
    await apiFetch(USER, "/threads", z.unknown());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
