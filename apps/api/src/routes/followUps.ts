import { Router } from "express";
import {
  followUpIdParamsSchema,
  followUpListSchema,
  followUpReminderSchema,
  snoozeFollowUpBodySchema,
} from "@inbox-copilot/shared";
import { currentUser, requireUser } from "../middleware/auth.js";
import {
  dismissReminder,
  listDueReminders,
  snoozeReminder,
} from "../services/followUps.js";

/**
 * Follow-up reminders (§9).
 *
 *   GET  /follow-ups                   what is waiting on a reply.
 *   POST /follow-ups/:id/dismiss       "handled".
 *   POST /follow-ups/:id/snooze        "not yet".
 *
 * There is no `POST /follow-ups`, and that is a design statement rather than an
 * omission. A reminder exists because the *send path* created one when the user asked
 * to be reminded, so it always names a message we know went out and a thread we can
 * watch for the reply. A caller-created reminder would be a reminder the
 * `followup.check` job could never resolve — it would sit there until dismissed by
 * hand, which is the behaviour that teaches people to ignore the list.
 */
export const followUpsRouter: Router = Router();

followUpsRouter.use(requireUser);

/**
 * `GET /follow-ups` — due now, oldest first.
 *
 * Only what is actually due: a reminder set for Thursday is not information on Tuesday,
 * and a list that shows it anyway is a list with nothing to act on in it.
 */
followUpsRouter.get("/follow-ups", async (req, res) => {
  const { id: userId } = currentUser(req);
  res.json(followUpListSchema.parse({ items: await listDueReminders({ userId }) }));
});

/** `POST /follow-ups/:id/dismiss` — terminal. */
followUpsRouter.post("/follow-ups/:reminderId/dismiss", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { reminderId } = followUpIdParamsSchema.parse(req.params);

  res.json(followUpReminderSchema.parse(await dismissReminder({ userId, reminderId })));
});

/** `POST /follow-ups/:id/snooze` — days, not a timestamp (see the body schema). */
followUpsRouter.post("/follow-ups/:reminderId/snooze", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { reminderId } = followUpIdParamsSchema.parse(req.params);
  const { days } = snoozeFollowUpBodySchema.parse(req.body ?? {});

  res.json(
    followUpReminderSchema.parse(await snoozeReminder({ userId, reminderId, days })),
  );
});
