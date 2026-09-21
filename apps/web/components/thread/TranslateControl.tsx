"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Languages, Loader2 } from "lucide-react";
import { translationSchema, type TranslationDto } from "@inbox-copilot/shared";
import { Button } from "../ui/button";

/**
 * The language control (§9): read this message in another language.
 *
 * Per message rather than per thread, because a thread is often mixed — your own
 * replies in English under a French original — and translating the whole conversation
 * would translate the half the reader wrote.
 *
 * Two deliberate presentation decisions, both about not letting a translation pass
 * itself off as the email:
 *
 *   1. The translation appears **beside** the original, as a labelled block under the
 *      body, not in place of it. The original is what the sender actually sent, and it
 *      is the thing a reader needs when they want to check an amount or a domain
 *      against what we produced.
 *   2. It renders as **text**, never as HTML. The translated string goes into a
 *      `<p>` through React's normal escaping — the sanitize/sandbox/CSP stack exists
 *      for the sender's HTML, and model output has no business borrowing it.
 */

/**
 * The offered languages.
 *
 * A short list rather than every BCP-47 tag: the API accepts any tag, so the control
 * is a convenience and not a restriction — but a `<select>` of nine hundred entries is
 * not a control anybody uses. The user's own default is added to it below if it is not
 * already here.
 */
const LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "de", label: "German" },
  { code: "ar", label: "Arabic" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
];

async function postTranslate(messageId: string, targetLang: string): Promise<unknown> {
  const response = await fetch(`/api/proxy/messages/${messageId}/translate`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ targetLang }),
  });

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!response.ok) {
    // Surfaced as-is: "daily AI call cap reached" is more useful than "failed".
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

export interface TranslateControlProps {
  messageId: string;
  /** `UserSettings.translationLang` from the thread read, or null. */
  defaultLang: string | null;
}

export function TranslateControl({ messageId, defaultLang }: TranslateControlProps) {
  const [lang, setLang] = useState(defaultLang ?? "en");
  const [translation, setTranslation] = useState<TranslationDto | null>(null);

  const translate = useMutation({
    mutationFn: async () => translationSchema.parse(await postTranslate(messageId, lang)),
    onSuccess: (data) => setTranslation(data),
  });

  const options =
    defaultLang !== null && !LANGUAGES.some((option) => option.code === defaultLang)
      ? [{ code: defaultLang, label: defaultLang }, ...LANGUAGES]
      : LANGUAGES;

  const stale = translation !== null && translation.targetLang !== lang;

  return (
    <div className="border-t border-line bg-panel/50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Languages aria-hidden="true" className="size-3.5 text-muted" />
        <label htmlFor={`translate-${messageId}`} className="text-xs text-muted">
          Translate to
        </label>
        <select
          id={`translate-${messageId}`}
          value={lang}
          onChange={(event) => setLang(event.target.value)}
          className="h-8 rounded-[var(--radius-control)] border border-line-strong bg-surface px-2 text-xs text-ink transition-colors hover:bg-raised"
        >
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>

        <Button
          size="sm"
          variant="outline"
          onClick={() => translate.mutate()}
          disabled={translate.isPending}
        >
          {translate.isPending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Languages aria-hidden="true" />
          )}
          {translation === null || stale ? "Translate" : "Retranslate"}
        </Button>

        {translation !== null && !stale && (
          <span className="text-xs text-muted">
            {translation.fromCache
              ? "From cache — no new AI call."
              : `Translated by ${translation.model}.`}
          </span>
        )}
      </div>

      {translate.isError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {translate.error.message}
        </p>
      )}

      {translation !== null && !stale && (
        <section
          aria-label={`Translation to ${translation.targetLang}`}
          className="mt-3 rounded-[var(--radius-control)] border border-line bg-surface px-3.5 py-3"
        >
          <p className="max-w-[74ch] text-xs leading-relaxed text-muted">
            <span className="sr-only">AI-generated: </span>
            {`Machine translation${
              translation.sourceLang === null ? "" : ` from ${translation.sourceLang}`
            } to ${translation.targetLang}. The original above is what the sender actually wrote — check names, amounts and links against it.`}
          </p>
          {/*
            Rendered as text, and the `whitespace-pre-wrap` is what preserves the
            paragraphs the prompt asked the model to keep. Never HTML: the sandboxing
            stack downstairs is for the sender's markup, not for model output.
          */}
          <p className="mt-2 max-w-[74ch] whitespace-pre-wrap text-sm leading-relaxed text-ink">
            {translation.translatedText}
          </p>
        </section>
      )}
    </div>
  );
}
