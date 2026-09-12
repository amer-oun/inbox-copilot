import { Router } from "express";
import {
  connectMailAccountParamsSchema,
  connectMailAccountResponseSchema,
  disconnectMailAccountResponseSchema,
  mailAccountIdParamsSchema,
  mailAccountListSchema,
} from "@inbox-copilot/shared";
import { currentUser, requireUser } from "../middleware/auth.js";
import {
  disconnectMailAccount,
  listMailAccounts,
  startMailAccountConnect,
} from "../services/mailAccounts.js";

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
mailAccountsRouter.post("/mail-accounts/:provider/connect", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { provider } = connectMailAccountParamsSchema.parse(req.params);

  const { authorizeUrl } = await startMailAccountConnect({ userId, provider });
  res.status(201).json(connectMailAccountResponseSchema.parse({ authorizeUrl }));
});

mailAccountsRouter.delete("/mail-accounts/:mailAccountId", async (req, res) => {
  const { id: userId } = currentUser(req);
  const { mailAccountId } = mailAccountIdParamsSchema.parse(req.params);

  // 200, not 204: the caller needs to know whether the provider grant is really
  // gone, and where to finish the job when it is not.
  const outcome = await disconnectMailAccount({ userId, mailAccountId });
  res.status(200).json(disconnectMailAccountResponseSchema.parse(outcome));
});
