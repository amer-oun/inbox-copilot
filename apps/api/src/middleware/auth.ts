import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createPublicKey, type KeyObject } from "node:crypto";
import { jwtVerify } from "jose";
import { UnauthorizedError } from "../lib/errors.js";
import { env } from "../lib/env.js";

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

export const requireUser: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  void (async () => {
    try {
      const { payload } = await jwtVerify(bearerToken(req), publicKey, {
        issuer: env.INTERNAL_JWT_ISSUER,
        audience: env.INTERNAL_JWT_AUDIENCE,
        algorithms: ["RS256"],
        clockTolerance: 5,
      });

      if (!payload.sub) {
        throw new UnauthorizedError("Internal token has no subject");
      }

      req.user = { id: payload.sub };
      next();
    } catch (error) {
      // Never echo the verification detail: it distinguishes "expired" from
      // "bad signature" for an attacker probing the internal token format.
      next(
        error instanceof UnauthorizedError
          ? error
          : new UnauthorizedError("Invalid internal token"),
      );
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
