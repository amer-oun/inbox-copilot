// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

/**
 * The demo visit's cookie: its own signed token, never an Auth.js session.
 *
 * What these pin down is that the cookie cannot be forged or repurposed — a token
 * signed with the raw `AUTH_SECRET`, or one that does not say "demo", is not a demo
 * visit — and that switching `DEMO_MODE` off ends every open visit.
 */

vi.mock("server-only", () => ({}));

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const webEnv = vi.hoisted(() => ({
  AUTH_SECRET: "test-auth-secret-that-is-at-least-32-characters",
  DEMO_MODE: true,
  DEMO_ACCESS_REQUEST_URL: "",
  NODE_ENV: "test",
}));
vi.mock("./env", () => ({ env: webEnv }));

const { clearDemoSession, createDemoSession, DEMO_COOKIE, readDemoSession } =
  await import("./demo");

beforeEach(() => {
  jar.clear();
  webEnv.DEMO_MODE = true;
});

describe("demo visits", () => {
  it("round-trips: the cookie it sets is the visit it reads back", async () => {
    const created = await createDemoSession();
    const read = await readDemoSession();

    expect(read?.sessionId).toBe(created.sessionId);
    expect(created.sessionId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("gives every visit its own id", async () => {
    const first = await createDemoSession();
    const second = await createDemoSession();
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("is not a demo visit without the cookie", async () => {
    expect(await readDemoSession()).toBeNull();
  });

  it("rejects a tampered cookie", async () => {
    await createDemoSession();
    const token = jar.get(DEMO_COOKIE) ?? "";
    jar.set(DEMO_COOKIE, `${token.slice(0, -2)}xx`);

    expect(await readDemoSession()).toBeNull();
  });

  it("rejects a token signed with the raw AUTH_SECRET instead of the derived key", async () => {
    const forged = await new SignJWT({ ses: "demo" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("visit_aaaaaaaaaaaaaaaa")
      .setIssuer("inbox-copilot-web")
      .setAudience("inbox-copilot-demo")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(webEnv.AUTH_SECRET));
    jar.set(DEMO_COOKIE, forged);

    expect(await readDemoSession()).toBeNull();
  });

  it("ends every open visit when DEMO_MODE is switched off", async () => {
    await createDemoSession();
    webEnv.DEMO_MODE = false;

    expect(await readDemoSession()).toBeNull();
  });

  it("clears the cookie on exit", async () => {
    await createDemoSession();
    await clearDemoSession();

    expect(jar.has(DEMO_COOKIE)).toBe(false);
    expect(await readDemoSession()).toBeNull();
  });
});
