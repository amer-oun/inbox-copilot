import { redirect } from "next/navigation";
import { AlertTriangle, Mail } from "lucide-react";
import { auth, signIn } from "../../auth";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";

/**
 * Sign-in asks for identity only — `openid profile email`. Mailbox access is a
 * separate, later, explicit grant (see /settings/accounts), so the consent screen
 * here does not mention reading anyone's mail.
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

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const session = await auth();
  const { next, error } = await searchParams;

  if (session?.user?.id) {
    redirect(next ?? "/dashboard");
  }

  // Only same-site paths — an open redirect here would be a phishing primitive.
  const redirectTo = next?.startsWith("/") ? next : "/dashboard";
  const message = errorMessage(error);

  async function signInWith(provider: "google" | "microsoft-entra-id") {
    "use server";
    await signIn(provider, { redirectTo });
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-ink">
          <Mail aria-hidden />
        </span>
        <span className="text-lg font-semibold tracking-tight">Inbox Copilot</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            We only ask for your name and email to create your account. Connecting
            a mailbox is a separate step you control.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {message ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 p-3 text-sm text-danger"
            >
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {message}
            </p>
          ) : null}

          <form action={signInWith.bind(null, "google")}>
            <Button type="submit" variant="outline" size="lg" block>
              Continue with Google
            </Button>
          </form>
          <form action={signInWith.bind(null, "microsoft-entra-id")}>
            <Button type="submit" variant="outline" size="lg" block>
              Continue with Microsoft
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="mt-6 text-xs leading-relaxed text-muted">
        Inbox Copilot never sends email on your behalf. Every AI draft waits for
        you to review and send it.
      </p>
    </main>
  );
}
