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
      <section className="rounded-card border border-border-subtle bg-surface px-3 py-2 text-xs text-muted">
        <p className="flex items-start gap-2">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-success"
          />
          <span>
            {"Sender checks passed. Worth knowing: "}
            {threat.reasons.join(" ")}
          </span>
        </p>
      </section>
    );
  }

  const copy = LEVEL_COPY[threat.level];
  const tone = threat.level === "PHISHING" ? "danger" : "warning";

  return (
    <section
      // `alert` while it is live, a plain region once the user has stood it down: an
      // appealed banner should not re-announce itself to a screen reader on every visit.
      {...(appealed ? {} : { role: "alert" })}
      aria-labelledby="threat-banner-heading"
      className={
        appealed
          ? "rounded-card border border-border-subtle bg-surface px-4 py-3"
          : tone === "danger"
            ? "rounded-card border border-danger/40 bg-danger/10 px-4 py-3"
            : "rounded-card border border-warning/40 bg-warning/10 px-4 py-3"
      }
    >
      <div className="flex items-start gap-2">
        {appealed ? (
          <ShieldQuestion
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted"
          />
        ) : (
          <ShieldAlert
            aria-hidden="true"
            className={`mt-0.5 size-4 shrink-0 ${tone === "danger" ? "text-danger" : "text-warning"}`}
          />
        )}

        <div className="min-w-0 flex-1">
          <h2
            id="threat-banner-heading"
            className={`text-sm font-semibold ${
              appealed ? "text-ink" : tone === "danger" ? "text-danger" : "text-warning"
            }`}
          >
            {appealed
              ? `You marked this as safe (we flagged it as ${threat.level.toLowerCase()})`
              : copy.title}
          </h2>

          {!appealed && <p className="mt-1 text-sm text-ink">{copy.blurb}</p>}

          {/*
            The evidence. Every item is one deterministic finding or the model's reading,
            phrased by the API — the UI does not compose these sentences, because the
            wording is part of what the rule *means* and it belongs next to the rule.
          */}
          {threat.reasons.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-ink">
              {threat.reasons.map((reason) => (
                <li key={reason} className="flex gap-2">
                  <span aria-hidden="true" className="text-muted">
                    •
                  </span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          )}

          {threat.explanation !== null && (
            <p className="mt-2 text-sm text-ink">{threat.explanation}</p>
          )}

          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {threat.intent !== null && <span>{INTENT_COPY[threat.intent]}</span>}
            {/*
              Both numbers, because they answer different questions: what the checks
              found on their own, and what the verdict became once the message had been
              read. Where they differ is exactly where the layering did something.
            */}
            <span>{`Score ${threat.score}/100`}</span>
            {threat.ruleScore !== threat.score && (
              <span>{`checks alone ${threat.ruleScore}/100`}</span>
            )}
            {threat.explanation === null && <span>Assessed by the checks only</span>}
          </p>

          {appealed ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
              <Check aria-hidden="true" className="size-3.5" />
              Recorded. The findings above are kept so we can tell how often we get this
              wrong.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => appeal.mutate()}
                disabled={appeal.isPending}
              >
                {appeal.isPending ? (
                  <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                ) : (
                  <ShieldCheck aria-hidden="true" className="size-3.5" />
                )}
                This is safe
              </Button>
              <span className="text-xs text-muted">
                Tells us we got it wrong. It does not change the sender or the links.
              </span>
            </div>
          )}

          {appeal.isError && (
            <p className="mt-2 text-xs text-danger">{appeal.error.message}</p>
          )}
        </div>
      </div>
    </section>
  );
}
