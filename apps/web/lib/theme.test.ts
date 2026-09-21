import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyTheme, isThemeChoice, THEME_SCRIPT, THEME_STORAGE_KEY } from "./theme";

/**
 * Theming has two halves that can each fail silently, so both are pinned here.
 *
 * The stylesheet half has already failed once: `@media (prefers-color-scheme: dark)
 * { @theme { … } }` looked right and compiled to a single flat `:root` where the
 * dark values won unconditionally, because Tailwind v4 hoists `@theme` out of any
 * at-rule. Every user got the dark palette and nothing anywhere said so. These
 * tests read `app/globals.css` so that reintroducing that shape fails the suite
 * rather than the next screenshot somebody happens to take.
 */

/*
 * Comments are stripped first. This file documents the bug it is guarding against,
 * in prose that quotes the exact selectors below — so an un-stripped read matches
 * the explanation rather than the rules and every assertion here would pass while
 * the stylesheet was wrong, which is the failure mode these tests exist to catch.
 */
const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("the theme choice", () => {
  it("accepts exactly the three states", () => {
    expect(isThemeChoice("system")).toBe(true);
    expect(isThemeChoice("light")).toBe(true);
    expect(isThemeChoice("dark")).toBe(true);
    expect(isThemeChoice("solarized")).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
    expect(isThemeChoice(undefined)).toBe(false);
  });

  it("removes the attribute for `system` rather than resolving it", () => {
    // Resolving the media query here would freeze the answer at load, so a user
    // whose laptop goes dark at sunset would stay light until they reloaded.
    const root = document.createElement("html");
    root.setAttribute("data-theme", "dark");
    applyTheme("system", root);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("writes the attribute for an explicit choice", () => {
    const root = document.createElement("html");
    applyTheme("dark", root);
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyTheme("light", root);
    expect(root.getAttribute("data-theme")).toBe("light");
  });
});

describe("the pre-paint script", () => {
  it("reads the same key the toggle writes", () => {
    expect(THEME_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it("survives storage being unavailable", () => {
    // A locked-down browser throws on `localStorage` access itself. An unthemed
    // page is worth more than a blank one.
    expect(THEME_SCRIPT).toContain("try{");
    expect(THEME_SCRIPT).toContain("catch");
  });

  it("only ever writes light or dark, never a value from storage", () => {
    // The attribute goes into a CSS selector. Whatever is in storage is
    // attacker-reachable in principle, so the script matches it against literals
    // rather than passing it through.
    expect(THEME_SCRIPT).toContain('c==="light"||c==="dark"');
  });

  it("is a single statement with no dependencies", () => {
    expect(THEME_SCRIPT).not.toMatch(/import|require|fetch/);
    expect(THEME_SCRIPT.length).toBeLessThan(400);
  });
});

describe("the stylesheet's theming", () => {
  it("maps tokens with `@theme inline`, so they can be re-declared", () => {
    // Without `inline`, `bg-surface` bakes in the light value at build time and
    // every selector below does nothing.
    expect(css).toContain("@theme inline");
  });

  it("never nests `@theme` inside an at-rule", () => {
    // The original bug. Tailwind hoists such a block to `:root`, where it wins
    // unconditionally — the dark palette shipped to every reader for weeks.
    const nested = /@media[^{]*\{[^}]*@theme/s.test(css);
    expect(nested).toBe(false);
  });

  it("defines the full palette on bare `:root` first", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("@media"));
    for (const token of ["--canvas", "--surface", "--ink", "--muted", "--accent"]) {
      expect(root).toContain(`${token}:`);
    }
  });

  it("lets an explicit choice beat the device setting in both directions", () => {
    // `:not([data-theme="light"])` is what lets "light" win under a dark OS…
    expect(css).toContain(':root:not([data-theme="light"])');
    // …and the explicit dark block, which comes after the media query, is what
    // lets "dark" win under a light one.
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css.indexOf(':root[data-theme="dark"]')).toBeGreaterThan(
      css.indexOf(':root:not([data-theme="light"])'),
    );
  });
});
