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
  /** Canonical origin of this app; Auth.js builds callback URLs from it. */
  AUTH_URL: z.url().default("http://localhost:3000"),

  /** Sign-in credentials. Scopes are set in auth.ts — no mail scopes here. */
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().min(1),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().min(1),
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
