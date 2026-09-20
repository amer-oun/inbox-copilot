import { z } from "zod";

/**
 * Server-only environment. Imported by server components, route handlers, and
 * server actions — never by a `"use client"` module, or the secrets would be
 * bundled into the browser.
 */

const base64Pem = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").toString("utf8").includes("-----BEGIN"),
    { message: "must be a base64-encoded PEM block" },
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** Auth.js session cookie signing/encryption secret. */
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be >= 32 chars"),
  /**
   * Canonical origin of this app; Auth.js builds callback URLs from it.
   *
   * The localhost default is development only and is refused in production — see
   * `assertProductionUrls`. On Vercel it must be the deployment's own https origin,
   * because it is what ends up in the `redirect_uri` sent to Google.
   */
  AUTH_URL: z.url().default("http://localhost:3000"),

  /** Sign-in credentials. Scopes are set in auth.ts — no mail scopes here. */
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  /**
   * Microsoft sign-in, which is **optional**: empty means the provider is not
   * registered and the button is not shown (auth.ts, app/signin/page.tsx).
   *
   * Required once, which made deploying the app require an Entra application nobody
   * was going to use — Outlook sync is not implemented, so Microsoft sign-in buys a
   * second way to create an account and nothing else. Google is the required one
   * because the only mailbox this app can read is Gmail.
   */
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().default(""),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().default(""),
  /** "common" for work + personal accounts; a tenant GUID to lock it down. */
  AUTH_MICROSOFT_ENTRA_ID_TENANT: z.string().min(1).default("common"),

  /** Core API, server-side only. The browser never talks to it directly. */
  API_BASE_URL: z.url().default("http://localhost:4000"),
  /** RS256 private key used to mint the short-TTL internal JWT. */
  INTERNAL_JWT_PRIVATE_KEY: base64Pem,
  INTERNAL_JWT_ISSUER: z.string().min(1).default("inbox-copilot-web"),
  INTERNAL_JWT_AUDIENCE: z.string().min(1).default("inbox-copilot-api"),
});

export type WebEnv = z.infer<typeof envSchema>;

/**
 * The two variables whose localhost defaults are right locally and silently wrong in a
 * deployment: this app's own origin, and the core API's.
 *
 * Getting `API_BASE_URL` wrong on Vercel is the loud case — every page fails to fetch.
 * `AUTH_URL` is the quiet one: Auth.js builds the OAuth `redirect_uri` from it, so a
 * deployment that still says `http://localhost:3000` sends users to their own machine
 * to finish signing in. Both are refused at the first read rather than left to be
 * discovered.
 */
const PRODUCTION_URL_VARS = ["AUTH_URL", "API_BASE_URL"] as const;

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".localhost")
  );
}

function assertProductionUrls(loaded: WebEnv): void {
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

  if (problems.length > 0) {
    throw new Error(["Invalid web environment configuration:", ...problems].join("\n"));
  }
}

let cached: WebEnv | undefined;

function loadEnv(): WebEnv {
  if (process.env["SKIP_ENV_VALIDATION"] === "1") {
    // `next build` imports every server module to collect page data, which would
    // otherwise make a production build require runtime OAuth secrets. Set only
    // by the build script — a request that reads a missing value still fails,
    // loudly, at runtime.
    return process.env as unknown as WebEnv;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid web environment configuration:\n${issues}`);
  }
  assertProductionUrls(parsed.data);
  return parsed.data;
}

/**
 * Validated lazily, on first property read, rather than at import time.
 *
 * `next build` imports every server module to collect page data, so eager
 * validation would make a production build require the runtime OAuth secrets.
 * Reading any field still fails loudly — just at the first request that needs it,
 * not at compile time. (The API, a long-running process, validates at boot.)
 */
export const env: WebEnv = new Proxy({} as WebEnv, {
  get(_target, property: string | symbol): unknown {
    cached ??= loadEnv();
    return cached[property as keyof WebEnv];
  },
});
