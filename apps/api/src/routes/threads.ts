import { Router } from "express";
import {
  threadDetailSchema,
  threadIdParamsSchema,
  threadListQuerySchema,
  threadListSchema,
} from "@inbox-copilot/shared";
import { currentUser, requireUser } from "../middleware/auth.js";
import { getThread, listThreads } from "../services/threads.js";

/**
 * Inbox reads, called by the Next.js BFF with an internal JWT.
 *
 * Read-only by design in this phase: there is no route here that mutates anything,
 * so nothing the browser can reach can send, label, or delete mail.
 */
export const threadsRouter: Router = Router();

threadsRouter.use(requireUser);

/** `GET /threads?category=WORK&cursor=…&limit=25` */
threadsRouter.get("/threads", async (req, res) => {
  const { id: userId } = currentUser(req);
  const query = threadListQuerySchema.parse(req.query);

  const page = await listThreads({
    userId,
    category: query.category,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });

  res.json(threadListSchema.parse(page));
});

threadsRouter.get("/threads/:threadId", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { threadId } = threadIdParamsSchema.parse(req.params);

  res.json(threadDetailSchema.parse(await getThread({ userId, threadId })));
});
