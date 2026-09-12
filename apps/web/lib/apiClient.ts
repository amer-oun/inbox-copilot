import "server-only";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";
import { env } from "./env";

/**
 * The BFF half of the web↔api boundary (§1).
 *
 * Every call carries a fresh RS256 JWT whose subject is the session user and
 * whose TTL is 60 seconds: the API needs no session store of its own, and a
 * leaked token is useless within a minute. The browser never sees these tokens
 * and never calls the core API directly.
 */

const TOKEN_TTL_SECONDS = 60;

let cachedKey: KeyObject | undefined;

function privateKey(): KeyObject {
  cachedKey ??= createPrivateKey(
    Buffer.from(env.INTERNAL_JWT_PRIVATE_KEY, "base64").toString("utf8"),
  );
  return cachedKey;
}

async function mintInternalToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(env.INTERNAL_JWT_ISSUER)
    .setAudience(env.INTERNAL_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(privateKey());
}

/** An error response from the core API, in its documented envelope. */
const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ApiRequestInit {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  /** JSON body. */
  body?: unknown;
  /** Next.js fetch cache hint. Mail data is per-user: never cache by default. */
  cache?: RequestCache;
}

/**
 * Calls the core API as `userId` and validates the response against `schema`.
 * A schema is mandatory — an unvalidated API response is how a token-shaped
 * field ends up rendered in a page.
 */
export async function apiFetch<T>(
  userId: string,
  path: string,
  schema: z.ZodType<T>,
  init: ApiRequestInit = {},
): Promise<T> {
  const token = await mintInternalToken(userId);

  const response = await fetch(new URL(path, env.API_BASE_URL), {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    cache: init.cache ?? "no-store",
  });

  if (response.status === 204) {
    return schema.parse(undefined);
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(response.status, "BAD_RESPONSE", "API returned invalid JSON");
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(json);
    throw new ApiError(
      response.status,
      parsed.success ? parsed.data.error.code : "UNKNOWN",
      parsed.success ? parsed.data.error.message : "Request to the API failed",
    );
  }

  return schema.parse(json);
}
