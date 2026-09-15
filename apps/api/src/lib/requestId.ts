import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * The per-request correlation id, used by the log and by the audit trail.
 *
 * One definition for both, deliberately. An audit row that records "request 41" while
 * the log calls the same request something else is an audit row you cannot follow
 * anywhere, and the whole reason `MailAccountEvent.requestId` exists is to lead back to
 * the log line for the request that deleted a mailbox.
 *
 * A UUID rather than pino-http's default counter: the counter restarts at 1 with the
 * process, so "request 41" names a different request after every deploy — which is
 * precisely the moment you are most likely to be reading an audit trail.
 */

/** Cap and character set for an id we accept from a caller. */
const MAX_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

/**
 * An inbound `x-request-id`, if it is one we are willing to repeat.
 *
 * The header is caller-supplied — our own BFF today, anything tomorrow — and this value
 * is written to a log line and to a database column. So it is validated rather than
 * trusted: no newlines (which would forge log lines), no control characters, bounded
 * length. Anything else is ignored in favour of our own id, which is always safe.
 */
export function sanitizeRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_LENGTH) return null;
  return SAFE_ID.test(trimmed) ? trimmed : null;
}

/**
 * Generates the id for one request. Wired into pino-http as `genReqId`, so `req.id` is
 * this value and every log line for the request already carries it.
 */
export function generateRequestId(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  return sanitizeRequestId(Array.isArray(header) ? header[0] : header) ?? randomUUID();
}

/**
 * The id for the request being handled, for code that wants to record it.
 *
 * Returns null rather than inventing one when there is no request — a worker job, a
 * script, a test — because "this did not come from a request" is a true and useful thing
 * for an audit row to say.
 */
export function requestIdOf(req: { id?: unknown } | undefined): string | null {
  if (req === undefined) return null;
  return sanitizeRequestId(typeof req.id === "number" ? String(req.id) : req.id);
}
