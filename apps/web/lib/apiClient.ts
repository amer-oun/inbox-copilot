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

/**
 * Who a call is made as. A `Viewer` (lib/viewer.ts) is one; the type is structural so
 * the tests and the few callers that are not pages do not need the whole viewer.
 */
export interface ApiCaller {
  userId: string;
  /** Present only for a demo visit, and what makes the token a demo token. */
  demoSessionId?: string;
}

/**
 * `ses` says which kind of session this is, and the API holds it to the subject: a
 * demo claim must name the demo user and a user claim must not
 * (apps/api/src/middleware/auth.ts). `sid` is the demo visit, which the API rations
 * live AI calls by.
 */
async function mintInternalToken(caller: ApiCaller): Promise<string> {
  const claims =
    caller.demoSessionId === undefined
      ? { ses: "user" }
      : { ses: "demo", sid: caller.demoSessionId };

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(caller.userId)
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

/**
 * The API did not answer: refused, timed out, or its host said it is not up yet.
 *
 * Its own type because the free API host sleeps after a quarter of an hour idle and
 * takes about half a minute to wake, and "the server is starting" is the one failure a
 * page should answer with patience rather than an error (components/shell/StartingUp).
 */
export class ApiUnavailableError extends ApiError {
  constructor(
    message = "The server is starting up — this takes about 30 seconds on the free server. Try again in a moment.",
  ) {
    super(503, "API_STARTING", message);
    this.name = "ApiUnavailableError";
  }
}

export function isApiUnavailable(error: unknown): error is ApiUnavailableError {
  return error instanceof ApiUnavailableError;
}

/**
 * How long a read waits before calling the API unavailable. Shorter than a serverless
 * function's own limit, so a sleeping API becomes a "starting up" page rather than the
 * platform's timeout page. Writes wait longer: drafting three replies is a model call.
 */
const READ_TIMEOUT_MS = 9_000;
const WRITE_TIMEOUT_MS = 60_000;

/** What a host in front of a waking service answers with before the service is up. */
const WAKING_STATUSES = new Set([502, 503, 504]);

interface ApiRequestInit {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  /** JSON body. */
  body?: unknown;
  /** Next.js fetch cache hint. Mail data is per-user: never cache by default. */
  cache?: RequestCache;
  /** Overrides the read/write default; see `READ_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Calls the core API as `userId` and validates the response against `schema`.
 * A schema is mandatory — an unvalidated API response is how a token-shaped
 * field ends up rendered in a page.
 */
export async function apiFetch<T>(
  caller: ApiCaller,
  path: string,
  schema: z.ZodType<T>,
  init: ApiRequestInit = {},
): Promise<T> {
  const token = await mintInternalToken(caller);
  const method = init.method ?? "GET";
  const timeoutMs =
    init.timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(new URL(path, env.API_BASE_URL), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: init.cache ?? "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Connection refused, DNS, reset, or our own timeout — all "not reachable yet".
    throw new ApiUnavailableError();
  }

  if (WAKING_STATUSES.has(response.status) && !isApiEnvelope(response)) {
    // The host's own error page, not our API's: the service behind it is not up.
    throw new ApiUnavailableError();
  }

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

/**
 * Whether a response came from our API rather than from the host in front of it. The
 * API always answers JSON; a waking host answers with an HTML page.
 */
function isApiEnvelope(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("application/json");
}
