import { redirect } from "next/navigation";
import { auth } from "../auth";

/**
 * The root is a signpost, not a page: signed in → the inbox, else → sign-in.
 *
 * Straight to the inbox rather than to a dashboard. The mail is the product, and
 * a landing screen between sign-in and the inbox is a screen every user learns to
 * click through — so the things it used to hold (identity, mailbox status) moved
 * to /settings, where somebody goes when they actually want them.
 */
export default async function HomePage() {
  const session = await auth();
  redirect(session?.user?.id ? "/inbox/all" : "/signin");
}
