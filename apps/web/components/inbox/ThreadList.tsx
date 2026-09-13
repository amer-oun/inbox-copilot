"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Inbox, Loader2 } from "lucide-react";
import {
  threadListSchema,
  type ThreadCategoryFilter,
  type ThreadListDto,
} from "@inbox-copilot/shared";
import { Button } from "../ui/button";
import { ThreadRow } from "./ThreadRow";

/**
 * The paginated thread list.
 *
 * `"use client"` for one reason: loading the next page without a navigation. The
 * first page is fetched on the server and handed in as `initialPage`, so the list
 * is complete in the server-rendered HTML — this component hydrates over it rather
 * than replacing a spinner.
 */

async function fetchPage(
  category: ThreadCategoryFilter,
  cursor: string | null,
): Promise<ThreadListDto> {
  const params = new URLSearchParams({ category });
  if (cursor !== null) params.set("cursor", cursor);

  // Through the BFF: the browser has no key to sign an internal token with.
  const response = await fetch(`/api/proxy/threads?${params.toString()}`, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Could not load threads (${response.status})`);
  }

  // Validated on arrival. The proxy passes the API's body through untouched, so
  // this is the point where the shape is actually checked.
  return threadListSchema.parse(await response.json());
}

export interface ThreadListProps {
  category: ThreadCategoryFilter;
  initialPage: ThreadListDto;
}

export function ThreadList({ category, initialPage }: ThreadListProps) {
  const query = useInfiniteQuery({
    // The category is part of the key: switching tabs must not show the old list.
    queryKey: ["threads", category],
    queryFn: ({ pageParam }) => fetchPage(category, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialData: { pages: [initialPage], pageParams: [null] },
  });

  const threads = query.data.pages.flatMap((page) => page.items);

  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <Inbox aria-hidden="true" className="size-8 text-muted" />
        <p className="text-sm font-medium text-ink">Nothing here yet</p>
        <p className="max-w-sm text-sm text-muted">
          {category === "ALL"
            ? "Once a mailbox has finished syncing, its threads appear here."
            : "No threads have been filed under this category yet."}
        </p>
      </div>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-border-subtle">
        {threads.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} />
        ))}
      </ul>

      <div className="flex items-center justify-center px-4 py-6" aria-live="polite">
        {query.hasNextPage ? (
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage && (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            )}
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : (
          <p className="text-xs text-muted">
            {`${threads.length} thread${threads.length === 1 ? "" : "s"}`}
          </p>
        )}
      </div>

      {query.isError && (
        <p role="alert" className="px-4 pb-6 text-sm text-danger">
          Could not load more threads. Try again.
        </p>
      )}
    </div>
  );
}
