/**
 * Theme preference: the device setting by default, overridable, remembered.
 *
 * Three states rather than two. "System" is a real choice and the default one —
 * a user who has set their laptop to go dark at sunset has already said what they
 * want, and a two-way toggle silently overrides that the first time it is touched.
 */

export const THEME_STORAGE_KEY = "inbox-copilot:theme";

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return (
    typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value)
  );
}

/**
 * Applies a choice to the document.
 *
 * "System" *removes* the attribute rather than resolving the media query and
 * writing the answer: the stylesheet already has a `prefers-color-scheme` block,
 * so an absent attribute tracks the device live — including when the user changes
 * it while the tab is open. Resolving it here would freeze the answer at load.
 */
export function applyTheme(choice: ThemeChoice, root: HTMLElement): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

/**
 * The script that runs before first paint.
 *
 * It has to be inline and synchronous in `<head>`: anything deferred paints the
 * default theme first, and a white flash on the way into a dark inbox at night is
 * exactly the thing a theme setting is supposed to prevent. It is deliberately
 * tiny, and it is wrapped in try/catch because `localStorage` throws outright in a
 * locked-down browser — a themed page is worth less than a page that renders.
 *
 * Kept as a string so it can be asserted in a test; there is no other way to check
 * an inline script short of a browser.
 */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(c==="light"||c==="dark"){document.documentElement.setAttribute("data-theme",c)}}catch(e){}})();`;
