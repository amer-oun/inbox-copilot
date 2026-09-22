import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The BFF proxy's allowlists.
 *
 * Worth testing directly because this file is the whole answer to "what can a page in
 * the browser cause the API to do?" — and since phase 6 one of those things sends mail
 * from the user's own address.
 */

const apiFetch = vi.hoisted(() => vi.fn());
const getViewer = vi.hoisted(() => vi.fn());

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
vi.mock("../../../../lib/viewer", () => ({ getViewer }));

/**
 * The real module validates a deployment's worth of secrets on first read, which a unit
 * test has no business supplying. Only `AUTH_URL` is read here — as the deployment's
 * canonical origin, for the same-origin check.
 */
const webEnv = vi.hoisted(() => ({ AUTH_URL: "https://app.example.test" }));

vi.mock("../../../../lib/env", () => ({ env: webEnv }));

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

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}/api/proxy/${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getViewer.mockReset().mockResolvedValue({
    kind: "user",
    userId: USER_ID,
    name: null,
    email: null,
    expires: "2030-01-01T00:00:00.000Z",
  });
  apiFetch.mockReset().mockResolvedValue({ ok: true });
});

describe("reads", () => {
  it("proxies the allowlisted paths", async () => {
    for (const path of [
      "threads",
      `threads/${THREAD_ID}`,
      "writing-style",
      // Phase 10.
      "scheduled",
      "follow-ups",
    ]) {
      const response = await GET(get(path), params(path));
      expect(response.status).toBe(200);
    }
    expect(apiFetch).toHaveBeenCalledTimes(5);
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
    getViewer.mockResolvedValue(null);
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

  it("proxies scheduling, the follow-up actions and a translation", async () => {
    const paths = [
      "scheduled/replies",
      "scheduled/messages",
      `scheduled/${THREAD_ID}/cancel`,
      `follow-ups/${THREAD_ID}/dismiss`,
      `follow-ups/${THREAD_ID}/snooze`,
      `messages/${MESSAGE_ID}/translate`,
    ];

    for (const path of paths) {
      const response = await POST(post(path, { body: "ok" }), params(path));
      expect(response.status).toBe(200);
    }

    expect(apiFetch).toHaveBeenCalledTimes(paths.length);
  });

  it("does not proxy a path that would schedule a stored draft", async () => {
    /*
     * Rule 1, held at the BFF as well as in the API's route space.
     *
     * Scheduling is the feature most likely to grow a "generate now, send at 9am"
     * shortcut, because the delay makes it feel less like sending. The two paths that can
     * put mail on the wire both carry the body, and asserting the absence here means the
     * BFF cannot become the place a new one quietly appears.
     */
    for (const path of [
      "scheduled/drafts",
      `threads/${THREAD_ID}/schedule-draft`,
      "scheduled/generate",
      `scheduled/${THREAD_ID}/send`,
    ]) {
      const response = await POST(
        post(path, { draftId: "d_1", sendAtLocal: "2026-09-17T09:00" }),
        params(path),
      );
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
    for (const path of [
      "threads",
      `threads/${THREAD_ID}`,
      "mail-accounts/x/sync",
      "send",
    ]) {
      const response = await POST(post(path, {}), params(path));
      expect(response.status).toBe(404);
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    getViewer.mockResolvedValue(null);
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

describe("the same-origin check across a proxy", () => {
  /**
   * The deployed shape: the browser talks to Vercel over https, and the platform
   * reconstructs the request URL from its own forwarding headers. If that
   * reconstruction disagrees with the browser about the scheme or the host, the first
   * comparison in `assertSameOrigin` fails — and the consequence is that *every* write
   * 403s in production while reads keep working, which looks like anything but a
   * configuration problem.
   */

  function postTo(url: string, origin: string): Request {
    return new Request(url, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ body: "ok" }),
    });
  }

  it("accepts the configured origin when the reconstructed URL disagrees", async () => {
    // The platform handed us http://internal-host/... ; the browser said https://app.
    const response = await POST(
      postTo(
        `http://internal.vercel.internal/api/proxy/threads/${THREAD_ID}/reply`,
        ORIGIN,
      ),
      params(`threads/${THREAD_ID}/reply`),
    );

    expect(response.status).toBe(200);
  });

  it("still accepts a preview deployment, whose host is not AUTH_URL", async () => {
    // Previews are the reason the request's own origin is checked first and kept.
    const preview = "https://inbox-copilot-git-abc123.vercel.app";
    const response = await POST(
      postTo(`${preview}/api/proxy/threads/${THREAD_ID}/reply`, preview),
      params(`threads/${THREAD_ID}/reply`),
    );

    expect(response.status).toBe(200);
  });

  it("does not let a forwarded-host header decide what our origin is", async () => {
    /*
     * The reason this is `AUTH_URL` and not `x-forwarded-host`. Reading the host from a
     * header hands the check to the sender, and what is behind it sends mail from the
     * user's own address.
     */
    const response = await POST(
      new Request(`${ORIGIN}/api/proxy/threads/${THREAD_ID}/reply`, {
        method: "POST",
        headers: {
          origin: "https://evil.test",
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "ok" }),
      }),
      params(`threads/${THREAD_ID}/reply`),
    );

    expect(response.status).toBe(403);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("demo visits", () => {
  const DEMO_VIEWER = {
    kind: "demo",
    userId: "cdemouser0000000000000001",
    demoSessionId: "visit_aaaaaaaaaaaaaaaa",
    name: "Sam Whitfield",
    email: "sam@northwind-freight.com",
    expires: "2030-01-01T00:00:00.000Z",
  };

  it("calls the API as the demo visit, so the API can hold it to the demo's rules", async () => {
    getViewer.mockResolvedValue(DEMO_VIEWER);

    await POST(
      post(`threads/${THREAD_ID}/reply`, { body: "hi" }),
      params(`threads/${THREAD_ID}/reply`),
    );

    // The proxy does not decide what a demo visit may do — it forwards, and the API
    // refuses to send. What it must get right is *who* it calls as.
    expect(apiFetch.mock.calls[0]?.[0]).toBe(DEMO_VIEWER);
  });

  it("surfaces the API's demo refusal as-is", async () => {
    getViewer.mockResolvedValue(DEMO_VIEWER);
    apiFetch.mockRejectedValue(
      new FakeApiError(
        403,
        "DEMO_READ_ONLY",
        "Sending is disabled in the demo. Nothing was sent.",
      ),
    );

    const response = await POST(
      post(`threads/${THREAD_ID}/reply`, { body: "hi" }),
      params(`threads/${THREAD_ID}/reply`),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "DEMO_READ_ONLY",
        message: "Sending is disabled in the demo. Nothing was sent.",
      },
    });
  });
});
