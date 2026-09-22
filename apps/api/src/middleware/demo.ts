import type { NextFunction, Request, RequestHandler, Response } from "express";
import { DemoRestrictedError } from "../lib/errors.js";
import { DEMO_REFUSALS, type DemoRefusal } from "../services/demo/guard.js";

/**
 * Refuses a route for demo sessions, with a sentence the UI can show as it stands.
 *
 * Mounted after `requireUser` on every route that sends, schedules, or touches a
 * mailbox connection. It is the first of three layers (see `services/demo/guard.ts`)
 * and the only one that answers before any work is done — the service and provider
 * checks exist for the route that forgets this.
 */
export function refuseDemo(refusal: DemoRefusal): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.user?.demo === true) {
      next(new DemoRestrictedError(DEMO_REFUSALS[refusal]));
      return;
    }
    next();
  };
}
