import { Router } from "express";
import {
  messageIdParamsSchema,
  translateBodySchema,
  translationSchema,
} from "@inbox-copilot/shared";
import { currentUser, requireUser } from "../middleware/auth.js";
import { demoTranslate } from "../services/demo/ai.js";
import { resolveTargetLang, translateMessage } from "../services/ai/translate.js";

/**
 * Translation (§9).
 *
 *   POST /messages/:messageId/translate
 *
 * A POST rather than a GET, even though it reads a message and returns text, because
 * the first call for a given `(message, language)` spends tokens. A GET that bills the
 * user is a GET a prefetcher, a link preview or a browser retry can bill them for
 * twice; every subsequent call for the same pair is a cache hit and free, but the
 * method has to describe the worst case rather than the common one.
 *
 * `targetLang` is optional in the body and falls back to `UserSettings.translationLang`
 * — resolved on the server, not filled in by the UI, so "my default language" is one
 * fact in one place. A user with neither gets a 400, because guessing which language
 * somebody reads is not a default anyone should pick for them.
 */
export const translateRouter: Router = Router();

translateRouter.use(requireUser);

translateRouter.post("/messages/:messageId/translate", async (req, res) => {
  const user = currentUser(req);
  const userId = user.id;
  const { messageId } = messageIdParamsSchema.parse(req.params);
  const { targetLang } = translateBodySchema.parse(req.body ?? {});

  const resolved = await resolveTargetLang({
    userId,
    ...(targetLang === undefined ? {} : { requested: targetLang }),
  });

  // The demo serves its pre-written translations from the ordinary cache and rations
  // any live call (services/demo/ai.ts).
  const result = user.demo
    ? await demoTranslate({ user, messageId, targetLang: resolved })
    : await translateMessage({ userId, messageId, targetLang: resolved });
  res.json(translationSchema.parse(result));
});
