import { AppShell } from "../../components/shell/AppShell";
import { demoAccessRequestUrl } from "../../lib/demo";
import { getViewer } from "../../lib/viewer";

/**
 * The signed-in layout. Everything behind the shell lives in this route group, so
 * the navigation is defined once and cannot be missing from a page somebody adds
 * later — the failure mode of per-page chrome is a screen with no way out of it.
 *
 * `getViewer()` rather than `requireViewer()`: a layout cannot know where the user
 * was heading, and a redirect from here would lose the `?next=` that brings them back
 * after signing in. Each page still calls `requireViewer(<its own path>)`, which is
 * the check that actually guards the data — this one only decides whose name is in
 * the sidebar, and whether the demo banner is shown.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const viewer = await getViewer();

  return (
    <AppShell
      user={{ name: viewer?.name ?? null, email: viewer?.email ?? null }}
      demo={viewer?.kind === "demo" ? { requestAccessUrl: demoAccessRequestUrl() } : null}
    >
      {children}
    </AppShell>
  );
}
