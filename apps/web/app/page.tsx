import { redirect } from "next/navigation";
import { auth } from "../auth";

/** The root is a signpost, not a page: signed in → dashboard, else → sign-in. */
export default async function HomePage() {
  const session = await auth();
  redirect(session?.user?.id ? "/dashboard" : "/signin");
}
