"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, NAV_ITEMS } from "./nav";
import { cn } from "../../lib/utils";

/**
 * The navigation links, in the two shapes the shell needs.
 *
 * The only reason this is a client component is `usePathname`: everything else
 * about it is a list of links. The alternative — every page passing down which
 * item is current — puts a piece of navigation state in twelve files and gets it
 * wrong the first time somebody adds a route.
 *
 * The current item is marked three ways over, because one is never enough:
 * `aria-current` for a screen reader, a filled background for a sighted reader,
 * and the accent colour on top of that for a glance.
 */
export function AppNav({ variant }: { variant: "sidebar" | "bar" }) {
  const pathname = usePathname();

  if (variant === "bar") {
    return (
      <ul className="flex items-stretch">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item, pathname);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full flex-col items-center justify-center gap-1 px-1 py-2",
                  "text-[0.6875rem] font-medium transition-colors duration-150",
                  active ? "text-accent" : "text-muted active:text-ink",
                )}
              >
                <item.Icon
                  aria-hidden="true"
                  className={cn("size-5", active && "stroke-[2.25]")}
                />
                {item.shortLabel}
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="space-y-0.5">
      {NAV_ITEMS.map((item) => {
        const active = isActive(item, pathname);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2",
                "text-sm font-medium transition-colors duration-150",
                "ease-[var(--ease-out-quart)]",
                active
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:bg-raised hover:text-ink",
              )}
            >
              <item.Icon aria-hidden="true" className="size-4 shrink-0" />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
