"use server";

import { signOut } from "../../auth";

/** Ends the session row, not just the cookie — database strategy (see auth.ts). */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}
