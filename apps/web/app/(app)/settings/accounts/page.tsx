import { redirect } from "next/navigation";

/**
 * `/settings/accounts` used to be the mailbox page; mailboxes are now one section
 * of `/settings`. This stays as a redirect rather than disappearing, because the
 * URL is not only in old bookmarks: the API's OAuth callback builds it
 * (`apps/api/src/routes/oauth.ts` — `new URL("/settings/accounts", WEB_APP_URL)`),
 * so a user finishing a mailbox connection lands here. Dropping it would end every
 * successful connect on a 404.
 *
 * The query string is carried across, because that is where the outcome is:
 * `?connected=`, `?error=`, `?disconnected=`, `?sync=`.
 */
interface AccountsRedirectProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AccountsRedirect({ searchParams }: AccountsRedirectProps) {
  const params = await searchParams;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) query.set(key, value[0]);
  }

  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  redirect(`/settings${suffix}#mailboxes`);
}
