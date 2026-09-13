import Link from "next/link";
import type { ThreadCategoryFilter } from "@inbox-copilot/shared";
import { cn } from "../../lib/utils";

/**
 * The category strip. A server component: these are links, and a set of links
 * needs no JavaScript to work — each tab is a real URL that can be bookmarked,
 * opened in a new tab, and rendered on the server.
 *
 * The tabs are driven by the `Category` enum, so a category added to the schema
 * appears here without anyone remembering to add it.
 */

/** Order is editorial: what a person checks first, not alphabetical. */
export const CATEGORY_TABS: { value: ThreadCategoryFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PRIMARY", label: "Primary" },
  { value: "WORK", label: "Work" },
  { value: "PERSONAL", label: "Personal" },
  { value: "FINANCE", label: "Finance" },
  { value: "TRAVEL", label: "Travel" },
  { value: "NOTIFICATION", label: "Notifications" },
  { value: "NEWSLETTER", label: "Newsletters" },
  { value: "PROMOTION", label: "Promotions" },
  { value: "SOCIAL", label: "Social" },
  { value: "OTHER", label: "Other" },
  { value: "SPAM", label: "Spam" },
];

export function CategoryTabs({ active }: { active: ThreadCategoryFilter }) {
  return (
    <nav aria-label="Categories" className="border-b border-border-subtle">
      {/* Scrolls rather than wraps: twelve tabs must not become three rows on a phone. */}
      <ul className="flex gap-1 overflow-x-auto px-4 pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {CATEGORY_TABS.map((tab) => {
          const isActive = tab.value === active;
          return (
            <li key={tab.value} className="shrink-0">
              <Link
                href={`/inbox/${tab.value.toLowerCase()}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex items-center border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "border-accent text-accent"
                    : "border-transparent text-muted hover:border-border-subtle hover:text-ink",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
