import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** Load a fresh copy of the module, so the top-level parse runs again. */
async function loadEnv(overrides: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...overrides })) {
    vi.stubEnv(key, value);
  }
  return (await import("./env.js")).env;
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
    await expect(loadEnv({ AI_PROVIDER: "openai" })).rejects.toThrow(
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
