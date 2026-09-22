import { Router } from "express";
import {
  connectMailAccountParamsSchema,
  connectMailAccountResponseSchema,
  disconnectMailAccountResponseSchema,
  mailAccountIdParamsSchema,
  mailAccountListSchema,
  startSyncResponseSchema,
  syncStatusResponseSchema,
} from "@inbox-copilot/shared";
import { currentUser, requireUser } from "../middleware/auth.js";
import { refuseDemo } from "../middleware/demo.js";
import { requestIdOf } from "../lib/requestId.js";
import {
  disconnectMailAccount,
  listMailAccounts,
  startMailAccountConnect,
} from "../services/mailAccounts.js";
import { getSyncStatus, startBackfill } from "../services/sync.js";

/**
 * Mailbox management, called by the Next.js BFF with an internal JWT.
 * The provider callback is not here — it is browser-facing, see routes/oauth.ts.
 */
export const mailAccountsRouter: Router = Router();

mailAccountsRouter.use(requireUser);

mailAccountsRouter.get("/mail-accounts", async (req, res) => {
  const { id: userId } = currentUser(req);
  const accounts = await listMailAccounts(userId);
  res.json(mailAccountListSchema.parse({ accounts }));
});

/** Starts consent. Returns the URL; the BFF is what redirects the browser. */
mailAccountsRouter.post(
  "/mail-accounts/:provider/connect",
  refuseDemo("connect"),
  async (req, res) => {
    const { id: userId } = currentUser(req);
    const { provider } = connectMailAccountParamsSchema.parse(req.params);

    const { authorizeUrl } = await startMailAccountConnect({ userId, provider });
    res.status(201).json(connectMailAccountResponseSchema.parse({ authorizeUrl }));
  },
);

mailAccountsRouter.delete(
  "/mail-accounts/:mailAccountId",
  refuseDemo("disconnect"),
  async (req, res) => {
    const { id: userId } = currentUser(req);
    const { mailAccountId } = mailAccountIdParamsSchema.parse(req.params);

    // 200, not 204: the caller needs to know whether the provider grant is really
    // gone, and where to finish the job when it is not.
    // The request id travels with it, so the audit row points back at this request's
    // log lines (lib/requestId.ts).
    const outcome = await disconnectMailAccount({
      userId,
      mailAccountId,
      requestId: requestIdOf(req),
    });
    res.status(200).json(disconnectMailAccountResponseSchema.parse(outcome));
  },
);

/**
 * Triggers a backfill. Idempotent by job id: a second call while one is running
 * reports `enqueued: false` rather than queueing a duplicate pass (lib/queues.ts).
 */
mailAccountsRouter.post(
  "/mail-accounts/:mailAccountId/sync",
  refuseDemo("sync"),
  async (req, res) => {
    const { id: userId } = currentUser(req);
    const { mailAccountId } = mailAccountIdParamsSchema.parse(req.params);

    const result = await startBackfill({ userId, mailAccountId });
    res.status(202).json(startSyncResponseSchema.parse(result));
  },
);

mailAccountsRouter.get("/mail-accounts/:mailAccountId/sync-status", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { mailAccountId } = mailAccountIdParamsSchema.parse(req.params);

  res.json(
    syncStatusResponseSchema.parse(await getSyncStatus({ userId, mailAccountId })),
  );
});
