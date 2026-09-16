import { z } from "zod";
import { cuidSchema, emailSchema, timezoneSchema } from "./common.js";
import { scheduleStatusSchema } from "./enums.js";

/**
 * Scheduled send contracts (ARCHITECTURE §9).
 *
 * The request carries a **wall-clock time and an IANA zone**, not an instant and not
 * an offset. That is the whole timezone decision of this feature, expressed in the
 * type: `"2026-10-25T09:00"` plus `"Africa/Tunis"` still means nine in the morning
 * after a DST boundary moves, whereas `"2026-10-25T08:00Z"` means eight in the
 * morning for ever, and `"+01:00"` is a fact about one moment being passed off as a
 * rule.
 *
 * Rule 1 is intact here: this schedules the text in the request, which is text the
 * user had on screen. There is no field naming a draft to generate and send, and no
 * model runs on this path.
 */

/** `YYYY-MM-DDTHH:mm`, exactly what an `<input type="datetime-local">` produces. */
export const wallClockSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "expected YYYY-MM-DDTHH:mm with no timezone");

/**
 * Scheduling a reply into an existing thread.
 *
 * `threadId` rather than recipients: who a reply goes to is computed by the API from
 * the parent message's own headers (`services/send.ts`), exactly as it is for an
 * immediate send. A caller cannot name a recipient here, so neither can an email that
 * talked a model into suggesting one.
 */
export const scheduleReplyBodySchema = z.object({
  threadId: cuidSchema,
  /** The text the user submitted. Plain text. */
  body: z.string().min(1).max(100_000),
  sendAtLocal: wallClockSchema,
  timezone: timezoneSchema,
  /** Create a follow-up reminder once this actually goes out. */
  expectsReply: z.boolean().default(false),
  /** Feedback only, as on the immediate send path. Never read to decide what is sent. */
  draftId: cuidSchema.optional(),
});
export type ScheduleReplyBody = z.infer<typeof scheduleReplyBodySchema>;

/**
 * Scheduling a new message.
 *
 * Here the recipient *is* the caller's, because there is no thread to derive one from
 * — it is the address the user typed into the composer, same as `POST /compose`.
 */
export const scheduleNewBodySchema = z.object({
  mailAccountId: cuidSchema,
  to: z.array(emailSchema).min(1).max(20),
  cc: z.array(emailSchema).max(20).default([]),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(100_000),
  sendAtLocal: wallClockSchema,
  timezone: timezoneSchema,
});
export type ScheduleNewBody = z.infer<typeof scheduleNewBodySchema>;

/**
 * One pending or finished scheduled send, as the UI sees it.
 *
 * `lastError` is on the wire on purpose. A send whose outcome is unknown is not
 * retried (see `services/schedule.ts`), so the only way a user learns it did not go
 * is by being told — a silently FAILED row is worse than no scheduling feature.
 */
export const scheduledEmailSchema = z.object({
  id: cuidSchema,
  threadId: cuidSchema.nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  /** Plain text, as the user wrote it. Never the HTML that will be sent. */
  bodyText: z.string().nullable(),
  /** The resolved instant, for display and sorting. */
  sendAt: z.iso.datetime(),
  /** The wall time the user chose, so the UI can show what they actually picked. */
  sendAtLocal: z.string().nullable(),
  timezone: timezoneSchema,
  status: scheduleStatusSchema,
  expectsReply: z.boolean(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ScheduledEmailDto = z.infer<typeof scheduledEmailSchema>;

export const scheduledListSchema = z.object({
  items: z.array(scheduledEmailSchema),
});
export type ScheduledListDto = z.infer<typeof scheduledListSchema>;

export const scheduledIdParamsSchema = z.object({ scheduledId: cuidSchema });

export const scheduledListQuerySchema = z.object({
  /** Omitted means everything still pending. */
  status: scheduleStatusSchema.optional(),
});
export type ScheduledListQuery = z.infer<typeof scheduledListQuerySchema>;
