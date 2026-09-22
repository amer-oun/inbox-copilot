import { Router } from "express";
import {
  messageIdParamsSchema,
  threatAppealBodySchema,
  threatAppealResponseSchema,
} from "@inbox-copilot/shared";
import { currentUser, requireUser } from "../middleware/auth.js";
import { markDemoChanged } from "../services/demo/seed.js";
import { recordThreatAppeal } from "../services/security/appeals.js";

/**
 * The threat surface the browser can reach (§6).
 *
 * One route, and the shape of that is the point: a user can tell us we were wrong, and
 * there is no route by which they can tell us we were *right*, no route that re-runs an
 * assessment on demand, and no route that sets a level.
 *
 *   POST /messages/:messageId/threat-appeal   records "this is safe". Changes no verdict.
 *
 * Assessment happens in the enrichment pipeline, from mail the sync engine fetched. That
 * keeps the one expensive, model-calling path out of reach of anything a page can
 * trigger, and it means a verdict is always attributable to a message we stored rather
 * than to a request somebody made.
 */
export const threatRouter: Router = Router();

threatRouter.use(requireUser);

threatRouter.post("/messages/:messageId/threat-appeal", async (req, res) => {
  const user = currentUser(req);
  const { messageId } = messageIdParamsSchema.parse(req.params);
  const { note } = threatAppealBodySchema.parse(req.body ?? {});

  const result = await recordThreatAppeal({
    userId: user.id,
    messageId,
    ...(note === undefined ? {} : { note }),
  });
  // Allowed in the demo, and undone for the next visitor (services/demo/seed.ts): the
  // phishing banner is the point of the tour, so it must not arrive already appealed.
  if (user.demo) await markDemoChanged();

  res.status(201).json(threatAppealResponseSchema.parse(result));
});
