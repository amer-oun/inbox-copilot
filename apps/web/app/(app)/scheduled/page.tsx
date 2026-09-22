import { scheduledListSchema } from "@inbox-copilot/shared";
import { apiFetch, isApiUnavailable } from "../../../lib/apiClient";
import { requireViewer } from "../../../lib/viewer";
import { StartingUp } from "../../../components/shell/StartingUp";
import { ScheduledList } from "../../../components/scheduled/ScheduledList";
import { PageBody, PageHeader } from "../../../components/shell/PageHeader";

/**
 * `/scheduled` — what is queued to go out, and what did not (§9).
 *
 * A server component: the list is a read, and only the cancel button needs the client.
 * No caching directives are needed — `apiFetch` mints a 60-second internal JWT per
 * request and the proxy marks its responses `private, no-store`, so this page is
 * per-request by construction.
 */

export const metadata = { title: "Scheduled" };

export default async function ScheduledPage() {
  const viewer = await requireViewer("/scheduled");

  let items;
  try {
    ({ items } = await apiFetch(viewer, "/scheduled", scheduledListSchema));
  } catch (error) {
    if (isApiUnavailable(error)) return <StartingUp />;
    throw error;
  }

  const pending = items.filter((item) => item.status === "SCHEDULED").length;
  const failed = items.filter((item) => item.status === "FAILED").length;

  return (
    <>
      <PageHeader
        title="Scheduled sends"
        description={
          pending === 0
            ? "Nothing waiting to go out."
            : `${pending} waiting to go out${failed === 0 ? "." : `, ${failed} that did not.`}`
        }
      />

      <PageBody>
        {/*
          Stated once, here, because it is the one thing about this feature a user has to
          know: a failed scheduled send is not retried, so this page is where they find
          out. The reason is in the row itself.
        */}
        {failed > 0 && (
          <p className="mb-4 rounded-[var(--radius-card)] border border-warning-line bg-warning-soft px-4 py-3 text-[0.8125rem] leading-relaxed text-ink">
            Failed sends are never retried automatically, because a send that fails after
            the mail server may already have accepted it could deliver twice. Anything
            below marked failed needs sending again by hand.
          </p>
        )}

        <ScheduledList items={items} />
      </PageBody>
    </>
  );
}
