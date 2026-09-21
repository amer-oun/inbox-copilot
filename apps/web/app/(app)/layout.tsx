import { AppShell } from "../../components/shell/AppShell";
import { auth } from "../../auth";

/**
 * The signed-in layout. Everything behind the shell lives in this route group, so
 * the navigation is defined once and cannot be missing from a page somebody adds
 * later — the failure mode of per-page chrome is a screen with no way out of it.
 *
 * `auth()` rather than `requireSession()`: a layout cannot know where the user was
 * heading, and a redirect from here would lose the `?next=` that brings them back
 * after signing in. Each page still calls `requireSession(<its own path>)`, which
 * is the check that actually guards the data — this one only decides whose name is
 * in the sidebar.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const user = session?.user;

  return (
    <AppShell user={{ name: user?.name ?? null, email: user?.email ?? null }}>
      {children}
    </AppShell>
  );
}
