import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ProviderSlug } from "@inbox-copilot/shared";
import { env } from "./env.js";
import { safeEqual } from "./crypto.js";
import { redis } from "./redis.js";

/**
 * CSRF protection for the mailbox OAuth flow.
 *
 * The `state` parameter is `base64url(payload).base64url(HMAC-SHA256(payload))`.
 * Two independent guards:
 *   1. the HMAC — an attacker cannot mint a state we will accept;
 *   2. a one-shot nonce in Redis — a state we did issue cannot be replayed,
 *      so a captured callback URL is worthless the second time.
 *
 * The state also carries the `userId`, which is why the callback needs no
 * session cookie: the provider redirect hits the API directly, cross-site.
 */

const STATE_TTL_SECONDS = 600; // 10 minutes is plenty for a consent screen
const NONCE_KEY_PREFIX = "oauth:state:";

const statePayloadSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1),
  provider: z.enum(["google", "microsoft"]),
  nonce: z.string().min(1),
  /** Unix seconds. */
  exp: z.number().int().positive(),
});

export type OAuthStatePayload = z.infer<typeof statePayloadSchema>;

export class InvalidOAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOAuthStateError";
  }
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", env.OAUTH_STATE_SECRET)
    .update(encodedPayload)
    .digest("base64url");
}

/** Issues a signed, single-use state and registers its nonce in Redis. */
export async function createOAuthState(input: {
  userId: string;
  provider: ProviderSlug;
}): Promise<string> {
  const payload: OAuthStatePayload = {
    v: 1,
    userId: input.userId,
    provider: input.provider,
    nonce: randomBytes(16).toString("base64url"),
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  // Register before handing the state out, so a callback can never race ahead
  // of its own nonce.
  await redis.set(`${NONCE_KEY_PREFIX}${payload.nonce}`, "1", "EX", STATE_TTL_SECONDS);

  return `${encoded}.${sign(encoded)}`;
}

/**
 * Verifies signature, expiry, and single use. Consuming the nonce is atomic
 * (Redis DEL returns the number of keys removed), so two concurrent callbacks
 * with the same state cannot both succeed.
 */
export async function consumeOAuthState(state: string): Promise<OAuthStatePayload> {
  const separator = state.lastIndexOf(".");
  if (separator <= 0) {
    throw new InvalidOAuthStateError("malformed state");
  }

  const encoded = state.slice(0, separator);
  const signature = state.slice(separator + 1);

  if (!safeEqual(signature, sign(encoded))) {
    throw new InvalidOAuthStateError("state signature mismatch");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new InvalidOAuthStateError("state payload is not valid JSON");
  }

  const parsed = statePayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new InvalidOAuthStateError("state payload failed validation");
  }

  if (parsed.data.exp * 1000 < Date.now()) {
    throw new InvalidOAuthStateError("state expired");
  }

  const consumed = await redis.del(`${NONCE_KEY_PREFIX}${parsed.data.nonce}`);
  if (consumed !== 1) {
    throw new InvalidOAuthStateError("state already used or expired");
  }

  return parsed.data;
}
