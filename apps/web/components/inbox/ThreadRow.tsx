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
 */

/**
 * The priority indicator.
 *
 * A coloured bar rather than a number: the score is a model's guess and showing
 * "72" invites a precision it does not have. The bar is also the one thing that
 * must survive a colour-blind reader, so priority is in the `title`/`aria-label`
 * as words too, and URGENT additionally carries weight in the subject.
 */
const PRIORITY_STYLES: Record<Priority, { bar: string; label: string }> = {
  URGENT: { bar: "bg-danger", label: "Urgent" },
  HIGH: { bar: "bg-warning", label: "High priority" },
  NORMAL: { bar: "bg-accent/40", label: "Normal priority" },
  LOW: { bar: "bg-border-subtle", label: "Low priority" },
};

function PriorityBar({ priority }: { priority: Priority | null }) {
  const style = priority === null ? null : PRIORITY_STYLES[priority];

  return (
    <span
      aria-hidden="true"
      title={style?.label ?? "Not yet prioritised"}
      className={cn(
        "mt-1 h-10 w-1 shrink-0 rounded-full",
        style?.bar ?? "bg-border-subtle/40",
      )}
    />
  );
}

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
    thread.priority === null
      ? "Not yet prioritised"
      : PRIORITY_STYLES[thread.priority].label;

  return (
    <li className="border-b border-border-subtle last:border-b-0">
      <Link
        href={`/thread/${thread.id}`}
        className="flex gap-3 px-4 py-3 transition-colors hover:bg-canvas focus-visible:bg-canvas"
        // Read by a screen reader before the visual details below it.
        aria-label={`${senderName}: ${thread.subject ?? "(no subject)"}. ${priorityLabel}.${
          thread.isRead ? "" : " Unread."
        }`}
      >
        <PriorityBar priority={thread.priority} />

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "truncate text-sm",
                thread.isRead ? "text-muted" : "font-semibold text-ink",
              )}
            >
              {senderName}
            </span>
            {thread.messageCount > 1 && (
              <span className="shrink-0 text-xs text-muted">{thread.messageCount}</span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted">
              {thread.threatLevel !== "UNKNOWN" && thread.threatLevel !== "SAFE" && (
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
              <time dateTime={thread.lastMessageAt}>
                {formatWhen(thread.lastMessageAt)}
              </time>
            </span>
          </span>

          <span
            className={cn(
              "mt-0.5 block truncate text-sm",
              thread.isRead ? "text-muted" : "text-ink",
              thread.priority === "URGENT" && "font-medium",
            )}
          >
            {thread.subject ?? "(no subject)"}
          </span>

          {/*
            The AI headline replaces the snippet when it exists: it is a sentence
            about the thread rather than the first line of its markup. The sparkle
            marks it as generated — a reader should always know which it is.
          */}
          {thread.summaryHeadline === null ? (
            <span className="mt-0.5 block truncate text-xs text-muted">
              {thread.snippet ?? ""}
            </span>
          ) : (
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
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
