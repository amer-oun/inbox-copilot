import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { logger, redactUrl } from "./lib/logger.js";
import { healthRouter } from "./routes/health.js";
import { mailAccountsRouter } from "./routes/mailAccounts.js";
import { oauthRouter } from "./routes/oauth.js";
import { replyRouter } from "./routes/reply.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { threadsRouter } from "./routes/threads.js";
import { threatRouter } from "./routes/threat.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";

export function createApp(): Express {
  const app = express();

  // We sit behind the Next.js BFF; trust its forwarded headers only.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    pinoHttp({
      logger,
      // /health is polled by the orchestrator; don't drown the log in it.
      autoLogging: { ignore: (req) => req.url === "/health" },
      serializers: {
        // The OAuth callback carries a one-time authorization code in its query
        // string, and pino-http would otherwise log the URL verbatim (rule 3).
        req: (req: { id?: unknown; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
        }),
      },
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.use(healthRouter);
  // Browser-facing (authenticated by signed OAuth state) before BFF-facing
  // (authenticated by the internal JWT).
  app.use(oauthRouter);
  // Provider push. Authenticated by a Google-signed OIDC token, not the internal JWT
  // (routes/webhooks.ts), so it is mounted with the other externally-called route.
  app.use(webhooksRouter);
  app.use(mailAccountsRouter);
  app.use(threadsRouter);
  app.use(replyRouter);
  app.use(threatRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
