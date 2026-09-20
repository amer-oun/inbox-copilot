import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { auth } from "../auth";

/**
 * Guard for protected pages and server actions.
 *
 * Protection is per-page rather than in middleware on purpose: with the
 * `database` session strategy the session lives in Postgres, and middleware runs
 * where Prisma should not. A server component `await`ing this is the honest
 * check — it hits the same store that authorizes the request.
 */
export async function requireSession(returnTo?: string): Promise<Session> {
  const session = await auth();
  if (!session?.user?.id) {
    const target = returnTo ? `/signin?next=${encodeURIComponent(returnTo)}` : "/signin";
    redirect(target);
  }
  return session;
}
