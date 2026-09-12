import { defineConfig } from "vitest/config";
import { generateKeyPairSync } from "node:crypto";

/**
 * The API verifies the internal JWT with an RS256 public key loaded at import
 * time, so tests need a syntactically valid one. Generated per run: tests that
 * care about JWT verification mint their own keypair instead.
 */
const TEST_JWT_PUBLIC_KEY_B64 = Buffer.from(
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey,
).toString("base64");

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    // Tests never touch real infrastructure — providers and drivers are mocked.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      REDIS_URL: "redis://localhost:6379",
      // Fixed, throwaway values: env.ts validates shape at import time, and
      // crypto tests need a real 32-byte key. Never a production key.
      TOKEN_ENCRYPTION_KEY: "dGVzdC1rZXktZm9yLXVuaXQtdGVzdHMtMzJieXRlcyE=",
      TOKEN_ENCRYPTION_KEY_VERSION: "1",
      OAUTH_STATE_SECRET: "test-oauth-state-secret-at-least-32-chars",
      INTERNAL_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY_B64,
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      MICROSOFT_CLIENT_ID: "test-microsoft-client-id",
      MICROSOFT_CLIENT_SECRET: "test-microsoft-client-secret",
      MICROSOFT_TENANT_ID: "common",
      // Present so the AI client constructs; the SDK itself is always mocked, so
      // no test can reach the real API with it (a fixture is the only response).
      ANTHROPIC_API_KEY: "test-anthropic-key-not-a-real-credential",
    },
  },
});
