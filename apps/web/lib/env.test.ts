import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The web app's environment, parsed against a real `process.env`.
 *
 * Two things here are deployment-shaped rather than code-shaped, and both were found by
 * writing the deployment down: which variables a Vercel project actually needs, and
 * which localhost defaults are silently wrong once it is not localhost.
 */

const REQUIRED = {
  AUTH_SECRET: "a".repeat(32),
  AUTH_GOOGLE_ID: "google-client-id",
  AUTH_GOOGLE_SECRET: "google-client-secret",
  INTERNAL_JWT_PRIVATE_KEY: Buffer.from("-----BEGIN PRIVATE KEY-----").toString("base64"),
};

/** Fresh module each time: the real one caches on first read, on purpose. */
async function loadEnv(overrides: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("SKIP_ENV_VALIDATION", "");
  for (const [key, value] of Object.entries({ ...REQUIRED, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const { env } = await import("./env");
  // The Proxy validates on first property read, so touch one.
  return { env, node: env.NODE_ENV };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Microsoft sign-in is optional", () => {
  it("loads with no Entra credentials at all", async () => {
    /*
     * These were required, which meant deploying this app required registering an Entra
     * application nobody would use: Outlook sync is not implemented, so Microsoft
     * sign-in buys a second way to create an account and nothing else.
     */
    const { env } = await loadEnv();

    expect(env.AUTH_MICROSOFT_ENTRA_ID_ID).toBe("");
    expect(env.AUTH_MICROSOFT_ENTRA_ID_SECRET).toBe("");
  });

  it("still requires Google, because Gmail is the only mailbox that works", async () => {
    await expect(loadEnv({ AUTH_GOOGLE_ID: "" })).rejects.toThrow(/AUTH_GOOGLE_ID/);
  });
});

describe("production configuration", () => {
  const DEPLOYED = {
    NODE_ENV: "production",
    AUTH_URL: "https://app.example.com",
    API_BASE_URL: "https://api.example.com",
  };

  it("accepts a correctly configured deployment", async () => {
    const { env } = await loadEnv(DEPLOYED);

    expect(env.AUTH_URL).toBe("https://app.example.com");
  });

  it("refuses an AUTH_URL still pointing at localhost", async () => {
    /*
     * The quiet one. Auth.js builds the OAuth `redirect_uri` from this, so a Vercel
     * deployment that kept the default sends users to their own machine to finish
     * signing in — and the page it came from looks perfectly fine.
     */
    await expect(
      loadEnv({ ...DEPLOYED, AUTH_URL: "http://localhost:3000" }),
    ).rejects.toThrow(/AUTH_URL: points at localhost/);
  });

  it("refuses an API_BASE_URL still pointing at localhost", async () => {
    await expect(
      loadEnv({ ...DEPLOYED, API_BASE_URL: "http://localhost:4000" }),
    ).rejects.toThrow(/API_BASE_URL: points at localhost/);
  });

  it("refuses plain http", async () => {
    await expect(
      loadEnv({ ...DEPLOYED, AUTH_URL: "http://app.example.com" }),
    ).rejects.toThrow(/AUTH_URL: must be https/);
  });

  it("leaves development alone", async () => {
    const { env } = await loadEnv({ NODE_ENV: "development" });

    expect(env.AUTH_URL).toBe("http://localhost:3000");
    expect(env.API_BASE_URL).toBe("http://localhost:4000");
  });

  it("is still skipped entirely during `next build`", async () => {
    /*
     * `SKIP_ENV_VALIDATION=1` exists so a production build does not need runtime
     * secrets — and the build script sets `NODE_ENV=production`, so without this branch
     * the new check would fail every Vercel build before a single request arrived.
     */
    vi.resetModules();
    vi.stubEnv("SKIP_ENV_VALIDATION", "1");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_URL", "http://localhost:3000");

    const { env } = await import("./env");

    expect(env.AUTH_URL).toBe("http://localhost:3000");
  });
});
