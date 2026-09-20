import { z } from "zod";
import { cuidSchema, emailSchema } from "./common.js";
import { mailProviderTypeSchema, syncStatusSchema } from "./enums.js";

/**
 * URL-facing provider slug. Distinct from `MailProviderType` (the DB enum) so
 * routes stay lowercase and stable even if the enum is renamed.
 */
export const providerSlugSchema = z.enum(["google", "microsoft"]);
export type ProviderSlug = z.infer<typeof providerSlugSchema>;

export const PROVIDER_SLUG_TO_TYPE = {
  google: "GMAIL",
  microsoft: "OUTLOOK",
} as const satisfies Record<ProviderSlug, z.infer<typeof mailProviderTypeSchema>>;

/**
 * The only shape of a connected mailbox that may cross the wire (rule 3).
 * No ciphertext, no iv, no authTag, no expiry — nothing token-shaped.
 */
export const mailAccountSchema = z.object({
  id: cuidSchema,
  provider: mailProviderTypeSchema,
  emailAddress: emailSchema,
  displayName: z.string().nullable(),
  scopes: z.array(z.string()),
  syncStatus: syncStatusSchema,
  /** Set when `syncStatus` is ERROR or REVOKED; safe, user-facing text. */
  syncError: z.string().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** True when the mailbox must be reconnected before sync can resume. */
  needsReconnect: z.boolean(),
});
export type MailAccountDto = z.infer<typeof mailAccountSchema>;

export const mailAccountListSchema = z.object({
  accounts: z.array(mailAccountSchema),
});
export type MailAccountList = z.infer<typeof mailAccountListSchema>;

export const connectMailAccountParamsSchema = z.object({
  provider: providerSlugSchema,
});

export const connectMailAccountResponseSchema = z.object({
  /** Provider consent URL. The browser is redirected here by the web app. */
  authorizeUrl: z.url(),
});
export type ConnectMailAccountResponse = z.infer<typeof connectMailAccountResponseSchema>;

/**
 * Disconnect reports whether the provider grant was actually torn down. Google
 * lets us revoke; Entra ID does not, so the user is handed a URL to finish it.
 */
export const disconnectMailAccountResponseSchema = z.object({
  revoked: z.boolean(),
  manageUrl: z.url().optional(),
});
export type DisconnectMailAccountResponse = z.infer<
  typeof disconnectMailAccountResponseSchema
>;

export const mailAccountIdParamsSchema = z.object({
  mailAccountId: cuidSchema,
});

/**
 * Provider redirect back to us. `code` and `error` are mutually exclusive;
 * `state` is always required — an unsigned callback is never processed.
 */
export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
});
export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
