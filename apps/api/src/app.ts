import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import { healthRouter } from "./routes/health.js";
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
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.use(healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
