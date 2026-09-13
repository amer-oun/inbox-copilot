import DOMPurify from "isomorphic-dompurify";

/**
 * Email HTML sanitization (§7 rule 5, §6).
 *
 * Email bodies are hostile input written by strangers. Three separate things are
 * dangerous about rendering them, and this file handles two of them:
 *
 *   1. **Script execution.** Anything that runs — `<script>`, `onclick=`,
 *      `javascript:` URLs, `<iframe>`, `<object>`, SVG event handlers — is removed
 *      here. The sandboxed iframe in the web app is the second layer; this is the
 *      first, and neither is trusted alone.
 *   2. **Remote content.** A tracking pixel reports the moment a message is
 *      opened: that the address is live, when it was read, from which IP. Every
 *      remote source is therefore *moved*, not deleted — `src` becomes
 *      `data-blocked-src` — so the reader can choose to load it and the UI can say
 *      how much is waiting. Deleting them would make "load images" impossible;
 *      leaving them would make opening a message a disclosure.
 *   3. Layout escape (a body styling the app around it) is handled by the iframe,
 *      not here: an email's own CSS is part of the email.
 *
 * The allowlist is deliberately narrow. Email HTML is table-soup from 1998, so
 * layout tags and inline styles survive; anything interactive does not.
 */

/** Tags an email may use. Everything else is dropped, contents kept. */
const ALLOWED_TAGS = [
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "center", "cite",
  "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em", "figcaption",
  "figure", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins",
  "li", "mark", "ol", "p", "pre", "q", "s", "small", "span", "strike", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u",
  "ul", "wbr",
];

/**
 * Attributes an email may use.
 *
 * No `id`: ids in a fragment can collide with the host document's, and an email
 * has no legitimate need for one. No `target`/`rel` either — links are rewritten
 * below with our own values rather than the sender's.
 */
const ALLOWED_ATTR = [
  "align", "alt", "bgcolor", "border", "cellpadding", "cellspacing", "class",
  "colspan", "color", "dir", "face", "height", "href", "hreflang", "lang",
  "rowspan", "size", "span", "src", "style", "title", "valign", "width",
];

/** URL schemes a link or image may use. `javascript:` is absent, obviously. */
const ALLOWED_URI_REGEXP = /^(?:https?|mailto|tel|cid|data:image\/(?:png|jpe?g|gif|webp|avif))/i;

/** Attributes that can pull remote content, and must be defused. */
const REMOTE_SOURCE_ATTRS = ["src", "srcset", "background", "poster"] as const;

export interface SanitizedHtml {
  html: string;
  /** Remote images defused. Drives the "load images" control. */
  blockedRemoteImages: number;
}

/**
 * True for a URL that would leave the machine when rendered.
 *
 * Everything except `data:` and `cid:` counts. Those two do not reach the network:
 * a data URI is self-contained, and `cid:` points at an attachment of this same
 * message. A relative URL counts as remote too — it has no base inside a `srcdoc`
 * iframe, so it cannot load anyway, and treating it as remote keeps this test a
 * simple allowlist rather than a list of schemes to think about.
 */
function isRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return !/^(?:data|cid):/i.test(trimmed);
}

/**
 * Sanitizes one email body.
 *
 * Returns the cleaned HTML and how many remote images were defused. Hooks are
 * registered per call and removed afterwards: DOMPurify's hook registry is global
 * and module-scoped, so a leaked hook would apply to every later call — including
 * ones with different intent.
 */
export function sanitizeEmailHtml(html: string | null): SanitizedHtml | null {
  if (html === null || html.trim() === "") return null;

  let blockedRemoteImages = 0;

  const onAttribute = (node: Element): void => {
    for (const attribute of REMOTE_SOURCE_ATTRS) {
      const value = node.getAttribute(attribute);
      if (value === null) continue;

      if (!isRemoteUrl(value)) continue;

      node.removeAttribute(attribute);
      // Kept, not deleted: the reader may choose to load it, and the count above
      // is what the UI offers them.
      node.setAttribute(`data-blocked-${attribute}`, value);
      if (attribute === "src" || attribute === "srcset") blockedRemoteImages += 1;
    }

    /*
     * `style` can fetch too: `background-image: url(https://…)` is a tracking
     * pixel with extra steps. Rather than parsing CSS, any url() with a remote
     * target is stripped from the declaration.
     */
    const style = node.getAttribute("style");
    if (style !== null && /url\(/i.test(style)) {
      const cleaned = style.replace(
        /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi,
        (match, _quote: string, url: string) => (isRemoteUrl(url) ? "none" : match),
      );
      if (cleaned !== style) {
        node.setAttribute("style", cleaned);
        blockedRemoteImages += 1;
      }
    }

    // Links open in a new tab with no referrer and no window handle: a mail link
    // must not be able to navigate the app or read `window.opener`.
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  };

  DOMPurify.addHook("afterSanitizeAttributes", onAttribute);

  try {
    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_URI_REGEXP,
      // Adding these back after sanitization is what the hook above does.
      ADD_ATTR: ["target", "rel"],
      // `<style>` blocks and their contents go entirely: they are a CSS injection
      // surface and can load remote fonts and images.
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input",
        "button", "select", "textarea", "link", "meta", "base", "svg", "math"],
      FORBID_ATTR: ["srcdoc", "formaction", "action", "ping", "id", "name"],
      // No `<html>`/`<body>` wrapper: this is embedded in one we build ourselves.
      WHOLE_DOCUMENT: false,
      // Comments can carry conditional-comment markup for old Outlook.
      KEEP_CONTENT: true,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      SAFE_FOR_TEMPLATES: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
    });

    return { html: clean, blockedRemoteImages };
  } finally {
    // Hooks are global state; leaving this registered would leak into every
    // later sanitize call in the process.
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}
