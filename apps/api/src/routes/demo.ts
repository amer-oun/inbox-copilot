import { Router } from "express";
import { demoSessionResponseSchema } from "@inbox-copilot/shared";
import { ForbiddenError } from "../lib/errors.js";
import { currentUser, requireUser } from "../middleware/auth.js";
import { startDemoSession } from "../services/demo/seed.js";

/**
 * The public demo (`services/demo/`).
 *
 *   POST /demo/session   a visitor pressed "Try the demo". Restores the mailbox if the
 *                        last visitor changed it. Demo sessions only.
 *
 * There is no route that *creates* a demo session: the BFF mints the demo token itself,
 * and this API only accepts it when `DEMO_MODE` is on and the token names the demo user
 * (`middleware/auth.ts`). What this route does is decide whether the new visitor gets
 * the mailbox as it stands or as it was seeded.
 */
export const demoRouter: Router = Router();

demoRouter.use("/demo", requireUser);

demoRouter.post("/demo/session", async (req, res) => {
  const user = currentUser(req);
  // A real account asking to reset the demo is a programming error in the BFF, and it
  // must not be able to restore a mailbox other visitors are reading.
  if (!user.demo) throw new ForbiddenError("Demo sessions only");

  res.json(demoSessionResponseSchema.parse(await startDemoSession()));
});
