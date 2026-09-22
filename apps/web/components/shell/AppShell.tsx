import Link from "next/link";
import { FlaskConical, LogOut, Mail } from "lucide-react";
import { signOutAction } from "../../app/actions/auth";
import { Button } from "../ui/button";
import { AppNav } from "./AppNav";
import { Avatar } from "./Avatar";
import { ThemeToggle } from "./ThemeToggle";
import { MOBILE_BAR_HEIGHT } from "./layout";

/**
 * The frame every signed-in page renders inside.
 *
 * A server component: the only client parts are the nav (which needs the current
 * path) and the theme switch (which needs `localStorage`). The identity, the
 * sign-out form and the layout itself are in the HTML the server sends.
 *
 * Two shapes, chosen structurally rather than by resizing type:
 *
 *   - **≥ lg** a fixed 15rem sidebar on the second neutral, content beside it.
 *     Mail is a two-pane habit and the destination list should not cost a click.
 *   - **< lg** a top bar for identity and a bottom bar for the four destinations,
 *     which is where a thumb is. The bottom bar is where the sidebar's nav goes,
 *     not a hamburger: four items fit, and a menu that hides four items is a menu
 *     that adds a tap to every navigation in the app.
 *
 * `pb-[…]` on the content plus `env(safe-area-inset-bottom)` on the bar is what
 * keeps the last row of the inbox above the home indicator on a phone.
 */

export interface AppShellProps {
  user: { name?: string | null; email?: string | null };
  /** Set for a demo visit: shows the banner and turns "Sign out" into "Exit demo". */
  demo?: { requestAccessUrl: string | null } | null;
  children: React.ReactNode;
}

function Wordmark() {
  return (
    <Link
      href="/inbox/all"
      className="inline-flex items-center gap-2 rounded-[var(--radius-control)]"
    >
      <span className="flex size-7 items-center justify-center rounded-[0.4375rem] bg-accent text-accent-ink">
        <Mail aria-hidden="true" className="size-4" />
      </span>
      <span className="text-sm font-semibold tracking-tight text-ink">Inbox Copilot</span>
    </Link>
  );
}

function SignOutButton({ label, demo }: { label: "full" | "icon"; demo: boolean }) {
  const text = demo ? "Exit demo" : "Sign out";
  return (
    <form action={signOutAction}>
      {label === "full" ? (
        <Button type="submit" variant="ghost" size="sm" block className="justify-start">
          <LogOut aria-hidden="true" />
          {text}
        </Button>
      ) : (
        <Button type="submit" variant="ghost" size="icon-sm" title={text}>
          <LogOut aria-hidden="true" />
          <span className="sr-only">{text}</span>
        </Button>
      )}
    </form>
  );
}

/**
 * On every page of a demo visit, above the page's own header.
 *
 * Plain about what this is: invented mail, and the real thing is by invitation. Not
 * sticky — it is a label, not an alarm, and the sticky page header below it is what
 * the reader needs on screen while scrolling a thread.
 */
function DemoBanner({ requestAccessUrl }: { requestAccessUrl: string | null }) {
  return (
    <div
      role="note"
      className="flex items-start gap-2 border-b border-accent-line bg-accent-soft px-4 py-2 text-[0.8125rem] leading-snug text-ink sm:items-center sm:px-6"
    >
      <FlaskConical
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-accent sm:mt-0"
      />
      <p className="min-w-0">
        Demo mailbox with sample data. Connect your own Gmail{" "}
        {requestAccessUrl === null ? (
          "by request"
        ) : (
          <a
            href={requestAccessUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-accent underline underline-offset-2"
          >
            by request
          </a>
        )}
        .
      </p>
    </div>
  );
}

export function AppShell({ user, demo = null, children }: AppShellProps) {
  const isDemo = demo !== null;
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      {/* ── Sidebar (wide screens) ───────────────────────────────────────── */}
      <div className="hidden lg:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 border-r border-line bg-panel px-3 py-4">
          <div className="px-1.5">
            <Wordmark />
          </div>

          <nav aria-label="Main" className="flex-1">
            <AppNav variant="sidebar" />
          </nav>

          <div className="space-y-3 border-t border-line pt-3">
            <div className="flex items-center gap-2.5 px-1.5">
              <Avatar name={user.name} email={user.email} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {user.name ?? "Signed in"}
                </span>
                <span className="block truncate text-xs text-muted">
                  {user.email ?? ""}
                </span>
              </span>
            </div>
            <SignOutButton label="full" demo={isDemo} />
            <div className="px-1.5">
              <ThemeToggle />
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-col">
        {/* Top bar, phones and tablets only. */}
        {/*
          Exactly MOBILE_BAR_HEIGHT tall, plus the inset as *padding* rather than
          margin: a sticky element's margin collapses against the viewport when it
          sticks, which would drop the bar under the notch on the first scroll.
        */}
        <header
          className="sticky top-0 z-(--z-nav) border-b border-line bg-panel/90 backdrop-blur lg:hidden"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <div
            className="flex items-center gap-3 px-4"
            style={{ height: MOBILE_BAR_HEIGHT }}
          >
            <Wordmark />
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
              <Link
                href="/settings"
                className="rounded-full"
                title={user.email ?? "Account"}
              >
                <Avatar name={user.name} email={user.email} />
                <span className="sr-only">Account and settings</span>
              </Link>
              <SignOutButton label="icon" demo={isDemo} />
            </div>
          </div>
        </header>

        {demo !== null ? <DemoBanner requestAccessUrl={demo.requestAccessUrl} /> : null}

        <main className="min-w-0 flex-1 pb-[calc(4.25rem+env(safe-area-inset-bottom))] lg:pb-0">
          {children}
        </main>

        {/* Bottom bar, phones and tablets only. */}
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-(--z-nav) border-t border-line bg-panel/95 backdrop-blur lg:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <AppNav variant="bar" />
        </nav>
      </div>
    </div>
  );
}
