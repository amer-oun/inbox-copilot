import { Router } from "express";
import {
  connectMailAccountParamsSchema,
  oauthCallbackQuerySchema,
} from "@inbox-copilot/shared";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { consumeOAuthState, InvalidOAuthStateError } from "../lib/oauthState.js";
import { completeMailAccountConnect } from "../services/mailAccounts.js";

/**
 * The provider consent redirect lands here. This is the one browser-facing route
 * on the API, so it cannot rely on the internal JWT: it authenticates the flow
 * with the signed, single-use `state` instead (lib/oauthState.ts).
 *
 * Every exit is a 302 back to the web app — a user who just clicked "Allow"
 * should never be shown a JSON error body.
 */
export const oauthRouter: Router = Router();

/** Result codes the settings page turns into a message. Stable, not prose. */
type CallbackOutcome =
  | { ok: true; email: string }
  | { ok: false; reason: "denied" | "invalid_state" | "provider_error" | "failed" };

function redirectToSettings(outcome: CallbackOutcome): string {
  const url = new URL("/settings/accounts", env.WEB_APP_URL);
  if (outcome.ok) {
    url.searchParams.set("connected", outcome.email);
  } else {
    url.searchParams.set("error", outcome.reason);
  }
  return url.toString();
}

oauthRouter.get("/oauth/:provider/callback", async (req, res) => {
  const { provider } = connectMailAccountParamsSchema.parse(req.params);
  const query = oauthCallbackQuerySchema.safeParse(req.query);

  if (!query.success) {
    logger.warn({ provider }, "oauth callback with unusable query");
    res.redirect(redirectToSettings({ ok: false, reason: "invalid_state" }));
    return;
  }

  // The user pressed "Cancel", or the provider refused. `error` is a provider
  // code, safe to log; `error_description` is prose we do not need.
  if (query.data.error) {
    logger.info(
      { provider, providerError: query.data.error },
      "oauth callback returned an error",
    );
    res.redirect(
      redirectToSettings({
        ok: false,
        reason: query.data.error === "access_denied" ? "denied" : "provider_error",
      }),
    );
    return;
  }

  let userId: string;
  try {
    const state = await consumeOAuthState(query.data.state);
    if (state.provider !== provider) {
      throw new InvalidOAuthStateError("state provider does not match the callback");
    }
    userId = state.userId;
  } catch (error) {
    if (error instanceof InvalidOAuthStateError) {
      // Expired consent screen, a replayed callback URL, or a CSRF attempt.
      logger.warn({ provider, err: error.message }, "rejected oauth callback state");
      res.redirect(redirectToSettings({ ok: false, reason: "invalid_state" }));
      return;
    }
    throw error;
  }

  const log = logger.child({ userId, provider });

  if (!query.data.code) {
    log.warn("oauth callback carried neither code nor error");
    res.redirect(redirectToSettings({ ok: false, reason: "provider_error" }));
    return;
  }

  try {
    const account = await completeMailAccountConnect({
      userId,
      provider,
      code: query.data.code,
    });
    res.redirect(redirectToSettings({ ok: true, email: account.emailAddress }));
  } catch (error) {
    // A failed exchange must not surface a stack trace to the browser, and the
    // authorization code must not reach the log.
    log.error({ err: error }, "failed to complete mailbox connection");
    res.redirect(redirectToSettings({ ok: false, reason: "failed" }));
  }
});
