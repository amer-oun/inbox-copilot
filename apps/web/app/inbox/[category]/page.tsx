import { notFound } from "next/navigation";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import {
  threadCategoryFilterSchema,
  threadListSchema,
  type ThreadCategoryFilter,
} from "@inbox-copilot/shared";
import { apiFetch } from "../../../lib/apiClient";
import { requireSession } from "../../../lib/session";
import { CategoryTabs, CATEGORY_TABS } from "../../../components/inbox/CategoryTabs";
import { ThreadList } from "../../../components/inbox/ThreadList";

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
  return { title: tab ? `${tab.label} · Inbox Copilot` : "Inbox Copilot" };
}

export default async function InboxPage({ params }: InboxPageProps) {
  const { category: raw } = await params;
  const session = await requireSession(`/inbox/${raw}`);

  // The URL segment is user input: an unknown category is a 404, not an unfiltered
  // list of everything.
  const parsed = threadCategoryFilterSchema.safeParse(raw.toUpperCase());
  if (!parsed.success) notFound();
  const category: ThreadCategoryFilter = parsed.data;

  const query = new URLSearchParams({ category });
  const initialPage = await apiFetch(
    session.user.id,
    `/threads?${query.toString()}`,
    threadListSchema,
  );

  return (
    <main className="mx-auto min-h-dvh max-w-3xl">
      <header className="flex items-center gap-3 px-4 pb-3 pt-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Inbox</h1>
        <p className="text-xs text-muted">sorted by priority</p>
        <Link
          href="/settings/accounts"
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"
        >
          <Settings2 aria-hidden="true" className="size-3.5" />
          Mailboxes
        </Link>
      </header>

      <CategoryTabs active={category} />

      <section className="bg-surface">
        <ThreadList category={category} initialPage={initialPage} />
      </section>
    </main>
  );
}
