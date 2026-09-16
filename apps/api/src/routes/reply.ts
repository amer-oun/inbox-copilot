import { Router } from "express";
import {
  composeBodySchema,
  composeResultSchema,
  generateRepliesBodySchema,
  replyDraftsResponseSchema,
  sendReplyBodySchema,
  sendResultSchema,
  threadIdParamsSchema,
  writingStyleResponseSchema,
} from "@inbox-copilot/shared";
import { currentUser, requireUser } from "../middleware/auth.js";
import { generateReplies } from "../services/ai/reply.js";
import { composeMessage } from "../services/ai/compose.js";
import { buildWritingStyle, getWritingStyle } from "../services/ai/style.js";
import { sendReply } from "../services/send.js";

/**
 * Drafting, composing and sending (phase 6).
 *
 * The route list is the enforcement of rule 1, so it is worth reading as one:
 *
 *   POST /threads/:id/replies   generates drafts. Writes `ReplyDraft` rows. Sends nothing.
 *   POST /threads/:id/reply     sends the body in the request. Calls no model.
 *   POST /compose               returns subject and body. Sends nothing.
 *
 * The two halves never meet. There is no parameter on the send route that names a
 * draft to send, and no flag on the generate route that sends the result — so the
 * only way model output reaches a mailbox is through a person reading it and posting
 * it back. That is a property of the URL space, not of the implementation, which is
 * why it is stated here rather than trusted to the services.
 */
export const replyRouter: Router = Router();

replyRouter.use(requireUser);

/** `POST /threads/:id/replies` — three drafts. Nothing is sent. */
replyRouter.post("/threads/:threadId/replies", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { threadId } = threadIdParamsSchema.parse(req.params);
  const { tone } = generateRepliesBodySchema.parse(req.body ?? {});

  const result = await generateReplies({
    userId,
    threadId,
    ...(tone === undefined ? {} : { tone }),
  });

  res.status(201).json(replyDraftsResponseSchema.parse(result));
});

/**
 * `POST /threads/:id/reply` — sends.
 *
 * The body is the text the user submitted. No model is called on this path at all:
 * `draftId` is recorded as feedback and is never read to decide what goes out.
 */
replyRouter.post("/threads/:threadId/reply", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { threadId } = threadIdParamsSchema.parse(req.params);
  const { body, draftId, expectsReply } = sendReplyBodySchema.parse(req.body);

  const result = await sendReply({
    userId,
    threadId,
    body,
    expectsReply,
    ...(draftId === undefined ? {} : { draftId }),
  });

  res.status(201).json(sendResultSchema.parse(result));
});

/** `POST /compose` — a new message, as text for the composer. Nothing is sent. */
replyRouter.post("/compose", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { intent, to, tone } = composeBodySchema.parse(req.body);

  const result = await composeMessage({
    userId,
    intent,
    to,
    ...(tone === undefined ? {} : { tone }),
  });

  res.json(composeResultSchema.parse(result));
});

/** `GET /writing-style` — the stored profile, or null when there is none yet. */
replyRouter.get("/writing-style", async (req, res) => {
  const { id: userId } = currentUser(req);
  res.json(writingStyleResponseSchema.parse({ style: await getWritingStyle(userId) }));
});

/**
 * `POST /writing-style` — rebuild it now.
 *
 * `force` is a query flag rather than the default: the profile is a Sonnet call over
 * thirty messages, and "refresh" pressed twice should not bill twice for the same
 * answer. Without it, a profile built in the last month is returned as it stands.
 */
replyRouter.post("/writing-style", async (req, res) => {
  const { id: userId } = currentUser(req);
  const force = req.query["force"] === "true";

  const result = await buildWritingStyle({ userId, force });
  res.json(writingStyleResponseSchema.parse({ style: result.style }));
});
