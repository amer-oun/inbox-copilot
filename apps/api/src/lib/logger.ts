import pino from "pino";
import { env } from "./env.js";

/**
 * Structured logging. Every request-scoped log line must carry `userId` and
 * `mailAccountId` — use `logger.child({ userId, mailAccountId })`.
 *
 * The redact list is a backstop, not a licence: OAuth tokens must never reach
 * a log call in the first place (rule 3).
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.accessToken",
      "*.refreshToken",
      "*.accessTokenEnc",
      "*.refreshTokenEnc",
      "*.access_token",
      "*.refresh_token",
      "*.id_token",
    ],
    censor: "[redacted]",
  },
  ...(env.NODE_ENV === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});

export type Logger = typeof logger;
