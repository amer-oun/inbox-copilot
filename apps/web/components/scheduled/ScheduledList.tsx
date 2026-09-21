"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, CircleAlert, Loader2, Send, X } from "lucide-react";
import { scheduledEmailSchema, type ScheduledEmailDto } from "@inbox-copilot/shared";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * The scheduled-send list (§9), with its cancel action.
 *
 * A client component for the cancel button, handed rows the server already fetched.
 *
 * The one presentation decision worth defending is that **FAILED rows stay in this
 * list**. A scheduled send is deliberately not retried — the outcome of a failed send
 * is unknown, and a retry could mail somebody twice — so this list is the only place a
 * person finds out that the mail they queued for 9am did not go. Hiding failures behind
 * a filter would make the feature quietly lossy, which is the worst thing a scheduler
 * can be.
 */

const STATUS_COPY: Readonly<
  Record<
    ScheduledEmailDto["status"],
    { label: string; tone: "neutral" | "info" | "danger" }
  >
> = {
  SCHEDULED: { label: "Scheduled", tone: "info" },
  SENDING: { label: "Sending now", tone: "info" },
  SENT: { label: "Sent", tone: "neutral" },
  FAILED: { label: "Failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

async function postCancel(scheduledId: string): Promise<unknown> {
  const response = await fetch(`/api/proxy/scheduled/${scheduledId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({}),
  });

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof (payload as { error: { message?: unknown } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

/** The wall clock the user picked, shown as they picked it. */
function whenLabel(item: ScheduledEmailDto): string {
  if (item.sendAtLocal !== null) {
    return `${item.sendAtLocal.replace("T", " ")} (${item.timezone})`;
  }
  // Rows written before `localSendAt` existed: fall back to the instant, rendered in
  // the reader's own zone rather than pretending to know the one they chose.
  return new Date(item.sendAt).toLocaleString();
}

function ScheduledRow({ item }: { item: ScheduledEmailDto }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  const cancel = useMutation({
    mutationFn: async () => scheduledEmailSchema.parse(await postCancel(item.id)),
    onSuccess: () => {
      setConfirming(false);
      router.refresh();
    },
  });

  const status = STATUS_COPY[item.status];

  return (
    <li className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3.5 shadow-raise">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-sm font-semibold text-ink">
          {item.subject}
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
        {item.expectsReply && <Badge tone="neutral">Reminder set</Badge>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted">
          <CalendarClock aria-hidden="true" />
          {whenLabel(item)}
        </span>
      </div>

      <p className="mt-1 truncate text-xs text-muted">{`To ${item.to.join(", ")}`}</p>

      {item.bodyText !== null && (
        <p className="mt-2 line-clamp-2 max-w-[70ch] text-[0.8125rem] leading-relaxed text-muted">
          {item.bodyText}
        </p>
      )}

      {/*
        The failure, in full and in the list. `lastError` is the provider's message,
        and it is shown because the alternative is a user who never learns their mail
        did not go out.
      */}
      {item.status === "FAILED" && (
        <p className="mt-2.5 flex items-start gap-2 rounded-[var(--radius-control)] border border-danger-line bg-danger-soft px-3 py-2 text-[0.8125rem] leading-relaxed text-ink">
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-danger"
          />
          <span>
            {`This did not go out${item.lastError === null ? "." : `: ${item.lastError}`} `}
            It was not retried automatically, because a send that fails after the provider
            may already have accepted it could deliver twice. Send it again yourself if it
            is still needed.
          </span>
        </p>
      )}

      {item.status === "SENDING" && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <Send aria-hidden="true" />
          On its way — too late to cancel.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.threadId !== null && (
          <Link
            href={`/thread/${item.threadId}`}
            className="text-xs font-medium text-accent underline underline-offset-2 hover:no-underline"
          >
            Open the thread
          </Link>
        )}

        {item.status === "SCHEDULED" && (
          <div className="ml-auto flex items-center gap-2">
            {confirming ? (
              <>
                <span className="text-xs text-ink">Cancel this send?</span>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => cancel.mutate()}
                  disabled={cancel.isPending}
                >
                  {cancel.isPending ? (
                    <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : (
                    <X aria-hidden="true" />
                  )}
                  Cancel send
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
                <X aria-hidden="true" />
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>

      {cancel.isError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {cancel.error.message}
        </p>
      )}
    </li>
  );
}

export function ScheduledList({ items }: { items: ScheduledEmailDto[] }) {
  if (items.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-dashed border-line-strong bg-surface px-4 py-10 text-center text-sm text-muted">
        Nothing is queued. Write a reply and use “Send later” to schedule one.
      </p>
    );
  }

  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <ScheduledRow key={item.id} item={item} />
      ))}
    </ul>
  );
}
