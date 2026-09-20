import Link from "next/link";
import { Inbox, Settings } from "lucide-react";
import { mailAccountListSchema } from "@inbox-copilot/shared";
import { apiFetch } from "../../lib/apiClient";
import { requireSession } from "../../lib/session";
import { signOutAction } from "../actions/auth";
import { Button, buttonVariants } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";

/** Per-request session check — see lib/session.ts for why this is not middleware. */
export default async function DashboardPage() {
  const session = await requireSession("/dashboard");
  const { user } = session;

  const { accounts } = await apiFetch(
    user.id,
    "/mail-accounts",
    mailAccountListSchema,
  );

  const needsReconnect = accounts.filter((account) => account.needsReconnect);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-10 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Connected mailboxes sync in the background. New mail is categorized,
            summarized and checked for phishing as it arrives — and every reply stays a
            draft until you send it.
          </p>
        </div>
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Signed in as</CardTitle>
          <CardDescription>
            This is the session the API authorizes every request against.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted">Name</dt>
            <dd>{user.name ?? "—"}</dd>
            <dt className="text-muted">Email</dt>
            <dd className="break-all">{user.email ?? "—"}</dd>
            <dt className="text-muted">User id</dt>
            <dd className="break-all font-mono text-xs">{user.id}</dd>
            <dt className="text-muted">Session expires</dt>
            <dd>{new Date(session.expires).toLocaleString()}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle>Mailboxes</CardTitle>
            <CardDescription>
              {accounts.length === 0
                ? "No mailbox connected yet."
                : `${accounts.length} connected.`}
            </CardDescription>
          </div>
          <Link
            href="/settings/accounts"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
          >
            <Settings aria-hidden />
            Manage
          </Link>
        </CardHeader>
        <CardContent className="space-y-2">
          {accounts.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Inbox aria-hidden className="size-4" />
              Connect a Gmail mailbox to get started.
            </p>
          ) : (
            <ul className="space-y-2">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="break-all">{account.emailAddress}</span>
                  <Badge tone={account.needsReconnect ? "danger" : "neutral"}>
                    {account.needsReconnect ? "Reconnect needed" : account.syncStatus}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          {needsReconnect.length > 0 ? (
            <p className="pt-2 text-sm text-danger">
              {needsReconnect.length === 1 ? "A mailbox" : `${needsReconnect.length} mailboxes`}{" "}
              lost access.{" "}
              <Link href="/settings/accounts" className="underline">
                Reconnect
              </Link>{" "}
              to resume sync.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
