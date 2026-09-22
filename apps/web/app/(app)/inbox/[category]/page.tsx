import { notFound } from "next/navigation";
import {
  threadCategoryFilterSchema,
  threadListSchema,
  type ThreadCategoryFilter,
} from "@inbox-copilot/shared";
import { apiFetch, isApiUnavailable } from "../../../../lib/apiClient";
import { requireViewer } from "../../../../lib/viewer";
import { StartingUp } from "../../../../components/shell/StartingUp";
import { CategoryTabs, CATEGORY_TABS } from "../../../../components/inbox/CategoryTabs";
import { ThreadList } from "../../../../components/inbox/ThreadList";
import { PageHeader } from "../../../../components/shell/PageHeader";

/**
 * The inbox, one category per URL.
 *
 * A server component: the first page of threads is fetched here with the session's
 * internal JWT and rendered into the HTML. The client component below it only takes
 * over for "load more", so the list is readable before any JavaScript arrives and
 * each category is a real, shareable URL.
 */

interface InboxPageProps {
  params: Promise<{ category: string }>;
}

export async function generateMetadata({ params }: InboxPageProps) {
  const { category } = await params;
  const tab = CATEGORY_TABS.find((entry) => entry.value.toLowerCase() === category);
  return { title: tab ? `${tab.label} · Inbox` : "Inbox" };
}

export default async function InboxPage({ params }: InboxPageProps) {
  const { category: raw } = await params;
  const viewer = await requireViewer(`/inbox/${raw}`);

  // The URL segment is user input: an unknown category is a 404, not an unfiltered
  // list of everything.
  const parsed = threadCategoryFilterSchema.safeParse(raw.toUpperCase());
  if (!parsed.success) notFound();
  const category: ThreadCategoryFilter = parsed.data;

  const query = new URLSearchParams({ category });
  let initialPage;
  try {
    initialPage = await apiFetch(
      viewer,
      `/threads?${query.toString()}`,
      threadListSchema,
    );
  } catch (error) {
    // The first visitor after a quiet spell meets a sleeping API; tell them, and wait.
    if (isApiUnavailable(error)) return <StartingUp />;
    throw error;
  }

  return (
    <>
      <PageHeader title="Inbox" description="Most important first" width="wide">
        <CategoryTabs active={category} />
      </PageHeader>

      {/*
        Wider than the reading pages: a thread row is a scanning surface, and a
        prose measure would strand each timestamp half a screen from its sender.
      */}
      <div className="mx-auto w-full max-w-5xl">
        <ThreadList category={category} initialPage={initialPage} />
      </div>
    </>
  );
}
