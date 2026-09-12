import Link from "next/link";
import { ArrowLeft, CheckCircle2, Mail, ShieldAlert } from "lucide-react";
import { mailAccountListSchema, type MailAccountDto } from "@inbox-copilot/shared";
import { apiFetch } from "../../../lib/apiClient";
import { requireSession } from "../../../lib/session";
import {
  connectMailAccountAction,
  disconnectMailAccountAction,
} from "../../actions/mailAccounts";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";

/**
 * Mailbox connections. This page is the *only* place mail scopes are requested,
 * and it says plainly what is being granted before the user clicks.
 */

interface AccountsPageProps {
  searchParams: Promise<{
    connected?: string;
    error?: string;
    disconnected?: string;
  }>;
}

/**
 * Where a user removes our grant by hand. Entra ID has no app-initiated
 * revocation we can reach with delegated mail scopes, so this link is the honest
 * completion of "Disconnect" — held here as a constant, never taken from a
 * response, so nothing reflected can become an href.
 */
const MICROSOFT_CONSENT_URL = "https://myapplications.microsoft.com/";

/** Stable codes from the API callback (routes/oauth.ts), phrased here. */
const CALLBACK_ERRORS: Record<string, string> = {
  denied: "You declined the permission request, so nothing was connected.",
  invalid_state:
    "That connection link expired or was already used. Please start again.",
  provider_error: "The provider reported an error. Please try again.",
  failed:
    "We could not finish connecting the mailbox. Nothing was saved — please try again.",
};

const PROVIDER_LABEL = { GMAIL: "Gmail", OUTLOOK: "Outlook" } as const;

function statusTone(account: MailAccountDto) {
  if (account.needsReconnect || account.syncStatus === "ERROR") return "danger";
  if (account.syncStatus === "ACTIVE") return "success";
  if (account.syncStatus === "PAUSED") return "warning";
  return "info";
}

export default async function AccountsPage({ searchParams }: AccountsPageProps) {
  const session = await requireSession("/settings/accounts");
  const { connected, error, disconnected } = await searchParams;

  const { accounts } = await apiFetch(
    session.user.id,
    "/mail-accounts",
    mailAccountListSchema,
  );

  const errorMessage = error ? (CALLBACK_ERRORS[error] ?? CALLBACK_ERRORS["failed"]) : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <Link
        href="/dashboard"
        className="mb-8 inline-flex items-center gap-2 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Dashboard
      </Link>

      <h1 className="text-2xl font-semibold tracking-tight">Connected mailboxes</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Connecting a mailbox is separate from signing in. Sync starts only after
        you grant access here, and Inbox Copilot never sends mail without you
        pressing send.
      </p>

      {connected ? (
        <p
          role="status"
          className="mt-6 flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
        >
          <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          Connected {connected}. Sync is queued and starts in phase 2.
        </p>
      ) : null}

      {disconnected === "revoked" ? (
        <p
          role="status"
          className="mt-6 flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
        >
          <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          Mailbox disconnected and access revoked at the provider.
        </p>
      ) : null}

      {disconnected === "manual" ? (
        <p
          role="status"
          className="mt-6 flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 p-3 text-sm text-warning"
        >
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Mailbox disconnected and our copy of your tokens deleted. Microsoft does
            not let an app revoke its own access, so the permission itself is still
            listed on your account —{" "}
            <a
              href={MICROSOFT_CONSENT_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              remove it there
            </a>{" "}
            to finish.
          </span>
        </p>
      ) : null}

      {errorMessage ? (
        <p
          role="alert"
          className="mt-6 flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/10 p-3 text-sm text-danger"
        >
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {errorMessage}
        </p>
      ) : null}

      <section className="mt-8 space-y-4">
        {accounts.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 p-6 text-sm text-muted">
              <Mail aria-hidden className="size-4" />
              No mailboxes yet. Connect one below.
            </CardContent>
          </Card>
        ) : (
          accounts.map((account) => (
            <Card key={account.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="space-y-1">
                  <CardTitle className="break-all">{account.emailAddress}</CardTitle>
                  <CardDescription>
                    {PROVIDER_LABEL[account.provider]}
                    {account.displayName ? ` · ${account.displayName}` : ""}
                  </CardDescription>
                </div>
                <Badge tone={statusTone(account)}>
                  {account.needsReconnect ? "Reconnect needed" : account.syncStatus}
                </Badge>
              </CardHeader>

              {account.needsReconnect ? (
                <CardContent>
                  <p className="text-sm text-danger">
                    Access was revoked or expired, so sync has stopped. Reconnecting
                    grants a fresh token — nothing already synced is lost.
                  </p>
                </CardContent>
              ) : null}

              <CardFooter className="flex-wrap justify-between">
                <p className="text-xs text-muted">
                  {account.scopes.length} scope
                  {account.scopes.length === 1 ? "" : "s"} granted
                </p>
                <div className="flex gap-2">
                  {account.needsReconnect ? (
                    <form action={connectMailAccountAction}>
                      <input
                        type="hidden"
                        name="provider"
                        value={account.provider === "GMAIL" ? "google" : "microsoft"}
                      />
                      <Button type="submit" size="sm">
                        Reconnect
                      </Button>
                    </form>
                  ) : null}
                  <form action={disconnectMailAccountAction}>
                    <input type="hidden" name="mailAccountId" value={account.id} />
                    <Button type="submit" variant="danger" size="sm">
                      Disconnect
                    </Button>
                  </form>
                </div>
              </CardFooter>
            </Card>
          ))
        )}
      </section>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Connect a mailbox</CardTitle>
          <CardDescription>
            Gmail asks for read/modify and send access. Outlook asks for
            Mail.ReadWrite and Mail.Send. Both keep working offline so sync can run
            while you are away.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <form action={connectMailAccountAction}>
            <input type="hidden" name="provider" value="google" />
            <Button type="submit" variant="outline">
              Connect Gmail
            </Button>
          </form>
          <form action={connectMailAccountAction}>
            <input type="hidden" name="provider" value="microsoft" />
            <Button type="submit" variant="outline">
              Connect Outlook
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
