import { NextResponse } from "next/server";
import { env } from "../../../lib/env";

/**
 * `GET /api/wake` — is the API up yet? Asking is also what wakes it.
 *
 * The API runs on a free host that sleeps after a quarter of an hour with no traffic
 * and takes about half a minute to come back. Any request starts that clock, so this
 * route serves two callers: the sign-in page pings it on load, which usually has the
 * API awake by the time a visitor clicks anything, and the "Starting up" screen polls
 * it to know when to reload.
 *
 * Public on purpose. It calls the API's own `/health`, which is public too, and says
 * nothing beyond up or not.
 */

const PROBE_TIMEOUT_MS = 4_000;

export async function GET(): Promise<NextResponse> {
  let up: boolean;
  try {
    const response = await fetch(new URL("/health", env.API_BASE_URL), {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    up = response.ok;
  } catch {
    up = false;
  }

  return NextResponse.json({ up }, { headers: { "cache-control": "no-store" } });
}
