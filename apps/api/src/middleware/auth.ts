import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createPublicKey, type KeyObject } from "node:crypto";
import { jwtVerify, type JWTPayload } from "jose";
import { isDemoUserId } from "@inbox-copilot/shared";
import { UnauthorizedError } from "../lib/errors.js";
import { env } from "../lib/env.js";
import { ensureDemoMailbox } from "../services/demo/seed.js";

/**
 * The API trusts exactly one caller: the Next.js BFF, which signs a short-TTL
 * RS256 JWT whose subject is the session user (§1). Browsers never talk to this
 * API with a session cookie — except the OAuth callback, which authenticates
 * itself with a signed `state` instead (see lib/oauthState.ts).
 */

const publicKey: KeyObject = createPublicKey(
  Buffer.from(env.INTERNAL_JWT_PUBLIC_KEY, "base64").toString("utf8"),
);

export interface AuthenticatedUser {
  id: string;
  /**
   * A public demo session (`services/demo/`). Always the shared demo user, and never
   * allowed to reach a mail provider — see `middleware/demo.ts`.
   */
  demo: boolean;
  /**
   * Demo only: one visitor's session, so the live-AI allowance is per visitor rather
   * than one pool the first visitor can empty.
   */
  demoSessionId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

function bearerToken(req: Request): string {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError("Missing bearer token");
  return token;
}

/**
 * Reads the session kind out of a verified token, refusing any mismatch.
 *
 * The web app stamps `ses: "demo"` on demo sessions and `ses: "user"` on real ones; a
 * token with no `ses` is a real session minted before the claim existed. The rule is
 * symmetric on purpose: a demo claim must name the demo user, and a real claim must
 * *not* — so neither a bug in the BFF nor a stolen demo token can turn one kind of
 * session into the other.
 */
export function sessionOf(payload: JWTPayload): AuthenticatedUser {
  if (!payload.sub) {
    throw new UnauthorizedError("Internal token has no subject");
  }

  const kind = payload["ses"] ?? "user";
  if (kind !== "user" && kind !== "demo") {
    throw new UnauthorizedError("Invalid internal token");
  }

  if (kind === "user") {
    if (isDemoUserId(payload.sub)) throw new UnauthorizedError("Invalid internal token");
    return { id: payload.sub, demo: false };
  }

  if (!env.DEMO_MODE || !isDemoUserId(payload.sub)) {
    throw new UnauthorizedError("Invalid internal token");
  }
  const sid = payload["sid"];
  if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(sid)) {
    throw new UnauthorizedError("Invalid internal token");
  }
  return { id: payload.sub, demo: true, demoSessionId: sid };
}

export const requireUser: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  void (async () => {
    let user: AuthenticatedUser;
    try {
      const { payload } = await jwtVerify(bearerToken(req), publicKey, {
        issuer: env.INTERNAL_JWT_ISSUER,
        audience: env.INTERNAL_JWT_AUDIENCE,
        algorithms: ["RS256"],
        clockTolerance: 5,
      });
      user = sessionOf(payload);
    } catch (error) {
      // Never echo the verification detail: it distinguishes "expired" from
      // "bad signature" for an attacker probing the internal token format.
      next(
        error instanceof UnauthorizedError
          ? error
          : new UnauthorizedError("Invalid internal token"),
      );
      return;
    }

    req.user = user;
    try {
      /*
       * The demo mailbox is seeded on first use in each process rather than by a
       * deploy step, so a fresh database, a cold start or a reset that failed halfway
       * all heal on the next demo request. Memoized in `ensureDemoMailbox`; after the
       * first call this is a timestamp comparison. Outside the token `try` above, so
       * a database error reads as one rather than as a bad token.
       */
      if (user.demo) await ensureDemoMailbox();
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/** Reads the user an authenticated handler is running for. */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    // A programming error: the route forgot `requireUser`.
    throw new UnauthorizedError("Request is not authenticated");
  }
  return req.user;
}
