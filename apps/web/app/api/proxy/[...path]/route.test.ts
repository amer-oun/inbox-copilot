import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The BFF proxy's allowlists.
 *
 * Worth testing directly because this file is the whole answer to "what can a page in
 * the browser cause the API to do?" — and since phase 6 one of those things sends mail
 * from the user's own address.
 */

const apiFetch = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => vi.fn());

class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

vi.mock("../../../../lib/apiClient", () => ({ apiFetch, ApiError: FakeApiError }));
vi.mock("../../../../auth", () => ({ auth }));

const { GET, POST } = await import("./route");

const ORIGIN = "https://app.example.test";
const USER_ID = "cldd4kzai000008l3a1b2c3d4";
const THREAD_ID = "cldd4kzai000108l3a1b2c3d4";
const MESSAGE_ID = "cldd4kzai000308l3a1b2c3d4";

function params(path: string): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: path.split("/") }) };
}

function get(path: string, query = ""): Request {
  return new Request(`${ORIGIN}/api/proxy/${path}${query}`);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/proxy/${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ user: { id: USER_ID } });
  apiFetch.mockReset().mockResolvedValue({ ok: true });
});

describe("reads", () => {
  it("proxies the allowlisted paths", async () => {
    for (const path of ["threads", `threads/${THREAD_ID}`, "writing-style"]) {
      const response = await GET(get(path), params(path));
      expect(response.status).toBe(200);
    }
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it("forwards only the query parameters the API has", async () => {
    await GET(
      get("threads", "?category=WORK&cursor=abc&limit=10&userId=someone-else&sql=drop"),
      params("threads"),
    );

    const target = apiFetch.mock.calls[0]?.[1] as string;
    expect(target).toContain("category=WORK");
    expect(target).toContain("cursor=abc");
    expect(target).not.toContain("userId");
    expect(target).not.toContain("sql");
  });

  it("refuses a path that is not proxied", async () => {
    const response = await GET(get("mail-accounts"), params("mail-accounts"));

    expect(response.status).toBe(404);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    auth.mockResolvedValue(null);
    const response = await GET(get("threads"), params("threads"));

    expect(response.status).toBe(401);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("never lets a response be cached by a shared cache", async () => {
    const response = await GET(get("threads"), params("threads"));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("writes", () => {
  it("proxies drafting, sending, composing, the style rebuild and a threat appeal", async () => {
    const paths = [
      `threads/${THREAD_ID}/replies`,
      `threads/${THREAD_ID}/reply`,
      "compose",
      "writing-style",
      `messages/${MESSAGE_ID}/threat-appeal`,
    ];

    for (const path of paths) {
      const response = await POST(post(path, { body: "ok" }), params(path));
      expect(response.status).toBe(200);
    }

    expect(apiFetch).toHaveBeenCalledTimes(paths.length);
    expect(apiFetch.mock.calls[0]?.[3]).toMatchObject({ method: "POST" });
  });

  it("forwards the body untouched, because the API validates it", async () => {
    await POST(
      post(`threads/${THREAD_ID}/reply`, { body: "Sending today.", draftId: "d_1" }),
      params(`threads/${THREAD_ID}/reply`),
    );

    expect(apiFetch.mock.calls[0]?.[3]).toMatchObject({
      method: "POST",
      body: { body: "Sending today.", draftId: "d_1" },
    });
  });

  it("does not proxy a path that would set a verdict", async () => {
    /*
     * The appeal is the only threat write the browser can reach, and this list is where
     * that stays true. There is no API route behind these either — the point of asserting
     * it here as well is that the BFF must not become the place a new one quietly appears.
     */
    for (const path of [
      `messages/${MESSAGE_ID}/threat`,
      `messages/${MESSAGE_ID}/threat-level`,
      `threads/${THREAD_ID}/threat`,
    ]) {
      const response = await POST(post(path, { level: "SAFE" }), params(path));
      expect(response.status).toBe(404);
    }

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin write", async () => {
    /*
     * The session cookie is SameSite=Lax, so such a request arrives unauthenticated
     * anyway. This is the second lock, and it is here because of what is behind the
     * door: a cross-site POST that did carry a session could send mail.
     */
    const response = await POST(
      post(`threads/${THREAD_ID}/reply`, { body: "ok" }, { origin: "https://evil.test" }),
      params(`threads/${THREAD_ID}/reply`),
    );

    expect(response.status).toBe(403);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses a write with no Origin header at all", async () => {
    const request = new Request(`${ORIGIN}/api/proxy/compose`, {
      method: "POST",
      body: "{}",
    });

    expect((await POST(request, params("compose"))).status).toBe(403);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("refuses to post to a path that is not on the write list", async () => {
    for (const path of ["threads", `threads/${THREAD_ID}`, "mail-accounts/x/sync", "send"]) {
      const response = await POST(post(path, {}), params(path));
      expect(response.status).toBe(404);
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    auth.mockResolvedValue(null);
    const path = `threads/${THREAD_ID}/reply`;

    expect((await POST(post(path, { body: "ok" }), params(path))).status).toBe(401);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const request = new Request(`${ORIGIN}/api/proxy/compose`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: "not json",
    });

    expect((await POST(request, params("compose"))).status).toBe(400);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects a body too large to be anything a person typed", async () => {
    const request = new Request(`${ORIGIN}/api/proxy/compose`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ intent: "x".repeat(200_000) }),
    });

    expect((await POST(request, params("compose"))).status).toBe(413);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("passes the API's own error through, status and code intact", async () => {
    // "Daily AI call cap reached" is more useful in the composer than "failed".
    apiFetch.mockRejectedValue(
      new FakeApiError(429, "AI_CAP_EXCEEDED", "Daily AI call cap reached"),
    );
    const path = `threads/${THREAD_ID}/replies`;

    const response = await POST(post(path, {}), params(path));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: { code: "AI_CAP_EXCEEDED", message: "Daily AI call cap reached" },
    });
  });
});
