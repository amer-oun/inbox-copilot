import { followUpListSchema } from "@inbox-copilot/shared";
import { apiFetch, isApiUnavailable } from "../../../lib/apiClient";
import { requireViewer } from "../../../lib/viewer";
import { StartingUp } from "../../../components/shell/StartingUp";
import { FollowUpList } from "../../../components/followups/FollowUpList";
import { PageBody, PageHeader } from "../../../components/shell/PageHeader";

/**
 * `/follow-ups` — messages nobody has answered (§9).
 *
 * Only what is *due*. A reminder set for Thursday is not information on Tuesday, and a
 * page that padded itself out with future reminders would be a page with nothing on it
 * to act on — which is how a list becomes something people stop opening.
 */

export const metadata = { title: "Follow-ups" };

export default async function FollowUpsPage() {
  const viewer = await requireViewer("/follow-ups");

  let items;
  try {
    ({ items } = await apiFetch(viewer, "/follow-ups", followUpListSchema));
  } catch (error) {
    if (isApiUnavailable(error)) return <StartingUp />;
    throw error;
  }

  return (
    <>
      <PageHeader
        title="Waiting on a reply"
        description={
          items.length === 0
            ? "Nothing is overdue."
            : `${items.length} ${items.length === 1 ? "thread" : "threads"} you asked to be reminded about.`
        }
      />

      <PageBody>
        <FollowUpList items={items} />
      </PageBody>
    </>
  );
}
