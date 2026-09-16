import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "../../../../lib/apiClient";
import { auth } from "../../../../auth";

/**
 * The browser's only door to the core API (ARCHITECTURE §1).
 *
 * A client component cannot mint the internal JWT — the RS256 private key is
 * server-only and must stay that way — so browser-side fetches (TanStack Query's
 * infinite pages, the reply composer) come here, and this handler calls the API as
 * the session user.
 *
 * Two deliberate restrictions:
 *
 *   1. **Allowlisted paths, per method.** The proxy forwards what the UI actually
 *      uses and nothing else. The user is authenticated either way, so this is not a
 *      privilege boundary — it keeps the surface honest, so "what can the browser
 *      call?" has a short answer that lives in one place. Phase 6 adds three POSTs to
 *      it, and one of them sends mail; phase 10 adds one that sends mail *later*.
 *   2. **Same-origin only, for writes.** See `assertSameOrigin`.
 */

/** Paths the browser may read, as anchored patterns. */
const ALLOWED_GET_PATHS: RegExp[] = [
  /^threads$/,
  /^threads\/c[a-z0-9]{24}$/,
  /^writing-style$/,
  /^scheduled$/, // what is queued to go out, and what failed
  /^follow-ups$/, // threads waiting on a reply
];

/**
 * Paths the browser may post to.
 *
 * Written out one per line, because this list is the answer to "what can a page in
 * the browser cause to happen?" — and the third entry is the one that puts mail on
 * the wire. Nothing here accepts a request to generate *and* send: that separation
 * lives in the API's route space (`apps/api/src/routes/reply.ts`) and this list keeps
 * it intact rather than re-deciding it.
 */
const ALLOWED_POST_PATHS: RegExp[] = [
  /^threads\/c[a-z0-9]{24}\/replies$/, // draft three replies
  /^threads\/c[a-z0-9]{24}\/reply$/, // send the text the user submitted
  /^compose$/, // draft a new message
  /^writing-style$/, // rebuild the style profile
  /^messages\/c[a-z0-9]{24}\/threat-appeal$/, // "this is safe" — records, changes no verdict
  /*
   * Phase 10. The first entry is the second path in this list that can put mail on the
   * wire — later rather than now, which is exactly why it is spelled out here next to
   * the immediate send rather than folded into a wildcard. Note what is *not* here:
   * nothing that schedules a stored draft by id, because the API has no such route
   * (rule 1 survives the delay).
   */
  /^scheduled\/replies$/, // queue a reply the user wrote, to send later
  /^scheduled\/messages$/, // queue a new message the user wrote
  /^scheduled\/c[a-z0-9]{24}\/cancel$/, // unqueue one
  /^follow-ups\/c[a-z0-9]{24}\/dismiss$/, // "handled"
  /^follow-ups\/c[a-z0-9]{24}\/snooze$/, // "not yet"
  /^messages\/c[a-z0-9]{24}\/translate$/, // translate a body; cached per (message, language)
];

/** Query parameters that may be forwarded. Anything else is dropped. */
const ALLOWED_QUERY = new Set(["category", "cursor", "limit", "force", "status"]);

/** A JSON body larger than this is not a reply anyone typed. */
const MAX_BODY_BYTES = 128 * 1024;

/**
 * The API's responses are already validated by their own schemas on the way out;
 * here the body is passed through untouched, so the proxy cannot become a place
 * where shapes quietly diverge. `unknown` is honest about that.
 */
const passthroughSchema: z.ZodType<unknown> = z.unknown();

function unauthorized(): NextResponse {
  // 401 rather than a redirect: the caller is `fetch`, not a navigation.
  return NextResponse.json(
    { error: { code: "UNAUTHORIZED", message: "Sign in required" } },
    { status: 401 },
  );
}

function notProxied(): NextResponse {
  return NextResponse.json(
    { error: { code: "NOT_PROXIED", message: "This path is not proxied" } },
    { status: 404 },
  );
}

/**
 * Rejects a cross-site write.
 *
 * The session cookie is `SameSite=Lax`, which already means a cross-site form POST
 * arrives without it and therefore unauthenticated. This is the second lock on the
 * same door, and it is here rather than nowhere because of what is behind it: a
 * cross-site request that did carry a session would be able to send mail from the
 * user's own address. Checking `Origin` costs one comparison.
 */
function assertSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // A same-origin `fetch` from the app always sends one; its absence means this did
  // not come from our page.
  if (origin === null) return false;
  return origin === new URL(request.url).origin;
}

/** The target path on the core API, with only the parameters we allow. */
function targetPath(request: Request, joined: string): string {
  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  // Rebuilt from an allowlist rather than forwarded: the incoming query string is
  // attacker-influenceable, and the API should only ever see parameters it has.
  for (const [key, value] of incoming) {
    if (ALLOWED_QUERY.has(key)) forwarded.append(key, value);
  }

  const query = forwarded.toString();
  return query.length > 0 ? `/${joined}?${query}` : `/${joined}`;
}

function asApiError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  throw error;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  const { path } = await context.params;
  const joined = path.join("/");
  if (!ALLOWED_GET_PATHS.some((pattern) => pattern.test(joined))) return notProxied();

  try {
    const body = await apiFetch(session.user.id, targetPath(request, joined), passthroughSchema);
    return NextResponse.json(body, {
      // Per-user mail: never cached by a shared cache, never stored by the browser.
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return asApiError(error);
  }
}

/**
 * Writes: drafting, composing, sending, and rebuilding the style profile.
 *
 * The body is forwarded as it arrived, as JSON. It is *not* validated here: the API
 * validates every input with a Zod schema from `packages/shared`, and a second,
 * hand-maintained copy of those rules in the BFF would drift and become the one that
 * is wrong. What this layer decides is which paths exist and who may reach them.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  if (!assertSameOrigin(request)) {
    return NextResponse.json(
      { error: { code: "CROSS_ORIGIN", message: "Cross-origin writes are refused" } },
      { status: 403 },
    );
  }

  const { path } = await context.params;
  const joined = path.join("/");
  if (!ALLOWED_POST_PATHS.some((pattern) => pattern.test(joined))) return notProxied();

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { code: "BODY_TOO_LARGE", message: "Request body is too large" } },
      { status: 413 },
    );
  }

  let payload: unknown = {};
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: { code: "BAD_JSON", message: "Request body is not JSON" } },
        { status: 400 },
      );
    }
  }

  try {
    const body = await apiFetch(
      session.user.id,
      targetPath(request, joined),
      passthroughSchema,
      { method: "POST", body: payload },
    );
    return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return asApiError(error);
  }
}
