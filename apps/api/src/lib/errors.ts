/**
 * Typed errors. Throw these anywhere; `middleware/error.ts` maps them to HTTP.
 * Never throw bare `Error` out of a route — the middleware will 500 it.
 */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  /** Safe to show the caller. Internal detail goes in the log, not here. */
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly code = "BAD_REQUEST";
}

export class ValidationError extends AppError {
  readonly statusCode = 422;
  readonly code = "VALIDATION_FAILED";
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = "UNAUTHORIZED";
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = "FORBIDDEN";
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = "CONFLICT";
}

export class RateLimitError extends AppError {
  readonly statusCode = 429;
  readonly code = "RATE_LIMITED";
}

export class UpstreamError extends AppError {
  readonly statusCode = 502;
  readonly code = "UPSTREAM_FAILED";
}

export class InternalError extends AppError {
  readonly statusCode = 500;
  readonly code = "INTERNAL_ERROR";
}

/**
 * A connected mailbox needs to be reconnected: the provider rejected our refresh
 * token (`invalid_grant`) because the user revoked access, changed their
 * password, or — on Microsoft — a concurrent refresh rotated it away.
 *
 * Retrying is pointless, so this is never retried: the mailbox is marked
 * REVOKED and the UI prompts the user to reconnect.
 */
export class MailAccountRevokedError extends AppError {
  readonly statusCode = 409;
  readonly code = "MAIL_ACCOUNT_REVOKED";
}

/** A provider OAuth endpoint failed in a way that may be transient. */
export class ProviderAuthError extends AppError {
  readonly statusCode = 502;
  readonly code = "PROVIDER_AUTH_FAILED";
}

/**
 * Internal signal for an `invalid_grant` response. Thrown by `providers/*`,
 * caught by the token manager, which turns it into MailAccountRevokedError after
 * marking the row. It should never reach the error middleware.
 */
export class InvalidGrantError extends AppError {
  readonly statusCode = 409;
  readonly code = "INVALID_GRANT";
}

/**
 * The user's daily AI call cap is spent (`UserSettings.dailyAiCallCap`).
 *
 * Not retryable within the window, so the enrich worker records it and stops rather
 * than burning attempts: the cap exists to bound spend, and a retry loop against it
 * would be a loop that never succeeds.
 */
export class AiCapExceededError extends AppError {
  readonly statusCode = 429;
  readonly code = "AI_CAP_EXCEEDED";
}

/** The user turned AI features off (`UserSettings.aiEnabled`). */
export class AiDisabledError extends AppError {
  readonly statusCode = 409;
  readonly code = "AI_DISABLED";
}

/**
 * The provider no longer has the history we asked for.
 *
 * Gmail keeps roughly a week of `history.list` records and answers 404 for a
 * `startHistoryId` older than that — which happens after a watch lapses, a long
 * outage, or a paused mailbox. There is no incremental recovery from it: the only
 * honest response is a full re-sync, so this is a distinct type rather than a
 * generic upstream failure, and the delta worker keys its fallback on it.
 */
export class SyncCursorExpiredError extends AppError {
  readonly statusCode = 409;
  readonly code = "SYNC_CURSOR_EXPIRED";
}

/** Push notifications are not configured for this deployment (no Pub/Sub topic). */
export class PushNotConfiguredError extends AppError {
  readonly statusCode = 409;
  readonly code = "PUSH_NOT_CONFIGURED";
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
