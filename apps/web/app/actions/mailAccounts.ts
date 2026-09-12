"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  connectMailAccountResponseSchema,
  disconnectMailAccountResponseSchema,
  providerSlugSchema,
  type ProviderSlug,
} from "@inbox-copilot/shared";
import { apiFetch } from "../../lib/apiClient";
import { requireSession } from "../../lib/session";
import { z } from "zod";

/**
 * Mailbox connect/disconnect, driven from /settings/accounts.
 *
 * The action asks the core API for a consent URL and then redirects the browser
 * to the provider. It never sees a token: the provider redirects back to the API,
 * which is the only process that can decrypt the vault.
 */

export async function connectMailAccountAction(formData: FormData): Promise<void> {
  const session = await requireSession("/settings/accounts");
  const provider: ProviderSlug = providerSlugSchema.parse(formData.get("provider"));

  const { authorizeUrl } = await apiFetch(
    session.user.id,
    `/mail-accounts/${provider}/connect`,
    connectMailAccountResponseSchema,
    { method: "POST" },
  );

  // `redirect` throws, so it must sit outside any try/catch above.
  redirect(authorizeUrl);
}

export async function disconnectMailAccountAction(formData: FormData): Promise<void> {
  const session = await requireSession("/settings/accounts");
  const mailAccountId = z.string().min(1).parse(formData.get("mailAccountId"));

  const outcome = await apiFetch(
    session.user.id,
    `/mail-accounts/${mailAccountId}`,
    disconnectMailAccountResponseSchema,
    { method: "DELETE" },
  );

  revalidatePath("/settings/accounts");

  // Only a flag travels in the URL: the page owns the provider's consent link, so
  // no URL from a response is ever reflected into an href.
  redirect(
    outcome.revoked
      ? "/settings/accounts?disconnected=revoked"
      : "/settings/accounts?disconnected=manual",
  );
}
