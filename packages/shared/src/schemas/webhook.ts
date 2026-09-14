import { z } from "zod";

/**
 * Inbound push payloads (ARCHITECTURE §4).
 *
 * These are the only schemas here that describe something *somebody else* sends us,
 * and they are written to be as narrow as the trust we place in them: a push is a
 * **trigger**, not data. Nothing parsed here is ever written to a row or used as a
 * sync cursor — the mailbox is re-read from the provider over an authenticated
 * connection, and that read is the source of truth.
 *
 * So the shapes are deliberately loose about everything except "which mailbox is
 * this about", and `passthrough` is deliberately absent: unknown fields are dropped
 * rather than carried around where something might later read one.
 */

/**
 * The Pub/Sub push envelope.
 *
 * `message.data` is base64 (standard, not url-safe) and its contents are the
 * publisher's, so it is validated separately — see `gmailNotificationSchema`.
 */
export const pubsubPushEnvelopeSchema = z.object({
  message: z.object({
    /** Base64. Absent on a rare keep-alive with no payload. */
    data: z.string().optional(),
    /** Pub/Sub's own id, unique per message. Useful only for logging. */
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  /** `projects/<project>/subscriptions/<name>`, as Pub/Sub reports it. */
  subscription: z.string().optional(),
});
export type PubsubPushEnvelope = z.infer<typeof pubsubPushEnvelopeSchema>;

/**
 * What Gmail publishes inside that envelope.
 *
 * `historyId` is parsed so it can be *logged*, and for nothing else. The delta sync
 * starts from the cursor in our own database: trusting this number would let whoever
 * can publish to the topic decide how far back we read — or, with a high value,
 * silently skip history we never fetched.
 */
export const gmailNotificationSchema = z.object({
  emailAddress: z.string().min(3),
  historyId: z.union([z.string(), z.number()]).optional(),
});
export type GmailNotification = z.infer<typeof gmailNotificationSchema>;
