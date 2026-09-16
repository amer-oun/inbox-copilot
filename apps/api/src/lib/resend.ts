import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Transactional mail from the application to its own user (§9).
 *
 * The scope of this module is the whole point of it, so it is stated in one line:
 * **nothing that belongs to the user's own correspondence goes through here.** The
 * user's mail is sent from the user's mailbox, by `MailProvider.sendMessage`, with the
 * user's own authentication. This path sends only mail whose author is the
 * application — today exactly one thing, the opt-in follow-up digest.
 *
 * A separate transport is not laziness, it is the correct shape. A digest sent through
 * the user's own Gmail would appear in their Sent folder as something they wrote; mail
 * from us must obviously be from us.
 *
 * Unconfigured is a supported state. Without `RESEND_API_KEY` this reports
 * `not-configured` and the digest simply does not go out — the reminders themselves
 * still work, still resolve, and are still visible in the UI, which is where they
 * actually belong. Nothing about follow-ups depends on an email provider.
 *
 * Implemented against the REST endpoint rather than the SDK: one POST, no dependency,
 * and the request is visible here rather than behind a client whose retry behaviour we
 * would then have to reason about. `lib/retry.ts` is deliberately *not* wrapped around
 * it — a digest is a nice-to-have and a retried digest is a duplicate email.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** A digest is not worth holding a socket open for. */
const TIMEOUT_MS = 10_000;

export interface AppEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface AppEmailResult {
  sent: boolean;
  /** Why not: "not-configured", or the upstream status. */
  reason?: string;
  id?: string;
}

/**
 * Sends one application email. Never throws.
 *
 * A failure here must not fail whatever was happening around it: the caller is a
 * scheduled job whose real work — resolving and triggering reminders — has already
 * been committed. So this reports rather than raises, and the log line is the record.
 */
export async function sendAppEmail(email: AppEmail): Promise<AppEmailResult> {
  if (env.RESEND_API_KEY === "" || env.DIGEST_FROM_ADDRESS === "") {
    logger.debug(
      { configured: false },
      "application email skipped: RESEND_API_KEY or DIGEST_FROM_ADDRESS is not set",
    );
    return { sent: false, reason: "not-configured" };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        // Never logged. The only place this value is read.
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.DIGEST_FROM_ADDRESS,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // The body may echo the request; log the status only.
      logger.warn({ status: response.status }, "application email was refused upstream");
      return { sent: false, reason: `http-${response.status}` };
    }

    const payload: unknown = await response.json().catch(() => null);
    const id =
      typeof payload === "object" && payload !== null && "id" in payload
        ? String((payload as { id: unknown }).id)
        : undefined;

    return { sent: true, ...(id === undefined ? {} : { id }) };
  } catch (error) {
    logger.warn({ err: error }, "application email could not be sent");
    return { sent: false, reason: "transport-error" };
  }
}
