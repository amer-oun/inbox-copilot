"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BellRing, Check, Clock, Loader2 } from "lucide-react";
import { followUpReminderSchema, type FollowUpReminderDto } from "@inbox-copilot/shared";
import { Button } from "../ui/button";

/**
 * Due follow-up reminders (§9), with dismiss and snooze.
 *
 * The copy here is doing real work, so it is worth saying what it is for. A reminder is
 * a claim about somebody else's behaviour — "they have not answered you" — and the
 * system is sometimes wrong about that: a reply can arrive at a different address, or
 * the conversation can move to a call. So each row says plainly what it is based on
 * ("sent 4 days ago, nothing inbound on this thread since"), because a reminder the
 * user can *check* is a reminder they will trust, and the two controls are "handled"
 * and "not yet" rather than a single dismissal that loses the thread.
 */

async function postAction(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
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

/** "4 days ago", from the reminder's creation — when the message actually went out. */
function waitingFor(createdAt: string): string {
  const days = Math.floor((Date.now() - Date.parse(createdAt)) / (24 * 3_600_000));
  if (days <= 0) return "sent today";
  if (days === 1) return "sent yesterday";
  return `sent ${days} days ago`;
}

function FollowUpRow({ item }: { item: FollowUpReminderDto }) {
  const router = useRouter();

  const dismiss = useMutation({
    mutationFn: async () =>
      followUpReminderSchema.parse(
        await postAction(`/api/proxy/follow-ups/${item.id}/dismiss`, {}),
      ),
    onSuccess: () => router.refresh(),
  });

  const snooze = useMutation({
    mutationFn: async (days: number) =>
      followUpReminderSchema.parse(
        await postAction(`/api/proxy/follow-ups/${item.id}/snooze`, { days }),
      ),
    onSuccess: () => router.refresh(),
  });

  const busy = dismiss.isPending || snooze.isPending;

  return (
    <li className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3.5 shadow-raise">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <BellRing aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 truncate text-sm font-semibold text-ink">
          {item.subject ?? item.reason ?? "(no subject)"}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted">
          {waitingFor(item.createdAt)}
        </span>
      </div>

      {item.recipients.length > 0 && (
        <p className="mt-1 truncate text-xs text-muted">
          {`You were waiting on ${item.recipients.join(", ")}`}
        </p>
      )}

      {/*
        What the reminder is actually based on, so the user can check it rather than
        take it on trust. "Nothing inbound on this thread" is the literal condition the
        check job uses (services/followUps.ts), stated in the same words.
      */}
      <p className="mt-2 max-w-[70ch] text-[0.8125rem] leading-relaxed text-ink">
        Nothing has arrived on this thread since you sent it. If somebody replied
        elsewhere, mark it handled.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          href={`/thread/${item.threadId}`}
          className="text-xs font-medium text-accent underline underline-offset-2 hover:no-underline"
        >
          Open the thread
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => snooze.mutate(3)}
            disabled={busy}
            title="Ask me again in three days"
          >
            {snooze.isPending ? (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <Clock aria-hidden="true" />
            )}
            Not yet
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => dismiss.mutate()}
            disabled={busy}
          >
            {dismiss.isPending ? (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <Check aria-hidden="true" />
            )}
            Handled
          </Button>
        </div>
      </div>

      {(dismiss.isError || snooze.isError) && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {(dismiss.error ?? snooze.error)?.message}
        </p>
      )}
    </li>
  );
}

export function FollowUpList({ items }: { items: FollowUpReminderDto[] }) {
  if (items.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-dashed border-line-strong bg-surface px-4 py-10 text-center text-sm text-muted">
        Nothing is waiting on a reply. Tick “remind me if nobody replies” in the composer
        to start watching a thread.
      </p>
    );
  }

  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <FollowUpRow key={item.id} item={item} />
      ))}
    </ul>
  );
}
