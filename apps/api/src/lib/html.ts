/**
 * HTML → text, shared by the sync engine and the AI layer.
 *
 * It lives in `lib/` rather than under a provider because both callers need it for
 * provider-independent reasons: the normalized `bodyText` a message is stored with,
 * and the plain text an AI prompt is built from. Script and style *contents* are
 * dropped rather than just their tags (§7 rule 5) — a prompt should never carry a
 * payload that was written to be executed somewhere else.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, " ");
}
