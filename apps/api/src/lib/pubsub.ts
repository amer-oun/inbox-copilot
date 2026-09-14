import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  gmailNotificationSchema,
  pubsubPushEnvelopeSchema,
  type GmailNotification,
} from "@inbox-copilot/shared";
import { env } from "./env.js";
import { UnauthorizedError } from "./errors.js";
import { logger } from "./logger.js";

/**
 * Pub/Sub push authentication and payload decoding (§4).
 *
 * The webhook is the second unauthenticated route in the application (the OAuth
 * callback is the first), and the only one anybody on the internet can find by
 * guessing. Two separate ideas keep it safe, and they are worth not conflating:
 *
 *   1. **Authentication** — the request carries a Google-signed OIDC token whose
 *      audience and service account we chose. That is what this file verifies.
 *   2. **Trust in the payload** — none. Even a perfectly authenticated push is
 *      treated as "something changed in this mailbox, go and look": the address is
 *      used as a lookup key into our own rows, the history id is only logged, and
 *      every byte that reaches the database comes from an authenticated Gmail read
 *      that we initiate. So a compromised topic can, at worst, make us re-read a
 *      mailbox we already have access to.
 */

/** Google's OIDC signing keys. Cached and refreshed by `jose`. */
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");

/** The issuers Google uses for identity tokens; both appear in the wild. */
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * One JWKS client for the process. Built lazily so importing this module does not
 * reach out to the network, and shared so verification does not re-fetch the key set
 * on every push — a busy mailbox is a burst of requests, and each one would
 * otherwise pay for a round trip to Google.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function googleKeys(): ReturnType<typeof createRemoteJWKSet> {
  jwks ??= createRemoteJWKSet(GOOGLE_JWKS_URL, {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  return jwks;
}

/** Test hook: drop the cached key set so a mocked JWKS is picked up. */
export function resetPubsubKeys(): void {
  jwks = undefined;
}

/** The audience the push token must carry. */
export function expectedAudience(): string {
  if (env.GMAIL_PUBSUB_AUDIENCE !== "") return env.GMAIL_PUBSUB_AUDIENCE;
  // The conventional default: the push endpoint's own URL. Stated here rather than in
  // the setup doc alone, so a deployment that forgets the variable still requires an
  // audience rather than accepting any.
  return new URL("/webhooks/gmail", env.API_PUBLIC_URL).toString();
}

function bearerToken(header: string | undefined): string {
  if (header === undefined || !header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Push request carried no bearer token");
  }
  const token = header.slice("Bearer ".length).trim();
  if (token === "") throw new UnauthorizedError("Push request carried no bearer token");
  return token;
}

/**
 * Whether the development shared secret is usable.
 *
 * Production is excluded here rather than at the call site, and `NODE_ENV` is checked
 * every time rather than captured at import: this is the one code path that would
 * accept a hand-written token, and it should be impossible to reach in a deployment
 * even if somebody sets the variable there.
 */
function devTokenEnabled(): boolean {
  return env.GMAIL_WEBHOOK_DEV_TOKEN !== "" && env.NODE_ENV !== "production";
}

export interface VerifiedPush {
  /** The service account that signed it, when the token disclosed one. */
  serviceAccount: string | null;
  /** True when this was accepted via the development secret rather than an OIDC token. */
  dev: boolean;
}

/**
 * Verifies that a push request came from our Pub/Sub subscription.
 *
 * Checks, in order: a Google signature over the token, the issuer, the audience we
 * configured on the subscription, and — when configured — that the token was minted
 * for our own push service account. The last check is what stops anyone who owns *any*
 * Google service account from minting a token for a URL they guessed.
 */
export async function verifyPushRequest(
  authorization: string | undefined,
): Promise<VerifiedPush> {
  const token = bearerToken(authorization);

  if (devTokenEnabled() && token === env.GMAIL_WEBHOOK_DEV_TOKEN) {
    logger.warn(
      { env: env.NODE_ENV },
      "gmail webhook accepted a DEVELOPMENT token; never enable this in production",
    );
    return { serviceAccount: null, dev: true };
  }

  let payload: JWTPayload & { email?: unknown; email_verified?: unknown };
  try {
    ({ payload } = await jwtVerify(token, googleKeys(), {
      issuer: GOOGLE_ISSUERS,
      audience: expectedAudience(),
      algorithms: ["RS256"],
      clockTolerance: 30,
    }));
  } catch (error) {
    // The reason is logged, never returned: a caller who cannot authenticate does not
    // get told which check failed.
    logger.warn({ err: error }, "gmail webhook rejected a push token");
    throw new UnauthorizedError("Push token verification failed");
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  const expected = env.GMAIL_PUBSUB_SERVICE_ACCOUNT;

  if (expected !== "" && email?.toLowerCase() !== expected.toLowerCase()) {
    logger.warn(
      { subject: payload.sub },
      "gmail webhook rejected a push token from an unexpected service account",
    );
    throw new UnauthorizedError("Push token verification failed");
  }

  if (expected !== "" && payload.email_verified !== true) {
    throw new UnauthorizedError("Push token verification failed");
  }

  return { serviceAccount: email, dev: false };
}

export interface DecodedNotification {
  /** The mailbox the publisher says changed. A lookup key, never data. */
  emailAddress: string;
  /** Logged only. The delta reads from our own cursor — see the note above. */
  claimedHistoryId: string | null;
  messageId: string | null;
}

/**
 * Decodes the envelope far enough to know which mailbox to re-read.
 *
 * Returns `null` rather than throwing for a payload that is missing or unreadable:
 * Pub/Sub retries a failed delivery, and retrying a message that will never parse is
 * a loop. A malformed push is logged and acknowledged.
 */
export function decodeGmailNotification(body: unknown): DecodedNotification | null {
  const envelope = pubsubPushEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    logger.warn("gmail webhook received a body that is not a Pub/Sub envelope");
    return null;
  }

  const data = envelope.data.message.data;
  if (data === undefined || data === "") {
    logger.debug("gmail webhook received a push with no payload");
    return null;
  }

  let parsed: GmailNotification;
  try {
    const json: unknown = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    const result = gmailNotificationSchema.safeParse(json);
    if (!result.success) {
      logger.warn("gmail webhook payload is not a Gmail notification");
      return null;
    }
    parsed = result.data;
  } catch {
    logger.warn("gmail webhook payload is not base64 JSON");
    return null;
  }

  return {
    emailAddress: parsed.emailAddress.toLowerCase(),
    claimedHistoryId: parsed.historyId === undefined ? null : String(parsed.historyId),
    messageId: envelope.data.message.messageId ?? null,
  };
}
