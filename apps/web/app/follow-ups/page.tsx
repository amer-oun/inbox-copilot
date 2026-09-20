import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { followUpListSchema } from "@inbox-copilot/shared";
import { apiFetch } from "../../lib/apiClient";
import { requireSession } from "../../lib/session";
import { FollowUpList } from "../../components/followups/FollowUpList";

/**
 * `/follow-ups` — messages nobody has answered (§9).
 *
 * Only what is *due*. A reminder set for Thursday is not information on Tuesday, and a
 * page that padded itself out with future reminders would be a page with nothing on it
 * to act on — which is how a list becomes something people stop opening.
 */

export const metadata = { title: "Follow-ups · Inbox Copilot" };

export default async function FollowUpsPage() {
  const session = await requireSession("/follow-ups");

  const { items } = await apiFetch(session.user.id, "/follow-ups", followUpListSchema);

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 pb-16 pt-6">
      <Link
        href="/inbox/all"
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Inbox
      </Link>

      <header className="mt-4">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Waiting on a reply
        </h1>
        <p className="mt-1 text-sm text-muted">
          {items.length === 0
            ? "Nothing is overdue."
            : `${items.length} ${items.length === 1 ? "thread" : "threads"} you asked to be reminded about.`}
        </p>
      </header>

      <div className="mt-5">
        <FollowUpList items={items} />
      </div>
    </main>
  );
}
