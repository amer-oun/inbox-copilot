import Link from "next/link";
import { Paperclip, Reply, ShieldAlert, Sparkles } from "lucide-react";
import type { Priority, ThreadListItemDto } from "@inbox-copilot/shared";
import { cn } from "../../lib/utils";

/**
 * One row of the thread list.
 *
 * No `"use client"`: a row is a link and some text. It is rendered inside a client
 * component (the infinite list) but needs no interactivity of its own, so it stays
 * a plain function that React can render on either side.
 *
 * ── How priority is shown, and why it changed ───────────────────────────────────
 *
 * This used to be a coloured bar down the left edge of every row. That reads as a
 * decorative stripe rather than as data, it fires on all four levels so it is
 * present on every row and therefore distinguishes nothing, and colour was doing
 * the work on its own.
 *
 * Now: only the two levels a person would act on say anything at all. URGENT and
 * HIGH get a small **worded** chip beside the subject — "Urgent", "High" — which
 * is legible without colour vision and, more importantly, is *absent* from the
 * other rows. A signal on every row is not a signal. NORMAL and LOW are conveyed
 * by their own ordinary weight, which is the honest rendering of "nothing
 * special".
 *
 * Unread is the one thing that keeps a mark of its own: a filled dot in the
 * gutter, plus the sender in semibold, plus the word in the accessible label.
 */

const PRIORITY_CHIP: Partial<Record<Priority, { label: string; className: string }>> = {
  URGENT: {
    label: "Urgent",
    className: "bg-danger text-surface",
  },
  HIGH: {
    label: "High",
    className: "bg-warning-soft text-warning border border-warning-line",
  },
};

const PRIORITY_LABEL: Record<Priority, string> = {
  URGENT: "Urgent",
  HIGH: "High priority",
  NORMAL: "Normal priority",
  LOW: "Low priority",
};

/** Dates in a mail list: time today, weekday this week, otherwise a date. */
function formatWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  const sixDays = 6 * 24 * 60 * 60 * 1000;
  if (now.getTime() - date.getTime() < sixDays) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function ThreadRow({ thread }: { thread: ThreadListItemDto }) {
  const senderName = thread.from?.name ?? thread.from?.email ?? "(unknown sender)";
  const priorityLabel =
    thread.priority === null ? "Not yet prioritised" : PRIORITY_LABEL[thread.priority];
  const chip = thread.priority === null ? undefined : PRIORITY_CHIP[thread.priority];
  const flagged = thread.threatLevel !== "UNKNOWN" && thread.threatLevel !== "SAFE";

  return (
    <li>
      <Link
        href={`/thread/${thread.id}`}
        className={cn(
          "group flex gap-3 px-4 py-3 transition-colors duration-150 sm:px-6",
          "ease-[var(--ease-out-quart)] hover:bg-raised focus-visible:bg-raised",
          !thread.isRead && "bg-surface",
        )}
        // Read by a screen reader before the visual details below it.
        aria-label={`${senderName}: ${thread.subject ?? "(no subject)"}. ${priorityLabel}.${
          thread.isRead ? "" : " Unread."
        }${flagged ? " Flagged as suspicious." : ""}`}
      >
        {/*
          The unread gutter. A fixed-width column rather than a conditional
          element, so every subject in the list starts on the same x — a ragged
          left edge is what makes a mail list tiring to scan.
        */}
        <span aria-hidden="true" className="mt-[0.4375rem] w-2 shrink-0">
          {thread.isRead ? null : (
            <span className="block size-2 rounded-full bg-accent" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "truncate text-[0.8125rem]",
                thread.isRead ? "text-muted" : "font-semibold text-ink",
              )}
            >
              {senderName}
            </span>
            {thread.messageCount > 1 && (
              <span className="shrink-0 text-xs tabular-nums text-faint">
                {thread.messageCount}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-faint">
              {flagged && (
                <ShieldAlert
                  aria-label="Flagged as suspicious"
                  className="size-3.5 text-danger"
                />
              )}
              {thread.needsReply && (
                <Reply aria-label="Needs a reply" className="size-3.5" />
              )}
              {thread.hasAttachments && (
                <Paperclip aria-label="Has attachments" className="size-3.5" />
              )}
              <time dateTime={thread.lastMessageAt} className="tabular-nums">
                {formatWhen(thread.lastMessageAt)}
              </time>
            </span>
          </span>

          <span className="mt-1 flex items-center gap-2">
            {chip === undefined ? null : (
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-px text-[0.6875rem] font-semibold leading-4",
                  chip.className,
                )}
              >
                {chip.label}
              </span>
            )}
            <span
              className={cn(
                "truncate text-sm",
                thread.isRead ? "text-muted" : "font-medium text-ink",
              )}
            >
              {thread.subject ?? "(no subject)"}
            </span>
          </span>

          {/*
            The AI headline replaces the snippet when it exists: it is a sentence
            about the thread rather than the first line of its markup. The sparkle
            marks it as generated — a reader should always know which it is.
          */}
          {thread.summaryHeadline === null ? (
            <span className="mt-0.5 block truncate text-[0.8125rem] text-faint">
              {thread.snippet ?? ""}
            </span>
          ) : (
            <span className="mt-0.5 flex items-center gap-1.5 text-[0.8125rem] text-faint">
              <Sparkles aria-hidden="true" className="size-3 shrink-0 text-accent" />
              <span className="truncate">
                <span className="sr-only">AI summary: </span>
                {thread.summaryHeadline}
              </span>
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}
