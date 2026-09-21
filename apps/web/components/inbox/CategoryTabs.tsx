import Link from "next/link";
import type { ThreadCategoryFilter } from "@inbox-copilot/shared";
import { cn } from "../../lib/utils";

/**
 * The category strip. A server component: these are links, and a set of links
 * needs no JavaScript to work — each tab is a real URL that can be bookmarked,
 * opened in a new tab, and rendered on the server.
 *
 * Pills rather than an underline rule. Twelve underlined tabs in a horizontally
 * scrolling strip give the eye nothing to land on until it reaches the active
 * one; a filled pill is findable at a glance mid-scroll, which is the whole job
 * of this control. The active pill also carries an accent *fill* rather than only
 * accent text, so it survives being scrolled half off the edge.
 *
 * `scroll-mx` plus `snap-start` means tapping a tab on a phone brings it fully
 * into view rather than leaving it clipped against the gutter.
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
    <nav aria-label="Categories">
      {/* Scrolls rather than wraps: twelve tabs must not become three rows. */}
      <ul
        className={cn(
          "flex snap-x gap-1 overflow-x-auto pb-3",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {CATEGORY_TABS.map((tab) => {
          const isActive = tab.value === active;
          return (
            <li key={tab.value} className="shrink-0 snap-start scroll-mx-4">
              <Link
                href={`/inbox/${tab.value.toLowerCase()}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex items-center rounded-full px-3 py-1.5 text-[0.8125rem] font-medium",
                  "transition-colors duration-150 ease-[var(--ease-out-quart)]",
                  isActive
                    ? "bg-accent text-accent-ink"
                    : "text-muted hover:bg-raised hover:text-ink",
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
