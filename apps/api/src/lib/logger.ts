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

/**
 * Query parameters that must never be logged. An OAuth authorization code is a
 * one-time credential and `state` is a CSRF token — both arrive in the URL of
 * the callback, and pino-http logs request URLs by default.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  "code",
  "state",
  "access_token",
  "refresh_token",
  "id_token",
  "session_state",
  "token",
]);

/** Replaces sensitive query values with a marker, keeping the shape readable. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;

  const separator = url.indexOf("?");
  if (separator === -1) return url;

  const path = url.slice(0, separator);
  const params = new URLSearchParams(url.slice(separator + 1));
  for (const key of params.keys()) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, "[redacted]");
    }
  }

  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}
