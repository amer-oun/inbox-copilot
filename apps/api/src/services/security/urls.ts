import type { Lookalike, LinkMismatch, UrlSignals } from "@inbox-copilot/shared";

/**
 * Layer 2 of §6, the URL half: what the links in a message actually point at.
 *
 * Everything here is string work on hostile input, so it is written to be total —
 * every function returns something for every input, and an unparseable URL is "no
 * signal" rather than an exception. A phishing check that throws on a malformed href
 * is a phishing check an attacker can turn off by sending a malformed href.
 */

/**
 * Multi-label public suffixes we treat as one unit.
 *
 * Not the full Public Suffix List, deliberately: the list is ~10,000 lines that
 * changes monthly, and pulling it in as a dependency to compare two domains is more
 * moving parts than the check deserves. What this covers is the suffixes that appear
 * in real mail, and the failure mode of a miss is conservative in the right
 * direction — an unlisted `foo.co.zz` reduces to `co.zz`, which makes two *different*
 * senders look like the same party, and a sender that looks familiar is not flagged.
 * We would rather miss a lookalike than invent one.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "sch.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "co.za",
  "org.za",
  "com.br",
  "net.br",
  "org.br",
  "com.mx",
  "com.ar",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "co.kr",
  "or.kr",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "com.sg",
  "com.tr",
  "com.tn",
  "com.eg",
  "com.sa",
  "co.in",
  "net.in",
  "org.in",
  "com.pk",
  "com.ua",
  "co.il",
  "com.pl",
  "com.es",
  "com.it",
]);

/**
 * The registrable domain ("eTLD+1") of a host: the part a person can buy.
 *
 * This is the unit every comparison in §6 uses, because it is the unit that
 * corresponds to "the same party". `bounces.mail.stripe.com` and `stripe.com` are
 * one sender; `stripe.com.pay-now.example` and `stripe.com` are not, and only a
 * suffix-aware comparison tells those two cases apart.
 */
export function registrableDomain(host: string | null): string | null {
  if (host === null) return null;

  const cleaned = host.trim().toLowerCase().replace(/\.+$/, "");
  if (cleaned === "" || cleaned.includes(" ")) return null;
  // An IP literal has no registrable domain; it is the host, and the raw-IP rule is
  // what has an opinion about it.
  if (isRawIpHost(cleaned)) return cleaned;

  const labels = cleaned.split(".").filter((label) => label !== "");
  if (labels.length <= 2) return labels.join(".") === "" ? null : labels.join(".");

  const lastTwo = labels.slice(-2).join(".");
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** An IPv4 dotted quad, or a bracketed IPv6 literal. */
export function isRawIpHost(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** True when any label is punycode, i.e. the host renders as non-Latin script. */
export function isPunycodeHost(host: string): boolean {
  return host
    .toLowerCase()
    .split(".")
    .some((label) => label.startsWith("xn--"));
}

/**
 * Confusable characters, mapped to the ASCII letter they impersonate.
 *
 * Every entry is one code point to one character, which keeps normalization
 * length-preserving — so a Levenshtein distance computed over normalized strings
 * still counts *edits an attacker made*, rather than counting the normalization. That
 * property is what makes "distance 0 after normalization" a meaningful category of
 * its own: the attacker changed nothing but the alphabet.
 *
 * Cyrillic and Greek are here because they are what is actually used; the digit
 * substitutions are here because `paypa1.com` and `g00gle.com` predate them.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  "а": "a", // а
  "е": "e", // е
  "о": "o", // о
  "р": "p", // р
  "с": "c", // с
  "у": "y", // у
  "х": "x", // х
  "і": "i", // і
  "ѕ": "s", // ѕ
  "ј": "j", // ј
  "һ": "h", // һ
  "к": "k", // к
  "м": "m", // м
  "т": "t", // т
  "в": "b", // в
  // Greek
  "ο": "o", // ο
  "α": "a", // α
  "ε": "e", // ε
  "ρ": "p", // ρ
  "ν": "v", // ν
  "κ": "k", // κ
  "τ": "t", // τ
  // Latin letters with marks that read as the bare letter at a glance
  "à": "a",
  "á": "a",
  "â": "a",
  "ä": "a",
  "è": "e",
  "é": "e",
  "ê": "e",
  "ì": "i",
  "í": "i",
  "ò": "o",
  "ó": "o",
  "ô": "o",
  "ö": "o",
  "ù": "u",
  "ú": "u",
  "ü": "u",
  // Digits worn as letters
  "0": "o",
  "1": "l",
  "5": "s",
};

/**
 * Folds a domain to the shape a hurried reader sees.
 *
 * Applied to *both* sides of every comparison, so a legitimate domain containing a
 * digit is normalized the same way as an attacker's imitation of it and the two still
 * match each other.
 */
export function normalizeHomoglyphs(value: string): string {
  // NFKC first: it collapses fullwidth and mathematical variants onto plain ASCII,
  // which is a whole family of confusables we then do not have to list.
  const normalized = value.normalize("NFKC").toLowerCase();
  let folded = "";
  for (const character of normalized) {
    folded += CONFUSABLES[character] ?? character;
  }
  // A hyphen is invisible enough in a rendered link to be worth ignoring:
  // `pay-pal.com` and `paypal.com` are the same word to a reader.
  return folded.replace(/-/g, "");
}

/**
 * Levenshtein distance, abandoned once it provably exceeds `max`.
 *
 * The bound is not only a speed optimization: it is how the caller expresses "no
 * longer a lookalike, just a different domain", and returning `max + 1` rather than a
 * true distance keeps this function from being read as a similarity metric.
 */
export function levenshtein(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current[j] = value;
      if (value < best) best = value;
    }

    // Every remaining row can only grow this minimum, so nothing below can come back
    // under the bound.
    if (best > max) return max + 1;
    previous = current;
  }

  return previous[b.length] ?? max + 1;
}

/**
 * Domains shorter than this are not compared: at four or five characters, one edit is
 * a large fraction of the name and half the internet is a "lookalike" of the other
 * half.
 */
const MIN_COMPARABLE_LENGTH = 5;

/**
 * How far apart two domains may be and still be an imitation rather than a different
 * company. Scaled by length, because one edit in `vk.com` is a different claim from
 * one edit in `international-shipping.com`.
 */
export function maxLookalikeDistance(length: number): number {
  return length >= 12 ? 2 : 1;
}

/**
 * Whether `domain` is imitating one of `known`, and which.
 *
 * Two distinct findings share this return shape, and the difference is in
 * `viaHomoglyphs`:
 *
 *   - distance 0 with `viaHomoglyphs` true — the domain is character-for-character
 *     the known one once confusables are folded. There is no innocent explanation for
 *     that;
 *   - distance 1-2 — a typo-squat, which is also how a legitimate unrelated company
 *     occasionally looks. Scored, but not on its own conclusive.
 *
 * A domain that *is* in the known set returns null: the user corresponds with it.
 */
export function lookalikeOf(
  domain: string | null,
  known: ReadonlySet<string>,
): Lookalike | null {
  if (domain === null || domain.length < MIN_COMPARABLE_LENGTH) return null;
  if (known.has(domain)) return null;

  const foldedDomain = normalizeHomoglyphs(domain);
  let best: Lookalike | null = null;

  for (const candidate of known) {
    if (candidate.length < MIN_COMPARABLE_LENGTH) continue;

    const foldedCandidate = normalizeHomoglyphs(candidate);
    // Identical after folding *and* different before it: the alphabet was the attack.
    if (foldedDomain === foldedCandidate) {
      return { domain, resembles: candidate, distance: 0, viaHomoglyphs: true };
    }

    const limit = maxLookalikeDistance(Math.max(foldedDomain.length, foldedCandidate.length));
    const distance = levenshtein(foldedDomain, foldedCandidate, limit);
    if (distance > limit) continue;

    if (best === null || distance < best.distance) {
      best = {
        domain,
        resembles: candidate,
        distance,
        // The fold mattered if it changed this domain at all.
        viaHomoglyphs: foldedDomain !== domain.toLowerCase().replace(/-/g, ""),
      };
    }
  }

  return best;
}

export interface ExtractedLink {
  href: string;
  /** The anchor's visible text, or null for a bare URL in plain text. */
  shown: string | null;
}

/** Schemes worth following. `mailto:` and `tel:` are links but not destinations. */
const HTTP_SCHEME = /^https?:$/i;

/** The host of a URL, or null when it is not an absolute http(s) URL. */
export function hostOf(href: string): string | null {
  try {
    const url = new URL(href.trim());
    if (!HTTP_SCHEME.test(url.protocol)) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Anchors from HTML, plus bare URLs from the plain-text body.
 *
 * Regex over HTML rather than a parse, and that is a considered choice: this runs on
 * every inbound message, the extraction only has to be good enough to *raise
 * suspicion*, and a missed link means one fewer signal rather than a wrong verdict.
 * The rendering path, where being wrong is dangerous, uses a real sanitizer
 * (`services/security/sanitize.ts`).
 */
export function extractLinks(html: string | null, text: string | null): ExtractedLink[] {
  const links: ExtractedLink[] = [];

  if (html !== null) {
    const anchors = html.matchAll(
      /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a>/gi,
    );
    for (const anchor of anchors) {
      const href = anchor[1] ?? anchor[2] ?? anchor[3] ?? "";
      const shown = (anchor[4] ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
      if (href !== "") links.push({ href, shown: shown === "" ? null : shown });
    }
  }

  if (text !== null) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
      // Trailing punctuation belongs to the sentence, not the URL.
      links.push({ href: match[0].replace(/[.,;:!?]+$/, ""), shown: null });
    }
  }

  return links;
}

/** A hostname-shaped token inside link text. */
const HOST_IN_TEXT = /\b((?:[a-z0-9-￿](?:[a-z0-9-￿-]*[a-z0-9-￿])?\.)+[a-z-￿]{2,})\b/i;

/**
 * The domain a link's *text* claims, when it claims one.
 *
 * Only text that looks like a bare hostname or URL counts. "Click here" claims
 * nothing and is not a mismatch, however hostile the link behind it — that case is
 * the model's to judge from the prose, not a deterministic rule's.
 */
export function claimedHostOf(shown: string | null): string | null {
  if (shown === null) return null;

  const direct = hostOf(shown);
  if (direct !== null) return direct;

  const match = HOST_IN_TEXT.exec(shown.replace(/^[a-z]+:\/\//i, ""));
  if (match === null) return null;
  const host = (match[1] ?? "").toLowerCase();
  // Require a plausible TLD rather than accepting "invoice.pdf" or "v1.2" as a host.
  return /\.[a-z-￿]{2,}$/i.test(host) && !/\.(pdf|docx?|xlsx?|zip|png|jpe?g)$/i.test(host)
    ? host
    : null;
}

export interface UrlSignalInput {
  bodyHtml: string | null;
  bodyText: string | null;
  knownDomains: ReadonlySet<string>;
}

/**
 * Reads the links into signals.
 *
 * Each finding is deduplicated by host: a marketing mail with forty tracking links to
 * one raw IP is one problem, and a reason list that says so forty times is a reason
 * list nobody reads.
 */
export function urlSignals(input: UrlSignalInput): UrlSignals {
  const links = extractLinks(input.bodyHtml, input.bodyText);

  const rawIpHosts = new Set<string>();
  const punycodeHosts = new Set<string>();
  const lookalikes = new Map<string, Lookalike>();
  const mismatches = new Map<string, LinkMismatch>();
  const hosts = new Set<string>();

  for (const link of links) {
    const host = hostOf(link.href);
    if (host === null) continue;
    hosts.add(host);

    if (isRawIpHost(host)) rawIpHosts.add(host);
    if (isPunycodeHost(host)) punycodeHosts.add(host);

    const domain = registrableDomain(host);
    if (domain !== null && !isRawIpHost(host)) {
      const lookalike = lookalikeOf(domain, input.knownDomains);
      if (lookalike !== null && !lookalikes.has(domain)) lookalikes.set(domain, lookalike);
    }

    const claimed = claimedHostOf(link.shown);
    if (claimed === null) continue;

    const claimedDomain = registrableDomain(claimed);
    /*
     * Compared on the registrable domain: a newsletter whose text reads
     * "example.com" and whose href is `links.example.com/track/…` is doing ordinary
     * click tracking, not lying about where the link goes.
     */
    if (claimedDomain !== null && domain !== null && claimedDomain !== domain) {
      const key = `${claimed}>${host}`;
      if (!mismatches.has(key)) mismatches.set(key, { shownHost: claimed, actualHost: host });
    }
  }

  return {
    linkCount: hosts.size,
    rawIpHosts: [...rawIpHosts],
    punycodeHosts: [...punycodeHosts],
    displayMismatches: [...mismatches.values()],
    lookalikeHosts: [...lookalikes.values()],
  };
}
