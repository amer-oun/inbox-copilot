import { describe, expect, it } from "vitest";
import {
  buildEmailFrameSrcDoc,
  EMAIL_FRAME_SANDBOX,
  restoreBlockedImages,
} from "./emailFrame";

/**
 * The second layer of email rendering.
 *
 * The API's sanitizer is the first. These tests assume it failed — they check that
 * the frame itself would still contain a hostile body, because the whole point of
 * defence in depth is that each layer holds alone.
 */

describe("the frame's content security policy", () => {
  it("blocks everything by default", () => {
    const doc = buildEmailFrameSrcDoc({ html: "<p>hi</p>", loadRemoteImages: false });

    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("frame-src 'none'");
    expect(doc).toContain("object-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("base-uri 'none'");
  });

  it("permits only data: images until the reader asks", () => {
    // This is what makes "images are blocked" true rather than decorative: even a
    // src the sanitizer missed cannot reach the network.
    const doc = buildEmailFrameSrcDoc({
      html: '<img src="https://track.example/p.gif">',
      loadRemoteImages: false,
    });

    expect(doc).toContain("img-src data:");
    expect(doc).not.toContain("img-src https:");
  });

  it("widens img-src only when images are loaded", () => {
    const doc = buildEmailFrameSrcDoc({ html: "<p>hi</p>", loadRemoteImages: true });
    expect(doc).toContain("img-src https: http: data:");
  });

  it("sends no referrer with anything it does load", () => {
    const doc = buildEmailFrameSrcDoc({ html: "<p>hi</p>", loadRemoteImages: true });
    expect(doc).toContain('name="referrer" content="no-referrer"');
  });

  it("carries no script of its own, so nothing needs to be allowed", () => {
    const doc = buildEmailFrameSrcDoc({ html: "<p>hi</p>", loadRemoteImages: false });
    expect(doc).not.toMatch(/<script/i);
  });
});

describe("the sandbox flags", () => {
  it("withholds script execution and same-origin access", () => {
    expect(EMAIL_FRAME_SANDBOX).not.toContain("allow-scripts");
    expect(EMAIL_FRAME_SANDBOX).not.toContain("allow-same-origin");
  });

  it("withholds top navigation, forms and modals", () => {
    // A mail link must not be able to navigate the app or post a form.
    expect(EMAIL_FRAME_SANDBOX).not.toContain("allow-top-navigation");
    expect(EMAIL_FRAME_SANDBOX).not.toContain("allow-forms");
    expect(EMAIL_FRAME_SANDBOX).not.toContain("allow-modals");
  });

  it("allows popups so that links work, and lets them escape the sandbox", () => {
    // Without the first, clicking a link does nothing; without the second, the page
    // it opens inherits this sandbox and looks broken.
    expect(EMAIL_FRAME_SANDBOX).toContain("allow-popups");
    expect(EMAIL_FRAME_SANDBOX).toContain("allow-popups-to-escape-sandbox");
  });
});

describe("blocked images stay blocked", () => {
  const body = '<img data-blocked-src="https://track.example/p.gif" alt="pixel">';

  it("leaves the parked attribute alone while blocked", () => {
    const doc = buildEmailFrameSrcDoc({ html: body, loadRemoteImages: false });

    expect(doc).toContain("data-blocked-src");
    expect(doc).not.toMatch(/\ssrc="https/);
  });

  it("restores it once the reader asks", () => {
    const doc = buildEmailFrameSrcDoc({ html: body, loadRemoteImages: true });

    expect(doc).toContain('src="https://track.example/p.gif"');
    expect(doc).not.toContain("data-blocked-src");
  });
});

describe("restoreBlockedImages", () => {
  it("restores every parked attribute", () => {
    // The td is inside a table on purpose: HTML parsing discards a bare one, and
    // this function parses rather than string-replaces.
    const out = restoreBlockedImages(
      '<img data-blocked-src="https://a.example/1.png" data-blocked-srcset="https://a.example/2.png 2x">' +
        '<table><tr><td data-blocked-background="https://a.example/bg.png">x</td></tr></table>',
    );

    expect(out).toContain('src="https://a.example/1.png"');
    expect(out).toContain('srcset="https://a.example/2.png 2x"');
    expect(out).toContain('background="https://a.example/bg.png"');
    expect(out).not.toContain("data-blocked");
  });

  it("gives a protocol-relative URL a scheme, since srcdoc has no base", () => {
    const out = restoreBlockedImages('<img data-blocked-src="//a.example/1.png">');
    expect(out).toContain('src="https://a.example/1.png"');
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "about:blank",
  ])("refuses to restore %s", (url) => {
    /*
     * The attribute only becomes a live fetch here, so the check happens here too —
     * rather than trusting that whatever put the value there validated it.
     */
    const out = restoreBlockedImages(`<img data-blocked-src="${url}">`);

    expect(out).not.toContain("src=");
    expect(out).not.toContain("data-blocked-src");
  });

  it("does not execute or fetch while parsing", () => {
    // DOMParser builds an inert document: the onerror never runs, and this test
    // would fail loudly (an unhandled error) if it did.
    const out = restoreBlockedImages(
      '<img data-blocked-src="https://a.example/1.png" onerror="throw new Error(\'ran\')">',
    );
    expect(out).toContain("src=");
  });

  it("leaves a body with nothing parked untouched in substance", () => {
    const out = restoreBlockedImages("<p>hello <b>world</b></p>");
    expect(out).toBe("<p>hello <b>world</b></p>");
  });

  it("is a parse, not a string replace: attribute-looking text is not restored", () => {
    // Text that merely *mentions* the attribute must not become an image source.
    const out = restoreBlockedImages(
      '<p>write data-blocked-src="https://evil.example/x.png" in your email</p>',
    );

    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/\ssrc=/);
  });
});

describe("the frame document", () => {
  it("is a complete document with the body inside it", () => {
    const doc = buildEmailFrameSrcDoc({ html: "<p>hello</p>", loadRemoteImages: false });

    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<p>hello</p>");
    expect(doc).toContain("</body></html>");
  });

  it("styles the frame without restyling the email", () => {
    // An email brings its own design; overriding it also helps phishing look native.
    const doc = buildEmailFrameSrcDoc({ html: "<p>hi</p>", loadRemoteImages: false });

    expect(doc).toContain("img { max-width: 100%");
    expect(doc).not.toMatch(/\bfont-weight\s*:\s*bold\b/);
  });

  it("handles an empty body", () => {
    expect(() =>
      buildEmailFrameSrcDoc({ html: "", loadRemoteImages: false }),
    ).not.toThrow();
  });
});

describe("the frame stays light in a dark app", () => {
  /*
   * A deliberate property, not an oversight. Senders write inline colours for a
   * white page — black text on cells they expect to be white, logos cut on
   * transparent PNGs, `bgcolor="#ffffff"` on half a table. Darkening the ground
   * underneath that produces black-on-black paragraphs and white boxes floating
   * in a dark frame, and every one of those looks like our bug rather than the
   * sender's design. The app around the frame is themed; the mail is not.
   */
  it("declares a light colour scheme and a white ground", () => {
    const doc = buildEmailFrameSrcDoc({ html: "<p>hi</p>", loadRemoteImages: false });
    expect(doc).toContain("color-scheme: light");
    expect(doc).toContain("background: #ffffff");
  });

  it("carries no dark-mode override of its own", () => {
    const doc = buildEmailFrameSrcDoc({ html: "<p>hi</p>", loadRemoteImages: false });
    expect(doc).not.toContain("prefers-color-scheme");
  });
});
