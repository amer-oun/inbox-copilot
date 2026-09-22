import "server-only";
import { redirect } from "next/navigation";
import {
  DEMO_MAILBOX_ADDRESS,
  DEMO_MAILBOX_NAME,
  DEMO_USER_ID,
} from "@inbox-copilot/shared";
import { auth } from "../auth";
import { readDemoSession } from "./demo";

/**
 * Who is looking at this page: a signed-in account, or a demo visitor.
 *
 * The two are different types rather than one type with a flag, so a page that needs
 * the Auth.js session (the account card in Settings) has to ask for the `user` kind and
 * cannot be handed a demo visit by accident. Everything that only needs "call the API
 * as this person" takes a `Viewer` and lets `apiFetch` mint the right token.
 *
 * A real session wins when both cookies are present: someone who signs in after trying
 * the demo is looking at their own mailbox, not the shared one.
 */
export type Viewer =
  | {
      kind: "user";
      userId: string;
      name: string | null;
      email: string | null;
      expires: string;
    }
  | {
      kind: "demo";
      userId: typeof DEMO_USER_ID;
      /** One visit; the API rations live AI calls per visit with it. */
      demoSessionId: string;
      name: string;
      email: string;
      expires: string;
    };

export async function getViewer(): Promise<Viewer | null> {
  const session = await auth();
  if (session?.user?.id) {
    return {
      kind: "user",
      userId: session.user.id,
      name: session.user.name ?? null,
      email: session.user.email ?? null,
      expires: session.expires,
    };
  }

  const demo = await readDemoSession();
  if (demo) {
    return {
      kind: "demo",
      userId: DEMO_USER_ID,
      demoSessionId: demo.sessionId,
      name: DEMO_MAILBOX_NAME,
      email: DEMO_MAILBOX_ADDRESS,
      expires: demo.expires.toISOString(),
    };
  }

  return null;
}

/**
 * Guard for protected pages and server actions.
 *
 * Per page rather than in middleware on purpose: with the `database` session strategy
 * the session lives in Postgres, and middleware runs where Prisma should not. A server
 * component awaiting this is the honest check — it hits the same store that authorizes
 * the request.
 */
export async function requireViewer(returnTo?: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (viewer === null) {
    redirect(returnTo ? `/signin?next=${encodeURIComponent(returnTo)}` : "/signin");
  }
  return viewer;
}
