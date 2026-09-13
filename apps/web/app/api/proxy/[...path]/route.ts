import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "../../../../lib/apiClient";
import { auth } from "../../../../auth";

/**
 * The browser's only door to the core API (ARCHITECTURE §1).
 *
 * A client component cannot mint the internal JWT — the RS256 private key is
 * server-only and must stay that way — so browser-side fetches (TanStack Query's
 * infinite pages) come here, and this handler calls the API as the session user.
 *
 * Two deliberate restrictions:
 *
 *   1. **GET only.** Phase 5 is read-only. A general-purpose passthrough would
 *      quietly hand the browser every write route the API has, including
 *      `POST /mail-accounts/:id/sync`, which is not what a list view needs.
 *   2. **Allowlisted paths.** The proxy forwards what the inbox reads and nothing
 *      else. The user is authenticated either way, so this is not a privilege
 *      boundary — it keeps the surface honest, so "what can the browser call?" has
 *      a short answer that lives in one place.
 */

/** Paths the browser may read, as anchored patterns. */
const ALLOWED_PATHS: RegExp[] = [
  /^threads$/,
  /^threads\/c[a-z0-9]{24}$/,
];

/** Query parameters that may be forwarded, per path. Anything else is dropped. */
const ALLOWED_QUERY = new Set(["category", "cursor", "limit"]);

/**
 * The API's responses are already validated by their own schemas on the way out;
 * here the body is passed through untouched, so the proxy cannot become a place
 * where shapes quietly diverge. `unknown` is honest about that.
 */
const passthroughSchema: z.ZodType<unknown> = z.unknown();

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    // 401 rather than a redirect: the caller is `fetch`, not a navigation.
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in required" } },
      { status: 401 },
    );
  }

  const { path } = await context.params;
  const joined = path.join("/");

  if (!ALLOWED_PATHS.some((pattern) => pattern.test(joined))) {
    return NextResponse.json(
      { error: { code: "NOT_PROXIED", message: "This path is not proxied" } },
      { status: 404 },
    );
  }

  // Rebuilt from an allowlist rather than forwarded: the incoming query string is
  // attacker-influenceable, and the API should only ever see parameters it has.
  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  for (const [key, value] of incoming) {
    if (ALLOWED_QUERY.has(key)) forwarded.append(key, value);
  }

  const query = forwarded.toString();
  const target = query.length > 0 ? `/${joined}?${query}` : `/${joined}`;

  try {
    const body = await apiFetch(session.user.id, target, passthroughSchema);
    return NextResponse.json(body, {
      // Per-user mail: never cached by a shared cache, never stored by the browser.
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    throw error;
  }
}
