import { followUpListSchema } from "@inbox-copilot/shared";
import { apiFetch } from "../../../lib/apiClient";
import { requireSession } from "../../../lib/session";
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
  const session = await requireSession("/follow-ups");

  const { items } = await apiFetch(session.user.id, "/follow-ups", followUpListSchema);

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
