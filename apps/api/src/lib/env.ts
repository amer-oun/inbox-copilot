import { z } from "zod";

/** A base64 value that decodes to exactly `bytes` bytes. */
function base64Bytes(bytes: number) {
  return z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, "base64").length === bytes;
      } catch {
        return false;
      }
    },
    { message: `must be base64-encoded ${bytes} bytes` },
  );
}

/** A base64-encoded PEM block (keeps multi-line keys on one .env line). */
const base64Pem = z.string().refine(
  (value) => Buffer.from(value, "base64").toString("utf8").includes("-----BEGIN"),
  { message: "must be a base64-encoded PEM block" },
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  /** Where this API is reachable from a browser — builds the OAuth redirect_uri. */
  API_PUBLIC_URL: z.url().default("http://localhost:4000"),
  /** Where to send the browser after an OAuth callback. */
  WEB_APP_URL: z.url().default("http://localhost:3000"),

  /**
   * AES-256-GCM key for the token vault. 32 bytes, base64. Validated here so a
   * short or malformed key fails at boot, not at the first token write.
   */
  TOKEN_ENCRYPTION_KEY: base64Bytes(32),
  /** Bumped alongside the key when it is rotated; stamped on every ciphertext. */
  TOKEN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  /** HMAC secret for the OAuth `state` parameter. */
  OAUTH_STATE_SECRET: z.string().min(32, "OAUTH_STATE_SECRET must be >= 32 chars"),

  /** RS256 public key of the Next.js BFF — verifies the internal JWT. */
  INTERNAL_JWT_PUBLIC_KEY: base64Pem,
  INTERNAL_JWT_ISSUER: z.string().min(1).default("inbox-copilot-web"),
  INTERNAL_JWT_AUDIENCE: z.string().min(1).default("inbox-copilot-api"),

  /**
   * Provider credentials. Empty is allowed at boot — the API must still start and
   * serve /health on a machine where only one provider (or neither) is set up.
   * The provider clients refuse the flow with a clear error instead.
   */
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  /**
   * Anthropic API key for the AI layer. Empty is allowed at boot for the same
   * reason as the provider credentials: the API must start and serve /health on a
   * machine with no AI configured. `services/ai/client.ts` refuses the call with a
   * clear error instead of failing mysteriously at the first classification.
   */
  ANTHROPIC_API_KEY: z.string().default(""),

  /**
   * Send AI calls somewhere other than api.anthropic.com: the local stub in
   * development, or a gateway in a deployment. Empty means the real API (or the
   * stub, outside production, when there is also no key — see ai/endpoint.ts).
   */
  ANTHROPIC_BASE_URL: z.union([z.literal(""), z.url()]).default(""),

  /** Port for the development AI stub (`pnpm ai:stub`). */
  AI_STUB_PORT: z.coerce.number().int().min(1).max(65535).default(4010),

  /**
   * Pub/Sub topic that Gmail publishes mailbox changes to, as
   * `projects/<project>/topics/<topic>` (§4). Empty means push is not configured:
   * `startWatch` refuses with a clear error and the mailbox keeps working through
   * backfill and the catch-up sweep, just without real-time updates.
   */
  GMAIL_PUBSUB_TOPIC: z.string().default(""),

  /**
   * The `aud` claim to require on the push subscription's OIDC token. Whatever was
   * configured on the subscription — conventionally the push endpoint URL. Empty
   * means "the webhook's own URL", derived from API_PUBLIC_URL.
   */
  GMAIL_PUBSUB_AUDIENCE: z.string().default(""),

  /**
   * The service account Pub/Sub signs push tokens as. Empty accepts any Google-signed
   * token for the audience, which is weaker: anyone with a Google service account
   * could then mint one for a URL they know. Set it.
   */
  GMAIL_PUBSUB_SERVICE_ACCOUNT: z.union([z.literal(""), z.email()]).default(""),

  /**
   * Development-only shared secret for the webhook, so the push path can be driven
   * locally without a public URL. Ignored outside development — see
   * `lib/pubsub.ts`, which refuses it in production even if it is set.
   */
  GMAIL_WEBHOOK_DEV_TOKEN: z.string().default(""),

  /**
   * Resend API key, for the one thing this application mails a person about: the
   * opt-in follow-up digest (§9). Empty is a supported state — reminders work, resolve
   * and appear in the UI without it; only the email does not go out. It never carries
   * the user's own correspondence (see lib/resend.ts).
   */
  RESEND_API_KEY: z.string().default(""),
  /**
   * The `From` for that digest. A verified sender on the Resend account, and
   * obviously ours rather than the user's: mail from the application must look like
   * it. Empty disables the digest just as an empty key does.
   */
  DIGEST_FROM_ADDRESS: z.union([z.literal(""), z.email()]).default(""),

  MICROSOFT_CLIENT_ID: z.string().default(""),
  MICROSOFT_CLIENT_SECRET: z.string().default(""),
  /** "common" for multi-tenant + personal accounts; a GUID to lock to one tenant. */
  MICROSOFT_TENANT_ID: z.string().min(1).default("common"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail loudly at boot rather than at the first request. Only the variable
    // name and the rule are printed — never the offending value.
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();
