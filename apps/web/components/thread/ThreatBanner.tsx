"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Check, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import {
  threatAppealResponseSchema,
  type ThreatAssessmentDto,
  type ThreatIntent,
  type ThreatLevel,
} from "@inbox-copilot/shared";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

/**
 * The threat banner (§6): the reasons, not just a score.
 *
 * The product requirement behind this component is that the user should end up needing
 * it less. A banner that says "suspicious, 78/100" teaches nothing and becomes wallpaper;
 * a banner that says "the sender's own domain says this message is not from them" is a
 * thing a person can recognize in their next inbox. So the reason list is the body of
 * this component and the score is a detail at the bottom.
 *
 * Three states, and the quiet one matters as much as the loud one:
 *
 *   - **flagged** — the evidence, the model's reading of the intent, and what to do.
 *   - **clean but with findings** — a small note rather than nothing. A message that
 *     passed with two weak signals is worth one line, both because it is honest and
 *     because it is how a reader learns what the strong signals look like by contrast.
 *   - **appealed** — the user has said this is a false positive, so the alarm stands
 *     down to a note. The verdict itself is unchanged in the database on purpose (see
 *     `services/security/appeals.ts`); what changes is how loudly we say it.
 *
 * ── The visual grammar ──────────────────────────────────────────────────────────
 *
 * The three states are distinguished by *structure*, not only by colour, because
 * colour alone would make the appealed state read as a weaker alarm rather than a
 * different thing. Flagged gets a tinted field, a solid level chip and an icon in
 * its own column; clean-with-findings is one line of muted text on the ordinary
 * surface; appealed keeps the structure and drops the tint.
 */

const LEVEL_COPY: Readonly<Record<ThreatLevel, { title: string; blurb: string }>> = {
  PHISHING: {
    title: "This message appears to be a phishing attempt",
    blurb:
      "Do not enter any password or code, and do not open attachments. If you deal with this sender, reach them a way you already trust.",
  },
  SUSPICIOUS: {
    title: "Something about this message does not check out",
    blurb:
      "It may still be genuine, but treat links and attachments as unverified until you have confirmed the sender another way.",
  },
  SPAM: {
    title: "This looks like unsolicited bulk mail",
    blurb:
      "Nothing here is aimed at you personally. Links in bulk mail are best left alone.",
  },
  SAFE: { title: "Checks passed", blurb: "" },
  UNKNOWN: { title: "Not assessed", blurb: "" },
};

/** The model's intent, in words a reader would use. */
const INTENT_COPY: Readonly<Record<ThreatIntent, string>> = {
  CREDENTIAL_HARVEST: "Trying to collect a password or login code",
  BEC: "Impersonating a colleague to get something done",
  INVOICE_FRAUD: "A payment request that may be false",
  MALWARE: "Trying to get a file opened",
  EXTORTION: "A threat meant to pressure you",
  ADVANCE_FEE: "A promised windfall that will ask for money first",
  BENIGN_MARKETING: "Ordinary marketing",
  BENIGN_TRANSACTIONAL: "An automated notice",
  BENIGN_PERSONAL: "Ordinary correspondence",
  UNCLEAR: "Could not be read either way",
};

async function postAppeal(messageId: string): Promise<unknown> {
  const response = await fetch(`/api/proxy/messages/${messageId}/threat-appeal`, {
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

export interface ThreatBannerProps {
  threat: ThreatAssessmentDto;
}

export function ThreatBanner({ threat }: ThreatBannerProps) {
  const router = useRouter();
  const [appealed, setAppealed] = useState(threat.appeal !== null);

  const appeal = useMutation({
    mutationFn: async () =>
      threatAppealResponseSchema.parse(await postAppeal(threat.messageId)),
    onSuccess: () => {
      setAppealed(true);
      // The verdict does not change, so this refresh is about the record rather than
      // the reading — it brings the stored appeal back with the thread.
      router.refresh();
    },
  });

  const flagged = threat.level !== "SAFE" && threat.level !== "UNKNOWN";

  /*
   * Clean, with something to mention. Deliberately not a warning: a heading, a border
   * and an alarm colour for "we checked and it was fine" is how users learn to stop
   * reading banners.
   */
  if (!flagged) {
    if (threat.reasons.length === 0) return null;
    return (
      <section className="flex items-start gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-3.5 py-2.5 text-[0.8125rem] leading-relaxed text-muted">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
        <span>
          <span className="font-medium text-ink">Sender checks passed.</span>{" "}
          {threat.reasons.join(" ")}
        </span>
      </section>
    );
  }

  const copy = LEVEL_COPY[threat.level];
  const danger = threat.level === "PHISHING";

  return (
    <section
      // `alert` while it is live, a plain region once the user has stood it down: an
      // appealed banner should not re-announce itself to a screen reader on every visit.
      {...(appealed ? {} : { role: "alert" })}
      aria-labelledby="threat-banner-heading"
      className={cn(
        "overflow-hidden rounded-[var(--radius-card)] border",
        appealed
          ? "border-line bg-surface"
          : danger
            ? "border-danger-line bg-danger-soft"
            : "border-warning-line bg-warning-soft",
      )}
    >
      <div className="flex gap-3 p-4">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            appealed
              ? "bg-panel text-muted"
              : danger
                ? "bg-danger text-surface"
                : "bg-warning text-surface",
          )}
        >
          {appealed ? (
            <ShieldQuestion aria-hidden="true" className="size-4" />
          ) : (
            <ShieldAlert aria-hidden="true" className="size-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <h2
            id="threat-banner-heading"
            className={cn(
              "text-sm font-semibold",
              appealed ? "text-ink" : danger ? "text-danger" : "text-warning",
            )}
          >
            {appealed
              ? `You marked this as safe (we flagged it as ${threat.level.toLowerCase()})`
              : copy.title}
          </h2>

          {!appealed && (
            <p className="mt-1 max-w-[70ch] text-[0.8125rem] leading-relaxed text-ink">
              {copy.blurb}
            </p>
          )}

          {/*
            The evidence. Every item is one deterministic finding or the model's reading,
            phrased by the API — the UI does not compose these sentences, because the
            wording is part of what the rule *means* and it belongs next to the rule.
          */}
          {threat.reasons.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-[0.8125rem] leading-relaxed text-ink">
              {threat.reasons.map((reason) => (
                <li key={reason} className="flex gap-2.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-[0.4375rem] size-1.5 shrink-0 rounded-full",
                      appealed ? "bg-muted" : danger ? "bg-danger" : "bg-warning",
                    )}
                  />
                  <span className="max-w-[70ch]">{reason}</span>
                </li>
              ))}
            </ul>
          )}

          {threat.explanation !== null && (
            <p className="mt-3 max-w-[70ch] text-[0.8125rem] leading-relaxed text-ink">
              {threat.explanation}
            </p>
          )}

          <p className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
            {threat.intent !== null && (
              <span className="font-medium">{INTENT_COPY[threat.intent]}</span>
            )}
            {/*
              Both numbers, because they answer different questions: what the checks
              found on their own, and what the verdict became once the message had been
              read. Where they differ is exactly where the layering did something.
            */}
            <span className="tabular-nums">{`Score ${threat.score}/100`}</span>
            {threat.ruleScore !== threat.score && (
              <span className="tabular-nums">{`checks alone ${threat.ruleScore}/100`}</span>
            )}
            {threat.explanation === null && <span>Assessed by the checks only</span>}
          </p>
        </div>
      </div>

      {/* The action rail, separated so the evidence above it reads as evidence. */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2.5",
          appealed
            ? "border-line bg-panel/60"
            : danger
              ? "border-danger-line/60"
              : "border-warning-line/60",
        )}
      >
        {appealed ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Check aria-hidden="true" className="size-3.5" />
            Recorded. The findings above are kept so we can tell how often we get this
            wrong.
          </p>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => appeal.mutate()}
              disabled={appeal.isPending}
            >
              {appeal.isPending ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <ShieldCheck aria-hidden="true" />
              )}
              This is safe
            </Button>
            <span className="text-xs text-muted">
              Tells us we got it wrong. It does not change the sender or the links.
            </span>
          </>
        )}
      </div>

      {appeal.isError && (
        <p className="border-t border-danger-line/60 px-4 py-2 text-xs text-danger">
          {appeal.error.message}
        </p>
      )}
    </section>
  );
}
