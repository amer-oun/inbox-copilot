import { redirect } from "next/navigation";
import { AlertTriangle, FileLock2, Mail, ShieldCheck, Sparkles } from "lucide-react";
import { auth, microsoftSignInEnabled, signIn } from "../../auth";
import { Button } from "../../components/ui/button";
import { ThemeToggle } from "../../components/shell/ThemeToggle";

/**
 * Sign-in asks for identity only — `openid profile email`. Mailbox access is a
 * separate, later, explicit grant (see /settings), so the consent screen here does
 * not mention reading anyone's mail.
 *
 * Two columns on a wide screen, one on a phone, and the second column is not
 * decoration: it is the three promises this product is actually making about a
 * mailbox, stated before the user hands over an identity rather than in a policy
 * they will not read. On a phone it moves *below* the buttons — the person already
 * decided to sign in, and making them scroll past marketing to reach the control
 * is the wrong order.
 */

interface SignInPageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

/** Auth.js error codes we want to phrase ourselves. */
function errorMessage(code: string | undefined): string | null {
  switch (code) {
    case undefined:
      return null;
    case "OAuthAccountNotLinked":
      return "That email is already signed up with the other provider. Use the one you signed up with.";
    case "AccessDenied":
      return "The provider declined the sign-in request.";
    default:
      return "Sign-in did not complete. Please try again.";
  }
}

const PROMISES = [
  {
    Icon: ShieldCheck,
    title: "Drafts never send themselves",
    body: "Every AI reply waits in a box you can edit. Sending is a separate click that names the recipient.",
  },
  {
    Icon: FileLock2,
    title: "Email is treated as hostile",
    body: "Bodies render in a sandboxed frame with scripts off and remote images blocked, so a tracking pixel cannot report that you opened anything.",
  },
  {
    Icon: Sparkles,
    title: "Summaries are labelled",
    body: "Anything a model wrote says so, and names the model. You always know which words are the sender's.",
  },
] as const;

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const session = await auth();
  const { next, error } = await searchParams;

  if (session?.user?.id) {
    redirect(next ?? "/inbox/all");
  }

  // Only same-site paths — an open redirect here would be a phishing primitive.
  const redirectTo = next?.startsWith("/") ? next : "/inbox/all";
  const message = errorMessage(error);

  async function signInWith(provider: "google" | "microsoft-entra-id") {
    "use server";
    await signIn(provider, { redirectTo });
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-2">
      {/* ── The control column ───────────────────────────────────────────── */}
      <main className="flex min-h-dvh flex-col justify-center px-6 py-12 sm:px-10 lg:min-h-0">
        <div className="mx-auto w-full max-w-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-[0.5rem] bg-accent text-accent-ink">
                <Mail aria-hidden="true" className="size-5" />
              </span>
              <span className="text-base font-semibold tracking-tight text-ink">
                Inbox Copilot
              </span>
            </span>
            <ThemeToggle />
          </div>

          <h1 className="mt-10 text-2xl font-semibold tracking-tight text-ink">
            Sign in
          </h1>
          <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-muted">
            We ask for your name and email to create your account. Connecting a mailbox is
            a separate step you control.
          </p>

          {message ? (
            <p
              role="alert"
              className="mt-6 flex items-start gap-2 rounded-[var(--radius-card)] border border-danger-line bg-danger-soft p-3 text-[0.8125rem] leading-relaxed text-danger"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {message}
            </p>
          ) : null}

          <div className="mt-7 space-y-2.5">
            <form action={signInWith.bind(null, "google")}>
              <Button type="submit" variant="outline" size="lg" block>
                Continue with Google
              </Button>
            </form>
            {/*
              Shown only when Microsoft is configured. A button for an unregistered
              provider fails at login.microsoftonline.com, which looks like our bug.
            */}
            {microsoftSignInEnabled ? (
              <form action={signInWith.bind(null, "microsoft-entra-id")}>
                <Button type="submit" variant="outline" size="lg" block>
                  Continue with Microsoft
                </Button>
              </form>
            ) : null}
          </div>

          <p className="mt-6 text-xs leading-relaxed text-muted">
            Inbox Copilot never sends email on your behalf. Every AI draft waits for you
            to review and send it.
          </p>
        </div>
      </main>

      {/* ── The promises column ──────────────────────────────────────────── */}
      <aside className="border-t border-line bg-panel px-6 py-12 sm:px-10 lg:flex lg:min-h-dvh lg:flex-col lg:justify-center lg:border-l lg:border-t-0">
        <ul className="mx-auto w-full max-w-sm space-y-7 lg:max-w-md">
          {PROMISES.map(({ Icon, title, body }) => (
            <li key={title} className="flex gap-3.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink">{title}</h2>
                <p className="mt-1 max-w-[52ch] text-[0.8125rem] leading-relaxed text-muted">
                  {body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
