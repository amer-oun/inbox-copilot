import "server-only";
import { hkdfSync, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { jwtVerify, SignJWT } from "jose";
import { env } from "./env";

/**
 * The public demo's session: its own cookie, not an Auth.js session.
 *
 * A demo visitor never touches Auth.js. There is no `Session` row, no `Account`, and no
 * OAuth, so nothing in the sign-in machinery can mistake a demo visit for an account —
 * and nothing about a real account can leak into a demo visit. The cookie carries a
 * signed claim that says "demo" and a random visit id, and `lib/viewer.ts` is the one
 * place that turns either kind of session into "who is looking".
 *
 * The API makes the same separation on its side: the internal JWT for a demo visitor
 * carries `ses: "demo"`, and the API refuses a demo claim for anyone but the demo user
 * and a user claim for the demo user (apps/api/src/middleware/auth.ts).
 *
 * Signed with a key derived from `AUTH_SECRET` rather than the secret itself, so the
 * two cookies never share a key even though they share a root.
 */

export const DEMO_COOKIE = "inbox-copilot-demo";

/** Long enough to look around properly; short enough that a stale tab starts over. */
const DEMO_SESSION_SECONDS = 2 * 60 * 60;

const ISSUER = "inbox-copilot-web";
const AUDIENCE = "inbox-copilot-demo";

let cachedKey: Uint8Array | undefined;

function demoKey(): Uint8Array {
  cachedKey ??= new Uint8Array(
    hkdfSync("sha256", env.AUTH_SECRET, "", "inbox-copilot demo session v1", 32),
  );
  return cachedKey;
}

export function demoEnabled(): boolean {
  return env.DEMO_MODE === true;
}

/** The banner's "by request" link, or null to leave it as plain words. */
export function demoAccessRequestUrl(): string | null {
  return env.DEMO_ACCESS_REQUEST_URL === "" ? null : env.DEMO_ACCESS_REQUEST_URL;
}

export interface DemoSession {
  /** One visit. The API rations live AI calls per visit with it. */
  sessionId: string;
  expires: Date;
}

/** Starts a demo visit: sets the cookie and returns the session it holds. */
export async function createDemoSession(): Promise<DemoSession> {
  const sessionId = randomBytes(18).toString("base64url");
  const expires = new Date(Date.now() + DEMO_SESSION_SECONDS * 1000);

  const token = await new SignJWT({ ses: "demo" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sessionId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expires.getTime() / 1000))
    .sign(demoKey());

  const jar = await cookies();
  jar.set(DEMO_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    expires,
  });

  return { sessionId, expires };
}

/**
 * The demo visit this request carries, or null. Null as well when the demo is switched
 * off: turning `DEMO_MODE` off ends every open demo visit at its next request.
 */
export async function readDemoSession(): Promise<DemoSession | null> {
  if (!demoEnabled()) return null;

  const token = (await cookies()).get(DEMO_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, demoKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    if (payload["ses"] !== "demo" || typeof payload.sub !== "string" || !payload.exp) {
      return null;
    }
    return { sessionId: payload.sub, expires: new Date(payload.exp * 1000) };
  } catch {
    return null;
  }
}

/** Ends the demo visit. Only callable where cookies are writable (actions, routes). */
export async function clearDemoSession(): Promise<void> {
  (await cookies()).delete(DEMO_COOKIE);
}
