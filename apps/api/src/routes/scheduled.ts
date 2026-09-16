import { Router } from "express";
import {
  scheduledEmailSchema,
  scheduledIdParamsSchema,
  scheduledListQuerySchema,
  scheduledListSchema,
  scheduleNewBodySchema,
  scheduleReplyBodySchema,
} from "@inbox-copilot/shared";
import { currentUser, requireUser } from "../middleware/auth.js";
import {
  cancelScheduledEmail,
  listScheduledEmails,
  scheduleNewMessage,
  scheduleReply,
} from "../services/schedule.js";

/**
 * Scheduled send (§9).
 *
 *   POST /scheduled/replies        queue a reply into a thread. Sends nothing now.
 *   POST /scheduled/messages       queue a new message. Sends nothing now.
 *   GET  /scheduled                what is queued, and what failed.
 *   POST /scheduled/:id/cancel     unqueue it.
 *
 * Read this list next to `routes/reply.ts`, because rule 1 has to survive the addition
 * of a delay. It does, and for the same reason: **both POSTs carry the body**. There is
 * no route here that takes a draft id and a time, and no flag on the drafting route
 * that schedules its output — so a scheduled send, like an immediate one, can only
 * contain text a person had on screen and submitted. The delay changes when the mail
 * goes out, not who decided what is in it.
 *
 * Cancel is a POST rather than a DELETE, deliberately: it does not remove the record,
 * it moves it to CANCELLED. The row is how the user finds out later that their 9am mail
 * did not go, so deleting it would destroy the only evidence of what they asked for.
 */
export const scheduledRouter: Router = Router();

scheduledRouter.use(requireUser);

/** `POST /scheduled/replies` — a reply into an existing thread, at a chosen time. */
scheduledRouter.post("/scheduled/replies", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { threadId, body, sendAtLocal, timezone, expectsReply, draftId } =
    scheduleReplyBodySchema.parse(req.body);

  const result = await scheduleReply({
    userId,
    threadId,
    body,
    sendAtLocal,
    timezone,
    expectsReply,
    ...(draftId === undefined ? {} : { draftId }),
  });

  res.status(201).json(scheduledEmailSchema.parse(result));
});

/** `POST /scheduled/messages` — a new message, at a chosen time. */
scheduledRouter.post("/scheduled/messages", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { mailAccountId, to, cc, subject, body, sendAtLocal, timezone } =
    scheduleNewBodySchema.parse(req.body);

  const result = await scheduleNewMessage({
    userId,
    mailAccountId,
    to,
    cc,
    subject,
    body,
    sendAtLocal,
    timezone,
  });

  res.status(201).json(scheduledEmailSchema.parse(result));
});

/**
 * `GET /scheduled` — the queue.
 *
 * Without a `status` this returns SCHEDULED, SENDING and FAILED: everything that has
 * not yet happened, plus everything that went wrong. FAILED rows are in that default on
 * purpose — a scheduled send is not retried automatically, so this list is the only
 * place a user learns their mail did not go out.
 */
scheduledRouter.get("/scheduled", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { status } = scheduledListQuerySchema.parse(req.query);

  const items = await listScheduledEmails({
    userId,
    ...(status === undefined ? {} : { status }),
  });

  res.json(scheduledListSchema.parse({ items }));
});

/** `POST /scheduled/:id/cancel` — refuses once the send has started. */
scheduledRouter.post("/scheduled/:scheduledId/cancel", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { scheduledId } = scheduledIdParamsSchema.parse(req.params);

  const result = await cancelScheduledEmail({ userId, scheduledId });
  res.json(scheduledEmailSchema.parse(result));
});
