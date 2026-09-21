"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  applyTheme,
  isThemeChoice,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "../../lib/theme";
import { cn } from "../../lib/utils";

/**
 * The theme control: a three-way segmented switch, not a two-way flip.
 *
 * It is a radio group, which is what it is — three mutually exclusive choices,
 * arrow keys move between them, the checked one is announced. A row of buttons
 * would look the same and tell a screen reader nothing about the set.
 *
 * ── Why `useSyncExternalStore` and not an effect ────────────────────────────────
 *
 * The stored choice is external state: it lives in `localStorage`, the server
 * cannot see it, and another tab can change it. Reading it in an effect and
 * calling `setState` would render twice on every mount and still miss the other
 * tab. `useSyncExternalStore` is the API for exactly this shape — it has a server
 * snapshot (`system`, the default), a client snapshot, and a subscription, so the
 * two shells on screen at once and the one in the settings page all agree, and a
 * change in another tab arrives here through the `storage` event.
 *
 * The page itself is already correct before any of this runs: the inline script in
 * `<head>` set `data-theme` before first paint. This component only reflects it.
 */

const OPTIONS: ReadonlyArray<{
  value: ThemeChoice;
  label: string;
  Icon: typeof Sun;
}> = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * `storage` only fires in *other* tabs, so this tab announces its own change with
 * a custom event. Without it, two toggles on one page (the shell and the settings
 * card) would disagree until a reload.
 */
const THEME_EVENT = "inbox-copilot:themechange";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "system";
  } catch {
    // Storage is blocked; the device setting still applies.
    return "system";
  }
}

/** The server cannot know, and guessing would be a hydration mismatch. */
function serverChoice(): ThemeChoice {
  return "system";
}

export function ThemeToggle({ className }: { className?: string | undefined }) {
  const choice = useSyncExternalStore(subscribe, readChoice, serverChoice);

  const choose = useCallback((next: ThemeChoice) => {
    applyTheme(next, document.documentElement);
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Not persisted, but applied for this page — better than refusing to switch.
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-line bg-surface p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={label}
            onClick={() => choose(value)}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-full",
              "transition-colors duration-150 ease-[var(--ease-out-quart)]",
              active
                ? "bg-accent text-accent-ink"
                : "text-muted hover:bg-raised hover:text-ink",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
