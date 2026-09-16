import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { scheduledListSchema } from "@inbox-copilot/shared";
import { apiFetch } from "../../lib/apiClient";
import { requireSession } from "../../lib/session";
import { ScheduledList } from "../../components/scheduled/ScheduledList";

/**
 * `/scheduled` — what is queued to go out, and what did not (§9).
 *
 * A server component: the list is a read, and only the cancel button needs the client.
 * No caching directives are needed — `apiFetch` mints a 60-second internal JWT per
 * request and the proxy marks its responses `private, no-store`, so this page is
 * per-request by construction.
 */

export const metadata = { title: "Scheduled · Inbox Copilot" };

export default async function ScheduledPage() {
  const session = await requireSession("/scheduled");

  const { items } = await apiFetch(session.user.id, "/scheduled", scheduledListSchema);

  const pending = items.filter((item) => item.status === "SCHEDULED").length;
  const failed = items.filter((item) => item.status === "FAILED").length;

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
        <h1 className="text-xl font-semibold tracking-tight text-ink">Scheduled sends</h1>
        <p className="mt-1 text-sm text-muted">
          {pending === 0
            ? "Nothing waiting to go out."
            : `${pending} waiting to go out${failed === 0 ? "." : `, ${failed} that did not.`}`}
        </p>
      </header>

      {/*
        Stated once, here, because it is the one thing about this feature a user has to
        know: a failed scheduled send is not retried, so this page is where they find
        out. The reason is in the row itself.
      */}
      {failed > 0 && (
        <p className="mt-3 rounded-card border border-border-subtle bg-surface px-4 py-3 text-sm text-muted">
          Failed sends are never retried automatically, because a send that fails after
          the mail server may already have accepted it could deliver twice. Anything
          below marked failed needs sending again by hand.
        </p>
      )}

      <div className="mt-5">
        <ScheduledList items={items} />
      </div>
    </main>
  );
}
