import { describe, expect, it } from "vitest";
import {
  dmarcVouchesFor,
  domainOf,
  headerSignals,
  parseStoredAuthResults,
} from "./headers.js";

/**
 * Layer 1 (§6): header truth.
 *
 * The rule under test throughout is the one phase 2 wrote the column for: **a missing
 * verdict is not a pass.** Most of these cases exist to prove that an absence stays an
 * absence — reported, scoreable, and never silently converted into "fine".
 */

function auth(overrides: Record<string, unknown> = {}) {
  return {
    spf: "pass",
    dkim: "pass",
    dmarc: "pass",
    returnPath: "bounce@example.com",
    displayNameMismatch: false,
    ...overrides,
  };
}

describe("domainOf", () => {
  it("takes the part after the last @", () => {
    // A display name may contain an address, so the last @ is the real separator.
    expect(domainOf("dana@northwind.example")).toBe("northwind.example");
    expect(domainOf("billing@paypal.com <attacker@evil.test>")).toBe("evil.test");
  });

  it("lower-cases and trims trailing punctuation", () => {
    expect(domainOf("Dana@Northwind.Example>")).toBe("northwind.example");
  });

  it("returns null for anything that is not an address", () => {
    expect(domainOf(null)).toBeNull();
    expect(domainOf("")).toBeNull();
    expect(domainOf("no-at-sign")).toBeNull();
    expect(domainOf("trailing@")).toBeNull();
  });
});

describe("parseStoredAuthResults", () => {
  it("reads the column written by the sync engine", () => {
    expect(parseStoredAuthResults(auth())).toEqual({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      returnPath: "bounce@example.com",
      displayNameMismatch: false,
    });
  });

  it("reduces an unreadable column to nothing known, not to safe", () => {
    for (const value of [null, undefined, "pass", 42, []]) {
      expect(parseStoredAuthResults(value)).toEqual({
        spf: null,
        dkim: null,
        dmarc: null,
        returnPath: null,
        displayNameMismatch: false,
      });
    }
  });

  it("drops a verdict it does not recognize rather than passing it through", () => {
    // An unknown string must not reach the rules, where it would match no case and
    // therefore score as though the check had passed.
    expect(parseStoredAuthResults(auth({ dmarc: "definitely-fine" })).dmarc).toBeNull();
  });

  it("treats anything but true as 'no mismatch found', not 'the name is fine'", () => {
    expect(
      parseStoredAuthResults(auth({ displayNameMismatch: "yes" })).displayNameMismatch,
    ).toBe(false);
    expect(
      parseStoredAuthResults(auth({ displayNameMismatch: true })).displayNameMismatch,
    ).toBe(true);
  });
});

describe("headerSignals", () => {
  it("compares alignment on the registrable domain, not the full host", () => {
    /*
     * The false positive that would make this layer unusable: every large sender bounces
     * mail through a subdomain, and calling that a misalignment would flag all of them.
     */
    const signals = headerSignals({
      authResults: auth({ returnPath: "bounce@bounces.mail.example.com" }),
      fromEmail: "news@example.com",
      replyTo: null,
    });

    expect(signals.returnPathAligned).toBe(true);
    expect(signals.returnPathDomain).toBe("example.com");
  });

  it("reports a Return-Path pointing at another party", () => {
    const signals = headerSignals({
      authResults: auth({ returnPath: "bounce@mailer.other.test" }),
      fromEmail: "billing@example.com",
      replyTo: null,
    });

    expect(signals.returnPathAligned).toBe(false);
  });

  it("reports an unrecorded Return-Path as unknown rather than aligned", () => {
    // `null`, not `false` and not `true`: the whole point of this layer is that "we
    // never saw one" is a third answer.
    const signals = headerSignals({
      authResults: auth({ returnPath: null }),
      fromEmail: "billing@example.com",
      replyTo: null,
    });

    expect(signals.returnPathAligned).toBeNull();
  });

  it("does not call a same-party Reply-To a difference", () => {
    const signals = headerSignals({
      authResults: auth(),
      fromEmail: "support@example.com",
      replyTo: "tickets@help.example.com",
    });

    expect(signals.replyToDiffers).toBe(false);
  });

  it("reports a Reply-To that would send the answer elsewhere", () => {
    const signals = headerSignals({
      authResults: auth(),
      fromEmail: "cfo@northwind.example",
      replyTo: "cfo.northwind@gmail.test",
    });

    expect(signals.replyToDiffers).toBe(true);
    expect(signals.replyToDomain).toBe("gmail.test");
  });

  it("carries a missing verdict through as null", () => {
    const signals = headerSignals({
      authResults: { returnPath: null, displayNameMismatch: false },
      fromEmail: "someone@example.com",
      replyTo: null,
    });

    expect(signals.spf).toBeNull();
    expect(signals.dkim).toBeNull();
    expect(signals.dmarc).toBeNull();
  });
});

describe("dmarcVouchesFor", () => {
  it("is true only on an actual pass", () => {
    /*
     * DMARC passes only when SPF or DKIM passes *and* aligns, so a pass makes the
     * underlying results moot — a `dmarc=pass` with `spf=fail` is ordinary forwarded
     * mail. Nothing else may stand in for that pass.
     */
    const base = {
      authResults: auth({ spf: "fail" }),
      fromEmail: "a@b.test",
      replyTo: null,
    };

    expect(dmarcVouchesFor(headerSignals(base))).toBe(true);
    expect(
      dmarcVouchesFor(headerSignals({ ...base, authResults: auth({ dmarc: "none" }) })),
    ).toBe(false);
    expect(
      dmarcVouchesFor(headerSignals({ ...base, authResults: auth({ dmarc: null }) })),
    ).toBe(false);
  });
});
