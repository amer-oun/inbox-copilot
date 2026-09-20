import { describe, expect, it } from "vitest";
import {
  claimedHostOf,
  extractLinks,
  hostOf,
  isPunycodeHost,
  isRawIpHost,
  levenshtein,
  lookalikeOf,
  maxLookalikeDistance,
  normalizeHomoglyphs,
  registrableDomain,
  urlSignals,
} from "./urls.js";

/**
 * Layer 2's string work (§6).
 *
 * These are pure functions over hostile input, so the tests that matter are the ones
 * that would let a real attack through or flag a real sender: a subdomain read as a
 * different party, a tracking link read as a lie, a Cyrillic homoglyph read as ASCII.
 */

describe("registrableDomain", () => {
  it("reduces a subdomain to the party that owns it", () => {
    // The check that prevents flagging every large sender: bounce and tracking
    // subdomains are the same company as the bare domain.
    expect(registrableDomain("bounces.mail.stripe.com")).toBe("stripe.com");
    expect(registrableDomain("stripe.com")).toBe("stripe.com");
  });

  it("does not let a suffix-shaped subdomain impersonate a party", () => {
    // The classic: the real registrable domain here is the attacker's.
    expect(registrableDomain("paypal.com.secure-login.example")).toBe(
      "secure-login.example",
    );
  });

  it("knows the multi-label suffixes that appear in real mail", () => {
    expect(registrableDomain("mail.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("news.com.au")).toBe("news.com.au");
  });

  it("normalizes case and a trailing root dot", () => {
    expect(registrableDomain("Mail.Example.COM.")).toBe("example.com");
  });

  it("returns an IP literal unchanged, having no registrable part", () => {
    expect(registrableDomain("203.0.113.9")).toBe("203.0.113.9");
  });

  it("returns null for nothing and for junk", () => {
    expect(registrableDomain(null)).toBeNull();
    expect(registrableDomain("   ")).toBeNull();
    expect(registrableDomain("not a host")).toBeNull();
  });
});

describe("isRawIpHost", () => {
  it("recognizes IPv4 and bracketed IPv6", () => {
    expect(isRawIpHost("203.0.113.9")).toBe(true);
    expect(isRawIpHost("[2001:db8::1]")).toBe(true);
  });

  it("does not mistake a dotted name or an out-of-range quad for an address", () => {
    expect(isRawIpHost("a.b.c.d")).toBe(false);
    expect(isRawIpHost("999.1.1.1")).toBe(false);
    expect(isRawIpHost("203.0.113.9.example.com")).toBe(false);
  });
});

describe("isPunycodeHost", () => {
  it("finds an xn-- label anywhere in the host", () => {
    expect(isPunycodeHost("xn--80ak6aa92e.com")).toBe(true);
    expect(isPunycodeHost("login.xn--pple-43d.com")).toBe(true);
    expect(isPunycodeHost("example.com")).toBe(false);
  });
});

describe("normalizeHomoglyphs", () => {
  it("folds Cyrillic lookalikes onto the ASCII they impersonate", () => {
    // "аpple" with a Cyrillic а.
    expect(normalizeHomoglyphs("аpple.com")).toBe("apple.com");
  });

  it("folds digits worn as letters", () => {
    expect(normalizeHomoglyphs("paypa1.com")).toBe("paypal.com");
    expect(normalizeHomoglyphs("g00gle.com")).toBe("google.com");
  });

  it("folds fullwidth characters via NFKC without listing them", () => {
    expect(normalizeHomoglyphs("ｅxample.com")).toBe("example.com");
  });

  it("ignores hyphens, which a reader's eye also does", () => {
    expect(normalizeHomoglyphs("pay-pal.com")).toBe(normalizeHomoglyphs("paypal.com"));
  });

  it("is length-preserving apart from hyphens", () => {
    /*
     * The property the distance calculation depends on: folding must not itself count
     * as an edit, or a homoglyph domain would look further from its target than a
     * typo-squat is.
     */
    const folded = normalizeHomoglyphs("аеорс");
    expect(folded).toHaveLength(5);
    expect(folded).toBe("aeopc");
  });
});

describe("levenshtein", () => {
  it("measures ordinary edits", () => {
    expect(levenshtein("example.com", "example.com")).toBe(0);
    expect(levenshtein("example.com", "exarnple.com", 3)).toBe(2);
  });

  it("gives up past the bound rather than reporting a real distance", () => {
    // `max + 1` rather than the true distance, so nothing downstream can read the
    // return as a similarity score.
    expect(levenshtein("example.com", "completely-different.com", 2)).toBe(3);
  });
});

describe("lookalikeOf", () => {
  const known = new Set(["northwind.example", "paypal.com", "example.com", "vk.com"]);

  it("reports a homoglyph domain as distance 0", () => {
    // "pаypal.com" with a Cyrillic а: identical once folded, so the alphabet was the
    // whole attack and there is no innocent reading of it.
    const found = lookalikeOf("pаypal.com", known);
    expect(found).toEqual({
      domain: "pаypal.com",
      resembles: "paypal.com",
      distance: 0,
      viaHomoglyphs: true,
    });
  });

  it("reports a typo-squat with its distance", () => {
    const found = lookalikeOf("northwlnd.example", known);
    expect(found?.resembles).toBe("northwind.example");
    expect(found?.distance).toBeGreaterThan(0);
  });

  it("says nothing about a domain the user actually corresponds with", () => {
    expect(lookalikeOf("paypal.com", known)).toBeNull();
  });

  it("says nothing about an unrelated domain", () => {
    expect(lookalikeOf("some-other-company.test", known)).toBeNull();
  });

  it("is stricter on short domains than on long ones", () => {
    /*
     * One edit is most of a six-character domain. Allowing distance 2 there would make
     * half the internet a lookalike of the other half, so the bound scales with length.
     */
    expect(maxLookalikeDistance(6)).toBe(1);
    expect(maxLookalikeDistance(20)).toBe(2);
    expect(lookalikeOf("wk.net", known)).toBeNull();
  });

  it("ignores reference domains too short to compare", () => {
    expect(lookalikeOf("abcd.io", new Set(["ab.io"]))).toBeNull();
  });
});

describe("extractLinks", () => {
  it("reads anchors out of HTML with their visible text", () => {
    const links = extractLinks(
      `<p>Please <a href="https://evil.example/login" style="color:red">paypal.com</a> now</p>`,
      null,
    );
    expect(links).toEqual([{ href: "https://evil.example/login", shown: "paypal.com" }]);
  });

  it("reads unquoted and single-quoted hrefs", () => {
    expect(
      extractLinks(`<a href=https://a.test>a</a><a href='https://b.test'>b</a>`, null),
    ).toEqual([
      { href: "https://a.test", shown: "a" },
      { href: "https://b.test", shown: "b" },
    ]);
  });

  it("strips nested markup out of the visible text", () => {
    const links = extractLinks(
      `<a href="https://a.test"><span>click</span> <b>here</b></a>`,
      null,
    );
    expect(links[0]?.shown).toBe("click here");
  });

  it("finds bare URLs in plain text and drops trailing punctuation", () => {
    const links = extractLinks(null, "Go to https://a.test/page, then stop.");
    expect(links).toEqual([{ href: "https://a.test/page", shown: null }]);
  });
});

describe("hostOf and claimedHostOf", () => {
  it("only accepts http(s) destinations", () => {
    expect(hostOf("https://a.test/x")).toBe("a.test");
    expect(hostOf("mailto:someone@a.test")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });

  it("reads a host out of link text, whether or not it is a full URL", () => {
    expect(claimedHostOf("https://paypal.com/login")).toBe("paypal.com");
    expect(claimedHostOf("paypal.com")).toBe("paypal.com");
    expect(claimedHostOf("Visit paypal.com today")).toBe("paypal.com");
  });

  it("claims nothing for text that names no destination", () => {
    // "Click here" is not a mismatch however hostile the link behind it — that case is
    // the model's to judge from the prose, not a rule's.
    expect(claimedHostOf("Click here")).toBeNull();
    expect(claimedHostOf(null)).toBeNull();
  });

  it("does not read a filename as a host", () => {
    expect(claimedHostOf("invoice.pdf")).toBeNull();
    expect(claimedHostOf("statement.docx")).toBeNull();
  });
});

describe("urlSignals", () => {
  const known = new Set(["paypal.com", "example.com"]);

  it("reports a link whose text disagrees with its destination", () => {
    const signals = urlSignals({
      bodyHtml: `<a href="https://secure-paypal.test/login">paypal.com</a>`,
      bodyText: null,
      knownDomains: known,
    });

    expect(signals.displayMismatches).toEqual([
      { shownHost: "paypal.com", actualHost: "secure-paypal.test" },
    ]);
  });

  it("does not call ordinary click tracking a mismatch", () => {
    /*
     * The false positive that would ruin this rule: a newsletter whose text says
     * "example.com" and whose href is a tracking subdomain of the same party. Comparing
     * registrable domains is what keeps that quiet.
     */
    const signals = urlSignals({
      bodyHtml: `<a href="https://links.example.com/t/abc123">example.com</a>`,
      bodyText: null,
      knownDomains: known,
    });

    expect(signals.displayMismatches).toEqual([]);
  });

  it("reports raw-IP and punycode destinations", () => {
    const signals = urlSignals({
      bodyHtml: `<a href="http://203.0.113.9/pay">Pay now</a><a href="https://xn--pypal-4ve.com/x">Account</a>`,
      bodyText: null,
      knownDomains: known,
    });

    expect(signals.rawIpHosts).toEqual(["203.0.113.9"]);
    expect(signals.punycodeHosts).toEqual(["xn--pypal-4ve.com"]);
  });

  it("reports a link to a domain that resembles a known one", () => {
    const signals = urlSignals({
      bodyHtml: `<a href="https://paypa1.com/login">Sign in</a>`,
      bodyText: null,
      knownDomains: known,
    });

    expect(signals.lookalikeHosts[0]).toMatchObject({
      domain: "paypa1.com",
      resembles: "paypal.com",
    });
  });

  it("deduplicates by host, so forty tracking links are one finding", () => {
    const anchors = Array.from(
      { length: 40 },
      (_, index) => `<a href="http://203.0.113.9/t/${index}">x</a>`,
    ).join("");

    const signals = urlSignals({
      bodyHtml: anchors,
      bodyText: null,
      knownDomains: known,
    });

    expect(signals.rawIpHosts).toHaveLength(1);
    expect(signals.linkCount).toBe(1);
  });

  it("finds nothing in a body with no links", () => {
    const signals = urlSignals({
      bodyHtml: null,
      bodyText: "Thanks — see you Tuesday.",
      knownDomains: known,
    });

    expect(signals).toEqual({
      linkCount: 0,
      rawIpHosts: [],
      punycodeHosts: [],
      displayMismatches: [],
      lookalikeHosts: [],
    });
  });

  it("does not throw on a malformed href", () => {
    // A phishing check an attacker can switch off with a broken URL is not a check.
    expect(() =>
      urlSignals({
        bodyHtml: `<a href="http://[not-an-address">x</a><a href="">y</a>`,
        bodyText: null,
        knownDomains: known,
      }),
    ).not.toThrow();
  });
});
