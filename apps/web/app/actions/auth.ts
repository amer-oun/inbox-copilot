"use server";

import { redirect } from "next/navigation";
import { DEMO_USER_ID, demoSessionResponseSchema } from "@inbox-copilot/shared";
import { auth, signOut } from "../../auth";
import { apiFetch } from "../../lib/apiClient";
import {
  clearDemoSession,
  createDemoSession,
  demoEnabled,
  readDemoSession,
} from "../../lib/demo";

/**
 * Ends whichever session this is. A real one ends its session row, not just the
 * cookie (database strategy, see auth.ts); a demo visit just drops its cookie.
 */
export async function signOutAction(): Promise<void> {
  if (await readDemoSession()) await clearDemoSession();

  const session = await auth();
  if (session?.user?.id) {
    await signOut({ redirectTo: "/signin" });
    return;
  }
  redirect("/signin");
}

/**
 * "Try the demo": a demo visit, with no OAuth and no Auth.js session (lib/demo.ts).
 *
 * The API is asked to hand this visitor the mailbox as seeded — restoring it if the
 * previous visitor changed something. If the API is asleep that call times out, and
 * that is fine: the inbox shows "Starting up", and the API's first demo request after
 * it wakes applies the same restore policy (services/demo/seed.ts).
 */
export async function startDemoAction(): Promise<void> {
  if (!demoEnabled()) redirect("/signin");

  const { sessionId } = await createDemoSession();
  try {
    await apiFetch(
      { userId: DEMO_USER_ID, demoSessionId: sessionId },
      "/demo/session",
      demoSessionResponseSchema,
      { method: "POST", timeoutMs: 8_000 },
    );
  } catch {
    // Asleep or unreachable — see above. The visit starts either way.
  }

  redirect("/inbox/all");
}
