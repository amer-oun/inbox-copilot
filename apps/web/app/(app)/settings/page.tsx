import { CheckCircle2, LogOut, Mail, RefreshCw, ShieldAlert } from "lucide-react";
import {
  mailAccountListSchema,
  syncStatusResponseSchema,
  type MailAccountDto,
  type SyncStatusResponse,
} from "@inbox-copilot/shared";
import { apiFetch } from "../../../lib/apiClient";
import { requireSession } from "../../../lib/session";
import { signOutAction } from "../../actions/auth";
import {
  connectMailAccountAction,
  disconnectMailAccountAction,
  syncMailAccountAction,
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
  SectionHeading,
} from "../../../components/ui/card";
import { PageBody, PageHeader } from "../../../components/shell/PageHeader";
import { Avatar } from "../../../components/shell/Avatar";
import { ThemeToggle } from "../../../components/shell/ThemeToggle";

/**
 * Settings: account, appearance, mailboxes.
 *
 * This page absorbed the old `/dashboard`, which existed only to show the session
 * and the mailbox list behind an extra click on the way to the inbox. Neither is
 * something a person opens an email client to look at — but both are things they
 * come looking for when something is wrong, which is what a settings page is for.
 *
 * It is also the *only* place mail scopes are requested, and it says plainly what
 * is being granted before the user clicks.
 */

export const metadata = { title: "Settings" };

interface SettingsPageProps {
  searchParams: Promise<{
    connected?: string;
    error?: string;
    disconnected?: string;
    sync?: string;
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
  invalid_state: "That connection link expired or was already used. Please start again.",
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

/** One outcome message. Same shape every time, so the eye knows where to look. */
function Notice({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "info";
  children: React.ReactNode;
}) {
  const styles = {
    success: "border-success-line bg-success-soft text-success",
    warning: "border-warning-line bg-warning-soft text-warning",
    danger: "border-danger-line bg-danger-soft text-danger",
    info: "border-accent-line bg-accent-soft text-accent",
  } as const;
  const Icon =
    tone === "success" ? CheckCircle2 : tone === "info" ? RefreshCw : ShieldAlert;

  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-[var(--radius-card)] border px-3.5 py-2.5 text-[0.8125rem] leading-relaxed ${styles[tone]}`}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Sync progress for one mailbox: counts, how far back, and the job's state. */
function SyncProgress({ status }: { status: SyncStatusResponse | undefined }) {
  if (!status) return null;

  const job = status.job;

  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[7rem_1fr]">
      <dt className="text-muted">Synced</dt>
      <dd className="tabular-nums text-ink">
        {status.threadCount} thread{status.threadCount === 1 ? "" : "s"} ·{" "}
        {status.messageCount} message{status.messageCount === 1 ? "" : "s"}
      </dd>

      {status.backfilledUntil ? (
        <>
          <dt className="text-muted">Back to</dt>
          <dd className="text-ink">
            {new Date(status.backfilledUntil).toLocaleDateString()}
          </dd>
        </>
      ) : null}

      {job ? (
        <>
          <dt className="text-muted">Job</dt>
          <dd className="text-ink">
            {job.state}
            {job.threadsProcessed === null
              ? ""
              : ` · ${job.threadsProcessed} threads processed`}
            {job.attemptsMade > 1 ? ` · attempt ${job.attemptsMade}` : ""}
          </dd>
        </>
      ) : null}

      {status.syncError ? (
        <>
          <dt className="text-muted">Last error</dt>
          <dd className="text-danger">{status.syncError}</dd>
        </>
      ) : null}
    </dl>
  );
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const session = await requireSession("/settings");
  const { user } = session;
  const { connected, error, disconnected, sync } = await searchParams;

  const { accounts } = await apiFetch(
    session.user.id,
    "/mail-accounts",
    mailAccountListSchema,
  );

  // Sync state per mailbox, read alongside the accounts: this page answers "is it
  // working", which the account row alone cannot say. The inbox itself is at /inbox.
  const syncStatuses = new Map<string, SyncStatusResponse>(
    await Promise.all(
      accounts.map(
        async (account) =>
          [
            account.id,
            await apiFetch(
              session.user.id,
              `/mail-accounts/${account.id}/sync-status`,
              syncStatusResponseSchema,
            ),
          ] as const,
      ),
    ),
  );

  const errorMessage = error
    ? (CALLBACK_ERRORS[error] ?? CALLBACK_ERRORS["failed"])
    : null;
  const needsReconnect = accounts.filter((account) => account.needsReconnect);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your account, how this looks, and the mailboxes it reads."
      />

      <PageBody className="space-y-10">
        {/* Outcomes from the last action, above everything they are about. */}
        {(connected ||
          disconnected ||
          sync ||
          errorMessage ||
          needsReconnect.length > 0) && (
          <div className="space-y-2.5">
            {connected ? (
              <Notice tone="success">
                Connected {connected}. The first sync is queued: it backfills the last 90
                days, then keeps up in the background.
              </Notice>
            ) : null}

            {disconnected === "revoked" ? (
              <Notice tone="success">
                Mailbox disconnected and access revoked at the provider.
              </Notice>
            ) : null}

            {disconnected === "manual" ? (
              <Notice tone="warning">
                Mailbox disconnected and our copy of your tokens deleted. Microsoft does
                not let an app revoke its own access, so the permission itself is still
                listed on your account —{" "}
                <a
                  href={MICROSOFT_CONSENT_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  remove it there
                </a>{" "}
                to finish.
              </Notice>
            ) : null}

            {sync ? (
              <Notice tone="info">
                {sync === "queued"
                  ? "Sync queued. The worker picks it up within seconds; progress appears below."
                  : "A sync is already running for that mailbox."}
              </Notice>
            ) : null}

            {errorMessage ? <Notice tone="danger">{errorMessage}</Notice> : null}

            {needsReconnect.length > 0 ? (
              <Notice tone="danger">
                {needsReconnect.length === 1
                  ? "A mailbox has"
                  : `${needsReconnect.length} mailboxes have`}{" "}
                lost access, so sync has stopped. Reconnect below to resume it.
              </Notice>
            ) : null}
          </div>
        )}

        {/* ── Account ───────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeading
            title="Account"
            description="The session the API authorizes every request against."
          />
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <Avatar name={user.name} email={user.email} className="size-10" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {user.name ?? "Signed in"}
                  </p>
                  <p className="truncate text-[0.8125rem] text-muted">
                    {user.email ?? "—"}
                  </p>
                </div>
              </div>

              <dl className="mt-4 grid gap-x-6 gap-y-1.5 border-t border-line pt-4 text-xs sm:grid-cols-[8rem_1fr]">
                <dt className="text-muted">User id</dt>
                <dd className="break-all font-mono text-ink">{user.id}</dd>
                <dt className="text-muted">Session expires</dt>
                <dd className="text-ink">{new Date(session.expires).toLocaleString()}</dd>
              </dl>
            </CardContent>
            <CardFooter>
              <form action={signOutAction}>
                <Button type="submit" variant="outline" size="sm">
                  <LogOut aria-hidden="true" />
                  Sign out
                </Button>
              </form>
            </CardFooter>
          </Card>
        </section>

        {/* ── Appearance ────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeading
            title="Appearance"
            description="Follows your device by default. A choice here is remembered in this browser only — it is a display preference, not account data."
          />
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <p className="text-sm font-medium text-ink">Theme</p>
                <p className="mt-0.5 text-[0.8125rem] text-muted">
                  Email bodies stay on a white background in both themes, because that is
                  what senders design for.
                </p>
              </div>
              <ThemeToggle />
            </CardContent>
          </Card>
        </section>

        {/* ── Mailboxes ─────────────────────────────────────────────────── */}
        <section id="mailboxes" className="scroll-mt-24 space-y-3">
          <SectionHeading
            title="Mailboxes"
            description="Connecting a mailbox is separate from signing in. Sync starts only after you grant access here, and Inbox Copilot never sends mail without you pressing send."
          />

          {accounts.length === 0 ? (
            <Card>
              <CardContent className="flex items-center gap-3 p-5 text-sm text-muted">
                <Mail aria-hidden="true" className="size-4 shrink-0" />
                No mailboxes yet. Connect one below.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {accounts.map((account) => (
                <Card key={account.id}>
                  <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <CardTitle className="break-all">{account.emailAddress}</CardTitle>
                      <CardDescription className="text-[0.8125rem]">
                        {PROVIDER_LABEL[account.provider]}
                        {account.displayName ? ` · ${account.displayName}` : ""}
                      </CardDescription>
                    </div>
                    <Badge tone={statusTone(account)}>
                      {account.needsReconnect ? "Reconnect needed" : account.syncStatus}
                    </Badge>
                  </CardHeader>

                  <CardContent className="space-y-3">
                    {account.needsReconnect ? (
                      <p className="max-w-[70ch] text-[0.8125rem] leading-relaxed text-danger">
                        Access was revoked or expired, so sync has stopped. Reconnecting
                        grants a fresh token — nothing already synced is lost.
                      </p>
                    ) : null}
                    <SyncProgress status={syncStatuses.get(account.id)} />
                  </CardContent>

                  <CardFooter className="flex-wrap justify-between gap-y-2">
                    <p className="text-xs text-muted">
                      {account.scopes.length} scope
                      {account.scopes.length === 1 ? "" : "s"} granted
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {account.needsReconnect ? null : (
                        <form action={syncMailAccountAction}>
                          <input type="hidden" name="mailAccountId" value={account.id} />
                          <Button type="submit" variant="outline" size="sm">
                            <RefreshCw aria-hidden="true" />
                            Sync now
                          </Button>
                        </form>
                      )}
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
              ))}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Connect a mailbox</CardTitle>
              <CardDescription className="text-[0.8125rem]">
                Gmail asks for read/modify and send access, and keeps working offline so
                sync can run while you are away. Outlook is not available yet.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <form action={connectMailAccountAction}>
                <input type="hidden" name="provider" value="google" />
                <Button type="submit" variant="outline">
                  Connect Gmail
                </Button>
              </form>
              {/*
               * Outlook has no sync implementation behind the provider port, so the OAuth
               * flow would complete, store a grant, and then fail in the worker — leaving a
               * connected mailbox that never brings mail in and an access grant the user has
               * to go and revoke. Refusing at the button is the honest version of that.
               * The badge sits beside it rather than in a tooltip: a disabled button is not
               * focusable, so an explanation only it carries is one a keyboard user never
               * hears.
               */}
              <Button type="button" variant="outline" disabled>
                Connect Outlook
              </Button>
              <Badge tone="neutral">Coming soon</Badge>
            </CardContent>
          </Card>
        </section>
      </PageBody>
    </>
  );
}
