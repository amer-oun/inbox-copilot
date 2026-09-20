"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  BellRing,
  CalendarClock,
  Check,
  Loader2,
  Send,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  replyDraftsResponseSchema,
  replyToneSchema,
  scheduledEmailSchema,
  sendResultSchema,
  type AddressDto,
  type ReplyDraftDto,
  type ReplyTone,
} from "@inbox-copilot/shared";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

/**
 * The reply composer: pick a tone, get three drafts, edit one, send it.
 *
 * `"use client"` for the obvious reason — this is the interactive part of the app.
 * Two properties are worth stating because they are the UI half of rule 1:
 *
 *   1. **Generating and sending are separate requests, made by separate clicks.**
 *      Drafts arrive into a textarea. The send request carries the textarea's
 *      contents, which means whatever is sent is something a person had on screen.
 *      There is no code path here that chains the two, and the API has no endpoint
 *      that would accept one.
 *   2. **The recipient is not ours to choose.** It comes from the API with the thread
 *      (`replyRecipients`, computed by the same function the send path uses) and is
 *      displayed, not edited. The composer cannot add a recipient, so neither can an
 *      email that talked a model into suggesting one.
 */

const TONES = replyToneSchema.options;

/** Sentence case for a tone, since the enum shouts. */
function toneLabel(tone: ReplyTone): string {
  return tone.charAt(0) + tone.slice(1).toLowerCase();
}

function addressLabel(address: AddressDto): string {
  return address.name === null ? address.email : `${address.name} <${address.email}>`;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!response.ok) {
    // The API's error envelope, surfaced as-is: "daily AI call cap reached" is more
    // useful to read than "something went wrong".
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

/**
 * The browser's own IANA zone, which is what the schedule request carries (§9).
 *
 * `Intl` gives the *zone*, not an offset, and that is the whole point: the server
 * stores this string alongside the wall-clock time, so "9am" is re-resolved under
 * whatever the rules say in October rather than frozen against today's offset. A
 * browser that somehow reports nothing falls back to UTC, which is at least a real
 * zone — the alternative, guessing from `getTimezoneOffset()`, is the offset mistake
 * this whole design avoids.
 */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `YYYY-MM-DDTHH:mm` in local time, for the `datetime-local` default and its `min`. */
function localWallClock(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Tomorrow at 9am local, the default a "send later" control should open on. */
function defaultSchedule(): string {
  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(9, 0, 0, 0);
  return localWallClock(when);
}

export interface ReplyComposerProps {
  threadId: string;
  /** From the API. Empty means there is nobody to reply to. */
  recipients: AddressDto[];
  /** The user's default, so the selector opens on what they would have chosen. */
  defaultTone?: ReplyTone;
}

export function ReplyComposer({ threadId, recipients, defaultTone }: ReplyComposerProps) {
  const router = useRouter();

  const [tone, setTone] = useState<ReplyTone>(defaultTone ?? "PROFESSIONAL");
  const [drafts, setDrafts] = useState<ReplyDraftDto[]>([]);
  const [styleApplied, setStyleApplied] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  /** A draft the user picked while their own edits were in the box. */
  const [pendingPick, setPendingPick] = useState<ReplyDraftDto | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** The schedule panel, closed by default: sending now is still the normal case. */
  const [scheduling, setScheduling] = useState(false);
  const [sendAtLocal, setSendAtLocal] = useState(defaultSchedule);
  const [expectsReply, setExpectsReply] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const timeZone = browserTimeZone();

  const selected = drafts.find((draft) => draft.id === selectedId) ?? null;
  const edited = selected !== null && body.trim() !== selected.body.trim();

  const generate = useMutation({
    mutationFn: async () => {
      const payload = await postJson(`/api/proxy/threads/${threadId}/replies`, { tone });
      return replyDraftsResponseSchema.parse(payload);
    },
    onSuccess: (data) => {
      setDrafts(data.drafts);
      setStyleApplied(data.styleApplied);
      const first = data.drafts[0];
      // The first draft lands in the box only when the box is empty: a regenerate must
      // never overwrite something the user has written.
      if (first !== undefined && body.trim() === "") {
        setSelectedId(first.id);
        setBody(first.body);
      }
    },
  });

  const send = useMutation({
    mutationFn: async () => {
      const payload = await postJson(`/api/proxy/threads/${threadId}/reply`, {
        body,
        expectsReply,
        ...(selectedId === null ? {} : { draftId: selectedId }),
      });
      return sendResultSchema.parse(payload);
    },
    onSuccess: () => {
      setSentTo(recipients.map((person) => person.name ?? person.email).join(", "));
      setConfirming(false);
      setBody("");
      setDrafts([]);
      setSelectedId(null);
      // The sent message itself arrives with the next sync (the API does not fabricate
      // a row for it), so this refresh updates the thread, not necessarily its contents.
      router.refresh();
    },
  });

  /**
   * Scheduling, which is a *different request* from sending and not a mode of it.
   *
   * It carries the same thing the send carries — the text in the textarea — plus a wall
   * clock and this browser's IANA zone. Rule 1 is unaffected by the delay: what goes out
   * at 9am is text a person had on screen and submitted, and the API has no endpoint
   * that would schedule a draft by id.
   */
  const schedule = useMutation({
    mutationFn: async () => {
      const payload = await postJson(`/api/proxy/scheduled/replies`, {
        threadId,
        body,
        sendAtLocal,
        timezone: timeZone,
        expectsReply,
        ...(selectedId === null ? {} : { draftId: selectedId }),
      });
      return scheduledEmailSchema.parse(payload);
    },
    onSuccess: (data) => {
      setScheduledFor(data.sendAtLocal ?? data.sendAt);
      setScheduling(false);
      setBody("");
      setDrafts([]);
      setSelectedId(null);
      router.refresh();
    },
  });

  function pick(draft: ReplyDraftDto): void {
    if (body.trim() !== "" && draft.id !== selectedId && edited) {
      // Two clicks, because the first would silently discard the user's own words.
      setPendingPick(draft);
      return;
    }
    setSelectedId(draft.id);
    setBody(draft.body);
    setPendingPick(null);
  }

  function confirmPick(): void {
    if (pendingPick === null) return;
    setSelectedId(pendingPick.id);
    setBody(pendingPick.body);
    setPendingPick(null);
  }

  if (recipients.length === 0) {
    return (
      <section className="rounded-card border border-border-subtle bg-surface px-4 py-3 text-sm text-muted">
        There is nobody to reply to in this thread.
      </section>
    );
  }

  return (
    <section
      aria-labelledby="reply-composer-heading"
      className="rounded-card border border-border-subtle bg-surface"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle px-4 py-3">
        <h2 id="reply-composer-heading" className="text-sm font-semibold text-ink">
          Reply
        </h2>
        <p className="min-w-0 flex-1 truncate text-xs text-muted">
          {`To ${recipients.map(addressLabel).join(", ")}`}
        </p>

        <label htmlFor="reply-tone" className="text-xs text-muted">
          Tone
        </label>
        <select
          id="reply-tone"
          value={tone}
          onChange={(event) => setTone(event.target.value as ReplyTone)}
          className="h-8 rounded-lg border border-border-subtle bg-canvas px-2 text-xs text-ink"
        >
          {TONES.map((option) => (
            <option key={option} value={option}>
              {toneLabel(option)}
            </option>
          ))}
        </select>

        <Button
          size="sm"
          variant="outline"
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
        >
          {generate.isPending ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <Sparkles aria-hidden="true" className="size-3.5" />
          )}
          {drafts.length === 0 ? "Draft 3 replies" : "Redraft"}
        </Button>
      </header>

      {generate.isError && (
        <p
          role="alert"
          className="border-b border-border-subtle px-4 py-2 text-sm text-danger"
        >
          {generate.error.message}
        </p>
      )}

      {drafts.length > 0 && (
        <div className="border-b border-border-subtle px-4 py-3">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Sparkles aria-hidden="true" className="size-3.5" />
            <span className="sr-only">AI-generated: </span>
            {styleApplied === false
              ? "Three AI drafts. No writing-style profile yet, so these sound generic — read before sending."
              : "Three AI drafts, matched to how you write. Read before sending."}
          </p>

          <ul className="mt-2 grid gap-2 sm:grid-cols-3">
            {drafts.map((draft, index) => (
              <li key={draft.id}>
                <button
                  type="button"
                  onClick={() => pick(draft)}
                  aria-pressed={draft.id === selectedId}
                  className={cn(
                    "h-full w-full rounded-lg border px-3 py-2 text-left transition-colors",
                    draft.id === selectedId
                      ? "border-accent bg-accent/10"
                      : "border-border-subtle bg-canvas hover:border-accent/50",
                  )}
                >
                  <span className="block text-xs font-medium text-ink">
                    {draft.label ?? `Draft ${index + 1}`}
                  </span>
                  <span className="mt-1 line-clamp-3 block text-xs text-muted">
                    {draft.body}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {pendingPick !== null && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
              <TriangleAlert aria-hidden="true" className="size-3.5 text-warning" />
              Replace what you have written with this draft?
              <Button size="sm" variant="outline" onClick={confirmPick}>
                Replace
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingPick(null)}>
                Keep mine
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="px-4 py-3">
        <label htmlFor="reply-body" className="sr-only">
          Your reply
        </label>
        <textarea
          id="reply-body"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            // Any edit invalidates a pending confirmation: the thing being confirmed
            // was "send this text".
            setConfirming(false);
          }}
          rows={8}
          placeholder="Write your reply, or draft three and edit one."
          className="w-full resize-y rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-sm text-ink placeholder:text-muted"
        />

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-xs text-muted" aria-live="polite">
            {selected === null
              ? `${body.trim().length} characters`
              : `${body.trim().length} characters · ${edited ? "edited from the draft" : "unchanged from the draft"}`}
          </p>

          <div className="ml-auto flex items-center gap-2">
            {confirming ? (
              <>
                <span className="text-xs text-ink">
                  {`Send to ${recipients.map((person) => person.name ?? person.email).join(", ")}?`}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => send.mutate()} disabled={send.isPending}>
                  {send.isPending ? (
                    <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : (
                    <Send aria-hidden="true" className="size-3.5" />
                  )}
                  Confirm send
                </Button>
              </>
            ) : (
              /*
               * Two clicks to send, and the second names the recipient. Sending is the
               * one action in this application that cannot be undone — no draft state,
               * no local rollback, no recall — so it is worth one more click.
               */
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setScheduling((open) => !open)}
                  aria-expanded={scheduling}
                  disabled={body.trim() === ""}
                >
                  <CalendarClock aria-hidden="true" className="size-3.5" />
                  Send later
                </Button>
                <Button
                  size="sm"
                  onClick={() => setConfirming(true)}
                  disabled={body.trim() === "" || send.isPending}
                >
                  <Send aria-hidden="true" className="size-3.5" />
                  Send reply
                </Button>
              </>
            )}
          </div>
        </div>

        {scheduling && (
          <div className="mt-3 rounded-lg border border-border-subtle bg-canvas px-3 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor="reply-send-at"
                  className="block text-xs font-medium text-ink"
                >
                  Send at
                </label>
                <input
                  id="reply-send-at"
                  type="datetime-local"
                  value={sendAtLocal}
                  min={localWallClock(new Date())}
                  onChange={(event) => setSendAtLocal(event.target.value)}
                  className="mt-1 h-8 rounded-lg border border-border-subtle bg-surface px-2 text-xs text-ink"
                />
              </div>

              <Button
                size="sm"
                onClick={() => schedule.mutate()}
                disabled={schedule.isPending || sendAtLocal === ""}
              >
                {schedule.isPending ? (
                  <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                ) : (
                  <CalendarClock aria-hidden="true" className="size-3.5" />
                )}
                Schedule
              </Button>

              <Button size="sm" variant="ghost" onClick={() => setScheduling(false)}>
                Cancel
              </Button>
            </div>

            <label className="mt-3 flex items-start gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={expectsReply}
                onChange={(event) => setExpectsReply(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <BellRing aria-hidden="true" className="mr-1 inline size-3" />
                Remind me if nobody replies. The reminder clears itself as soon as
                anything arrives on this thread.
              </span>
            </label>

            {/*
              The zone is stated rather than assumed. A person scheduling mail while
              travelling needs to know which "9am" they just picked, and the server
              stores this zone — not an offset — so the time still means 9am after a DST
              change.
            */}
            <p className="mt-2 text-xs text-muted">
              {`Your time zone: ${timeZone}. Stored as a zone, so this stays 9am across a clock change.`}
            </p>

            {schedule.isError && (
              <p role="alert" className="mt-2 text-sm text-danger">
                {`Not scheduled: ${schedule.error.message}`}
              </p>
            )}
          </div>
        )}

        {scheduledFor !== null && (
          <p
            role="status"
            className="mt-2 flex items-center gap-1.5 text-sm text-success"
          >
            <Check aria-hidden="true" className="size-4" />
            {`Scheduled for ${scheduledFor.replace("T", " ")} (${timeZone}). `}
            <a href="/scheduled" className="underline">
              See scheduled sends
            </a>
          </p>
        )}

        {send.isError && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {`Not sent: ${send.error.message}`}
          </p>
        )}

        {sentTo !== null && (
          <p
            role="status"
            className="mt-2 flex items-center gap-1.5 text-sm text-success"
          >
            <Check aria-hidden="true" className="size-4" />
            {`Sent to ${sentTo}. It will appear in this thread after the next sync.`}
          </p>
        )}
      </div>
    </section>
  );
}
