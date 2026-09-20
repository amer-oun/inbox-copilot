import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";

/**
 * The environment schema itself, parsed against a real `process.env`.
 *
 * Everything else in this codebase mocks `lib/env.js`, which is the right thing for a
 * unit test and leaves exactly one thing uncovered: whether the schema accepts the file
 * we tell people to copy. `.env.example` names every variable and leaves the optional
 * ones as `""`, because a commented-out variable is one nobody discovers — so `""` has
 * to mean "unset" for every one of them, and an empty value must never be the thing
 * that stops the process booting.
 */

/** The minimum a boot needs: everything `.env.example` says to generate. */
const REQUIRED = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://inbox:inbox@localhost:5432/inbox_copilot",
  REDIS_URL: "redis://localhost:6379",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  OAUTH_STATE_SECRET: "a".repeat(32),
  INTERNAL_JWT_PUBLIC_KEY: Buffer.from("-----BEGIN PUBLIC KEY-----").toString("base64"),
};

/**
 * Load a fresh copy of the module, so the top-level parse runs again.
 *
 * The throw is caught and *returned* rather than left as a rejected promise for
 * `expect(...).rejects`. A dynamic import that rejects leaves a failed module evaluation
 * behind, and vitest surfaced that as an unhandled `ERR_IPC_CHANNEL_CLOSED` during pool
 * teardown — long after every assertion had passed, in roughly one run in three. A
 * refusal to boot is a result here, which is also closer to what it actually is.
 */
async function load(
  overrides: Record<string, string>,
): Promise<{ ok: true; env: Env } | { ok: false; message: string }> {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...overrides })) {
    vi.stubEnv(key, value);
  }
  try {
    return { ok: true, env: (await import("./env.js")).env };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The env, for a configuration expected to be valid. */
async function loadEnv(overrides: Record<string, string>): Promise<Env> {
  const result = await load(overrides);
  if (!result.ok) {
    throw new Error(`expected this configuration to load: ${result.message}`);
  }
  return result.env;
}

/** The boot error, for a configuration expected to be refused. */
async function loadFailure(overrides: Record<string, string>): Promise<string> {
  const result = await load(overrides);
  if (result.ok) {
    throw new Error("expected this configuration to be refused, but it loaded");
  }
  return result.message;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("AI_PROVIDER", () => {
  it("treats an empty value as unset", async () => {
    /*
     * The exact line `.env.example` ships. Before this, `--env-file` put `""` into
     * `process.env` and a bare `z.enum` refused it, so a fresh clone that followed the
     * documented setup could not start the API at all — and the error named the rule
     * (`expected one of "anthropic"|"gemini"|"stub"`) rather than the mistake.
     */
    const env = await loadEnv({ AI_PROVIDER: "" });

    expect(env.AI_PROVIDER).toBeUndefined();
  });

  it("keeps a named provider", async () => {
    const env = await loadEnv({ AI_PROVIDER: "gemini" });

    expect(env.AI_PROVIDER).toBe("gemini");
  });

  it("still refuses a value that is not one of the three", async () => {
    // Empty meaning "unset" must not turn into "anything goes": a typo here would
    // silently fall back to the inferred provider and answer mail with the wrong model.
    expect(await loadFailure({ AI_PROVIDER: "openai" })).toMatch(
      /Invalid environment configuration/,
    );
  });
});

describe("the file we tell people to copy", () => {
  it("boots with every optional variable left empty", async () => {
    /*
     * `.env.example` with nothing but the generated secrets filled in. This is the
     * first five minutes of anybody's first day on this project, and it has to work.
     */
    const env = await loadEnv({
      AI_PROVIDER: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "",
      GEMINI_API_KEY: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      MICROSOFT_CLIENT_ID: "",
      MICROSOFT_CLIENT_SECRET: "",
      RESEND_API_KEY: "",
      DIGEST_FROM_ADDRESS: "",
      GMAIL_PUBSUB_TOPIC: "",
      GMAIL_PUBSUB_AUDIENCE: "",
      GMAIL_PUBSUB_SERVICE_ACCOUNT: "",
      GMAIL_WEBHOOK_DEV_TOKEN: "",
    });

    expect(env.AI_PROVIDER).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("");
    // Which, per services/ai/endpoint.ts, is what makes `pnpm dev` reach the stub.
    expect(env.NODE_ENV).toBe("development");
  });
});

describe("WORKER_IN_PROCESS", () => {
  it("defaults to false, so the dedicated worker stays the default shape", async () => {
    const env = await loadEnv({});

    expect(env.WORKER_IN_PROCESS).toBe(false);
  });

  it("accepts true and 1", async () => {
    expect((await loadEnv({ WORKER_IN_PROCESS: "true" })).WORKER_IN_PROCESS).toBe(true);
    expect((await loadEnv({ WORKER_IN_PROCESS: "1" })).WORKER_IN_PROCESS).toBe(true);
  });

  it("refuses anything else rather than reading it as false", async () => {
    /*
     * The important test here. A flag that quietly means false when it was meant to
     * mean true produces a deployment that accepts work, enqueues it, and runs none of
     * it — scheduled sends that never go out, with no error anywhere. So `yes` is a
     * boot failure, not a shrug.
     */
    expect(await loadFailure({ WORKER_IN_PROCESS: "yes" })).toMatch(/WORKER_IN_PROCESS/);
  });
});

describe("production configuration", () => {
  /** A deployment's worth of overrides, correct unless a test spoils one. */
  const DEPLOYED = {
    NODE_ENV: "production",
    API_PUBLIC_URL: "https://api.example.com",
    WEB_APP_URL: "https://app.example.com",
    GEMINI_API_KEY: "a-key",
    AI_PROVIDER: "gemini",
  };

  it("accepts a correctly configured deployment", async () => {
    const env = await loadEnv(DEPLOYED);

    expect(env.NODE_ENV).toBe("production");
    expect(env.API_PUBLIC_URL).toBe("https://api.example.com");
  });

  it("refuses to boot when API_PUBLIC_URL still points at localhost", async () => {
    /*
     * The one that cannot be allowed to start. This value becomes the OAuth
     * `redirect_uri`, so a deployed API that kept the development default sends the
     * user's browser to *their own machine* carrying an authorization code — and
     * everything up to that point looks healthy.
     */
    expect(
      await loadFailure({ ...DEPLOYED, API_PUBLIC_URL: "http://localhost:4000" }),
    ).toMatch(/API_PUBLIC_URL: points at localhost/);
  });

  it("refuses to boot when WEB_APP_URL still points at localhost", async () => {
    expect(
      await loadFailure({ ...DEPLOYED, WEB_APP_URL: "http://127.0.0.1:3000" }),
    ).toMatch(/WEB_APP_URL: points at 127\.0\.0\.1/);
  });

  it("refuses plain http in production", async () => {
    // The session cookie is Secure and the BFF compares origins; a scheme mismatch
    // makes every write a 403, which is a baffling way to learn about a typo.
    expect(
      await loadFailure({ ...DEPLOYED, WEB_APP_URL: "http://app.example.com" }),
    ).toMatch(/WEB_APP_URL: must be https/);
  });

  it("reports every wrong URL at once", async () => {
    // Fixing these one deploy at a time is how an afternoon goes.
    expect(
      await loadFailure({
        ...DEPLOYED,
        API_PUBLIC_URL: "http://localhost:4000",
        WEB_APP_URL: "http://localhost:3000",
      }),
    ).toMatch(/API_PUBLIC_URL[\s\S]*WEB_APP_URL/);
  });

  it("refuses AI_PROVIDER=stub", async () => {
    /*
     * `services/ai/endpoint.ts` refuses this too, at the first call — which is right
     * for a *missing* key, because the API must boot and serve /health on a host with
     * no AI configured. `stub` is not a missing value, it is a stated intention, and
     * what it produces is a database of fabricated classifications and SAFE threat
     * verdicts. Nothing has to be discovered at runtime, so it fails at boot.
     */
    expect(await loadFailure({ ...DEPLOYED, AI_PROVIDER: "stub" })).toMatch(
      /AI_PROVIDER: "stub" returns canned answers/,
    );
  });

  it("refuses an ANTHROPIC_BASE_URL pointing at this machine", async () => {
    // Which is the dev stub wearing a gateway's clothes.
    expect(
      await loadFailure({
        ...DEPLOYED,
        AI_PROVIDER: "anthropic",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4010",
      }),
    ).toMatch(/ANTHROPIC_BASE_URL: points at this machine/);
  });

  it("allows a real gateway", async () => {
    const env = await loadEnv({
      ...DEPLOYED,
      AI_PROVIDER: "anthropic",
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      ANTHROPIC_API_KEY: "sk-whatever",
    });

    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com");
  });

  it("leaves development alone, localhost and all", async () => {
    // None of the above may make `pnpm dev` harder to run.
    const env = await loadEnv({ NODE_ENV: "development", AI_PROVIDER: "stub" });

    expect(env.API_PUBLIC_URL).toBe("http://localhost:4000");
    expect(env.AI_PROVIDER).toBe("stub");
  });
});
