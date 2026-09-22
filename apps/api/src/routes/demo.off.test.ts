import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { DEMO_USER_ID } from "@inbox-copilot/shared";

/**
 * With `DEMO_MODE` off — the default — a demo token is just an invalid token.
 *
 * Its own file because the flag is read once, when `lib/env.ts` is imported, and
 * vitest gives each file a fresh module graph.
 */

const keypair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const privateKey = createPrivateKey(keypair.privateKey);
process.env["INTERNAL_JWT_PUBLIC_KEY"] = Buffer.from(keypair.publicKey).toString(
  "base64",
);
delete process.env["DEMO_MODE"];

const listThreads = vi.hoisted(() => vi.fn());
const ensureDemoMailbox = vi.hoisted(() => vi.fn());

vi.mock("../services/threads.js", () => ({ listThreads, getThread: vi.fn() }));
vi.mock("../services/demo/seed.js", () => ({
  ensureDemoMailbox,
  markDemoChanged: vi.fn(),
  startDemoSession: vi.fn(),
}));
vi.mock("../services/demo/ai.js", () => ({
  demoReplies: vi.fn(),
  demoTranslate: vi.fn(),
}));
vi.mock("@inbox-copilot/db", () => ({ pingDatabase: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  pingRedis: vi.fn(),
  redis: { set: vi.fn(), del: vi.fn(), eval: vi.fn() },
}));

const { createApp } = await import("../app.js");

describe("DEMO_MODE off", () => {
  it("refuses a well-formed demo token", async () => {
    const demoToken = await new SignJWT({ ses: "demo", sid: "visit_abcdefghijklmnop" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setSubject(DEMO_USER_ID)
      .setIssuer("inbox-copilot-web")
      .setAudience("inbox-copilot-api")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(privateKey);

    const response = await request(createApp())
      .get("/threads")
      .set("authorization", `Bearer ${demoToken}`);

    expect(response.status).toBe(401);
    expect(listThreads).not.toHaveBeenCalled();
    expect(ensureDemoMailbox).not.toHaveBeenCalled();
  });
});
