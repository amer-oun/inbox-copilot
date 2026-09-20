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
const base64Pem = z
  .string()
  .refine(
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

  /**
   * Where this API is reachable from a browser — builds the OAuth `redirect_uri` and
   * the Pub/Sub push endpoint.
   *
   * The localhost default is for development only and is **refused in production**
   * (see `assertProductionConfig`): a deployed API whose `redirect_uri` says
   * `http://localhost:4000` does not fail, it sends the user's browser to their own
   * machine after Google has already issued the authorization code.
   */
  API_PUBLIC_URL: z.url().default("http://localhost:4000"),
  /** Where to send the browser after an OAuth callback. Same production rule. */
  WEB_APP_URL: z.url().default("http://localhost:3000"),

  /**
   * Host the BullMQ consumers inside this process instead of running `worker.js`
   * separately.
   *
   * §1 wants them apart, and `pnpm dev` keeps them apart. This exists because "two
   * processes" is a hosting budget rather than an architectural requirement: on a free
   * tier there is one service, and one service that also drains its queues beats a
   * queue nothing consumes. The consumers are the same code either way
   * (`queueWorkers.ts`).
   *
   * Only `true`/`1` and `false`/`0` are accepted, and the parse fails on anything else
   * rather than treating it as false — the failure mode of a silently-false flag is a
   * deployment that accepts work, enqueues it, and never runs any of it.
   */
  WORKER_IN_PROCESS: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((value) => value === "true" || value === "1"),

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
   * Which model provider the AI layer talks to.
   *
   * Explicit beats inferred: "why is this mailbox full of stubbed classifications"
   * should be answerable from one variable rather than deduced from which keys
   * happen to be set. Left unset it *is* inferred, exactly as it was before this
   * existed — a key means the real API, no key outside production means the stub —
   * so nothing about an existing `.env` or `pnpm dev` changes.
   *
   *   anthropic  the Anthropic API (or a gateway, via ANTHROPIC_BASE_URL)
   *   gemini     Google's Gemini API, on the free tier (GEMINI_API_KEY)
   *   stub       the local canned-response server. Refused in production.
   */
  AI_PROVIDER: z.preprocess(
    /*
     * Empty means unset. `.env.example` ships `AI_PROVIDER=""` — a commented-out
     * variable is invisible, so the file names every knob and leaves it blank — and
     * `--env-file` puts that empty string into `process.env`, where a bare `z.enum`
     * rejects it. That turned a fresh clone following the documented setup into a
     * startup crash reading `expected one of "anthropic"|"gemini"|"stub"`, which
     * describes the rule and not the mistake.
     *
     * Every other optional variable in this file uses `.default("")` for the same
     * reason; an enum is the one shape that cannot.
     */
    (value) => (value === "" ? undefined : value),
    z.enum(["anthropic", "gemini", "stub"]).optional(),
  ),

  /**
   * Anthropic API key for the AI layer. Empty is allowed at boot for the same
   * reason as the provider credentials: the API must start and serve /health on a
   * machine with no AI configured. `services/ai/client.ts` refuses the call with a
   * clear error instead of failing mysteriously at the first classification.
   */
  ANTHROPIC_API_KEY: z.string().default(""),

  /**
   * Google AI Studio key for the Gemini path (`AI_PROVIDER=gemini`).
   *
   * Free tier, which is the reason this provider exists at all — so
   * `services/ai/models.ts` prices every Gemini model at zero while still recording
   * the token counts. Empty with `AI_PROVIDER=gemini` is a startup-shaped failure
   * reported at the first call, like a missing Anthropic key.
   */
  GEMINI_API_KEY: z.string().default(""),

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

/**
 * Localhost defaults that are correct in development and wrong in a deployment.
 *
 * Every other variable in this file either has no default (so a missing value fails
 * loudly) or has a default that stays correct everywhere. These two are the exception:
 * they describe *where this deployment lives*, and their defaults are a guess that is
 * right on a laptop and silently wrong in production.
 *
 * "Silently" is the whole problem. A deployed API that still believes it lives at
 * `http://localhost:4000` builds that into the OAuth `redirect_uri` and into the
 * Pub/Sub push endpoint; it starts, serves /health, and looks healthy, and the failure
 * arrives much later as a mailbox that will not connect — or, worse, as a browser sent
 * to the user's own machine carrying an authorization code. So it is a boot error.
 */
const PRODUCTION_URL_VARS = ["API_PUBLIC_URL", "WEB_APP_URL"] as const;

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * In production, refuse a URL that points at this machine, refuse plain http, and
 * refuse an AI endpoint that answers with canned data.
 *
 * `http` matters beyond eavesdropping: the session cookie is `Secure`, and the
 * same-origin check on the BFF compares the browser's `Origin` against the app's own
 * origin — a scheme mismatch between the two makes every write a 403, which is a
 * confusing way to find out about a typo.
 */
function assertProductionConfig(loaded: Env): void {
  if (loaded.NODE_ENV !== "production") return;

  const problems: string[] = [];
  for (const name of PRODUCTION_URL_VARS) {
    const url = new URL(loaded[name]);
    if (isLocalHostname(url.hostname)) {
      problems.push(
        `  - ${name}: points at ${url.hostname}, which no browser can reach in production`,
      );
    } else if (url.protocol !== "https:") {
      problems.push(`  - ${name}: must be https in production`);
    }
  }

  /*
   * Canned AI answers, asked for on purpose, in production.
   *
   * `services/ai/endpoint.ts` already refuses this — but at the first AI call, which is
   * the right place for a *missing* key (the API must boot and serve /health on a host
   * with no AI configured) and the wrong place for this. `AI_PROVIDER=stub` is not an
   * absent value, it is a stated intention, and the consequence is a database filling
   * with fabricated classifications and SAFE threat verdicts. There is nothing to
   * discover at runtime, so it fails here instead.
   */
  if (loaded.AI_PROVIDER === "stub") {
    problems.push(
      `  - AI_PROVIDER: "stub" returns canned answers and is refused in production`,
    );
  }
  if (
    loaded.ANTHROPIC_BASE_URL !== "" &&
    isLocalHostname(new URL(loaded.ANTHROPIC_BASE_URL).hostname)
  ) {
    problems.push(
      `  - ANTHROPIC_BASE_URL: points at this machine, so it is the dev stub rather than a gateway`,
    );
  }

  if (problems.length > 0) {
    throw new Error(["Invalid environment configuration:", ...problems].join("\n"));
  }
}

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
  // After the shape is known good, so this can read the resolved values.
  assertProductionConfig(parsed.data);
  return parsed.data;
}

export const env: Env = loadEnv();
