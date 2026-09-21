import { CalendarClock, BellRing, Inbox, Settings } from "lucide-react";

/**
 * The four destinations, defined once and rendered twice — as a sidebar on a wide
 * screen and as a bottom bar on a phone. One definition because two would drift,
 * and the way navigation drifts is that a page becomes reachable on a laptop and
 * unreachable on a phone.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Short enough for a bottom bar, where four labels share the width. */
  shortLabel: string;
  Icon: typeof Inbox;
  /** Prefixes that count as "you are here" — a thread is still the inbox. */
  match: string[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/inbox/all",
    label: "Inbox",
    shortLabel: "Inbox",
    Icon: Inbox,
    match: ["/inbox", "/thread"],
  },
  {
    href: "/scheduled",
    label: "Scheduled",
    shortLabel: "Scheduled",
    Icon: CalendarClock,
    match: ["/scheduled"],
  },
  {
    href: "/follow-ups",
    label: "Follow-ups",
    shortLabel: "Follow-ups",
    Icon: BellRing,
    match: ["/follow-ups"],
  },
  {
    href: "/settings",
    label: "Settings",
    shortLabel: "Settings",
    Icon: Settings,
    match: ["/settings"],
  },
];

/** Whole-segment matching, so `/inbox-archive` would not light up `/inbox`. */
export function isActive(item: NavItem, pathname: string): boolean {
  return item.match.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
