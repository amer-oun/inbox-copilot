import { redirect } from "next/navigation";

/** `/inbox` is not a page of its own; "All" is the landing tab. */
export default function InboxIndexPage(): never {
  redirect("/inbox/all");
}
