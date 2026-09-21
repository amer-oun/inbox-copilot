/**
 * Building the document an email body is rendered inside.
 *
 * The API has already run DOMPurify over this HTML and moved every remote source
 * into `data-blocked-*`. This is the second layer, and it assumes the first one
 * failed:
 *
 *   - the body goes into an **iframe**, so the email's CSS cannot restyle the app
 *     around it and its DOM is not our DOM;
 *   - the iframe is **sandboxed**, so even a script that survived sanitization
 *     cannot run, and the frame has no access to our origin, storage or cookies;
 *   - the document carries its own **CSP** with `default-src 'none'`, so nothing
 *     loads that we did not decide to allow — in particular `img-src` is `data:`
 *     only until the reader asks for images.
 *
 * Three independent things would each have to fail for an email to execute code or
 * report that it was opened.
 */

/** Attribute pairs the sanitizer parked, and where they go when restored. */
const BLOCKED_ATTRIBUTES = [
  ["data-blocked-src", "src"],
  ["data-blocked-srcset", "srcset"],
  ["data-blocked-background", "background"],
  ["data-blocked-poster", "poster"],
] as const;

/**
 * Schemes a restored image may use.
 *
 * Checked here even though the API validated on the way out: this is the step that
 * turns an attribute into a live fetch, so it does its own checking rather than
 * trusting that the value upstream is what upstream intended.
 */
const RESTORABLE_SCHEME = /^https?:\/\//i;

/**
 * Puts blocked image sources back, by parsing rather than by string surgery.
 *
 * `DOMParser` builds an inert document: nothing loads, nothing executes, and the
 * result is serialized back to a string for `srcdoc`. A regex over HTML would be
 * the wrong tool here — the input is attacker-authored markup, and that is exactly
 * where regexes get fooled.
 */
export function restoreBlockedImages(html: string): string {
  if (typeof DOMParser === "undefined") {
    // Server-rendered pass: no DOM to parse with, so nothing is restored. The
    // reader's click happens in the browser, where this function runs for real.
    return html;
  }

  const document = new DOMParser().parseFromString(html, "text/html");

  for (const [blockedName, liveName] of BLOCKED_ATTRIBUTES) {
    for (const element of document.querySelectorAll(`[${blockedName}]`)) {
      const value = element.getAttribute(blockedName);
      element.removeAttribute(blockedName);

      if (value === null) continue;
      // A protocol-relative URL is remote and fine to load once the reader asked;
      // it needs a scheme to work inside `srcdoc`, which has no base URL.
      const url = value.startsWith("//") ? `https:${value}` : value;
      if (!RESTORABLE_SCHEME.test(url)) continue;

      element.setAttribute(liveName, url);
    }
  }

  return document.body.innerHTML;
}

/**
 * Styles for the frame's own document.
 *
 * Deliberately minimal and unopinionated: an email brings its own design, and
 * restyling it is both rude and a way to make a phishing mail look native. This
 * only sets a readable default for bodies that specify nothing.
 *
 * **Light in both themes, on purpose.** This used to carry a
 * `prefers-color-scheme: dark` block that flipped the body to a dark ground — and
 * it could only ever have worked for the plain-text-ish minority of mail. A real
 * email specifies its own colours inline: black text on cells it expects to be
 * white, logos on transparent PNGs cut for a white page, `bgcolor="#ffffff"` on
 * half a table. Darkening the ground *underneath* all that does not darken the
 * email; it produces black-on-black paragraphs and white boxes floating in a dark
 * frame, and every one of those failures looks like our rendering bug rather than
 * the sender's design. `color-scheme: light` is part of it: without it the frame's
 * form controls and scrollbars would still render dark inside a white document.
 *
 * The app around the frame is themed; the sender's content is not ours to re-light.
 */
const FRAME_STYLES = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1c1f26;
    padding: 16px;
    overflow-wrap: break-word;
    word-break: break-word;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #2d5bd7; }
  blockquote {
    margin: 0 0 0 12px;
    padding-left: 12px;
    border-left: 2px solid #d8dbe3;
    color: #555b69;
  }
`;

export interface EmailFrameOptions {
  /** Sanitized HTML from the API. Never raw sender HTML. */
  html: string;
  /** True once the reader has explicitly asked for remote images. */
  loadRemoteImages: boolean;
}

/**
 * The complete document for the iframe's `srcdoc`.
 *
 * The CSP is the part that matters. `default-src 'none'` means no scripts, no
 * fonts, no frames, no fetches, no form posts; `img-src` is widened from `data:`
 * to the network only when the reader has asked for images, which is what makes
 * "images are blocked" a true statement rather than a label on a checkbox.
 */
export function buildEmailFrameSrcDoc(options: EmailFrameOptions): string {
  const body = options.loadRemoteImages
    ? restoreBlockedImages(options.html)
    : options.html;

  const imgSrc = options.loadRemoteImages ? "https: http: data:" : "data:";

  const policy = [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    // Email is inline styles and nothing else; `<style>` blocks were stripped.
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    // No referrer on any request the frame is allowed to make, so a loaded image
    // cannot tell the sender which page it was viewed from.
    '<meta name="referrer" content="no-referrer">',
    `<style>${FRAME_STYLES}</style>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

/**
 * The sandbox flags for the iframe element.
 *
 * `allow-popups` plus `allow-popups-to-escape-sandbox` is the one concession, and
 * it is what makes links in email work: without the first, a `target="_blank"`
 * link does nothing; without the second, the page it opens inherits this sandbox
 * and appears broken. A popup can only be opened by the reader clicking a link —
 * there is no script in the frame to open one unasked — and the sanitizer put
 * `rel="noopener noreferrer"` on every anchor, so the opened tab gets no handle
 * back and no referrer.
 *
 * Notably absent: `allow-scripts` (nothing may execute), `allow-same-origin`
 * (the frame must stay in an opaque origin), `allow-forms`, `allow-modals` and
 * `allow-top-navigation` (a mail link must not be able to navigate the app).
 */
export const EMAIL_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";
