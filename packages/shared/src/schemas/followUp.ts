import { z } from "zod";
import { cuidSchema } from "./common.js";
import { reminderStatusSchema } from "./enums.js";

/**
 * Follow-up reminder contracts (ARCHITECTURE §9).
 *
 * A reminder is a statement about a message the user sent and has not heard back
 * about. Note what the shape does *not* contain: any way for a caller to create one.
 * Reminders are created by the send path when the user ticked "remind me", and
 * resolved by the `followup.check` job when a reply arrives — there is no
 * `POST /follow-ups`, because a reminder about a message we have no record of sending
 * would be a reminder we cannot ever resolve.
 */

export const followUpReminderSchema = z.object({
  id: cuidSchema,
  threadId: cuidSchema,
  /** The thread's subject, so the list reads as mail rather than as ids. */
  subject: z.string().nullable(),
  /** Who the watched message went to, for the same reason. */
  recipients: z.array(z.string()),
  dueAt: z.iso.datetime(),
  snoozedUntil: z.iso.datetime().nullable(),
  status: reminderStatusSchema,
  /** Why we are waiting — free text set at creation, e.g. the subject at send time. */
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type FollowUpReminderDto = z.infer<typeof followUpReminderSchema>;

export const followUpListSchema = z.object({
  items: z.array(followUpReminderSchema),
});
export type FollowUpListDto = z.infer<typeof followUpListSchema>;

export const followUpIdParamsSchema = z.object({ reminderId: cuidSchema });

/**
 * Snoozing. Days rather than a timestamp: this is "not yet, ask me later", and
 * letting the caller post an arbitrary instant invites a reminder that arrives in
 * 2031 by typo.
 */
export const snoozeFollowUpBodySchema = z.object({
  days: z.number().int().min(1).max(30).default(3),
});
export type SnoozeFollowUpBody = z.infer<typeof snoozeFollowUpBodySchema>;
