import { z } from "zod";

/**
 * Mirrors the enums in `packages/db/prisma/schema.prisma`.
 * Keep the two in sync — these are the wire-format contract between web and api.
 */

export const mailProviderTypeSchema = z.enum(["GMAIL", "OUTLOOK"]);
export type MailProviderType = z.infer<typeof mailProviderTypeSchema>;

export const syncStatusSchema = z.enum([
  "PENDING",
  "BACKFILLING",
  "ACTIVE",
  "PAUSED",
  "ERROR",
  "REVOKED",
]);
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const categorySchema = z.enum([
  "PRIMARY",
  "WORK",
  "PERSONAL",
  "FINANCE",
  "NEWSLETTER",
  "PROMOTION",
  "SOCIAL",
  "NOTIFICATION",
  "TRAVEL",
  "SPAM",
  "OTHER",
]);
export type Category = z.infer<typeof categorySchema>;

export const prioritySchema = z.enum(["URGENT", "HIGH", "NORMAL", "LOW"]);
export type Priority = z.infer<typeof prioritySchema>;

export const threatLevelSchema = z.enum([
  "UNKNOWN",
  "SAFE",
  "SUSPICIOUS",
  "PHISHING",
  "SPAM",
]);
export type ThreatLevel = z.infer<typeof threatLevelSchema>;

export const replyToneSchema = z.enum([
  "PROFESSIONAL",
  "FRIENDLY",
  "CONCISE",
  "FORMAL",
  "APOLOGETIC",
  "ENTHUSIASTIC",
]);
export type ReplyTone = z.infer<typeof replyToneSchema>;

export const scheduleStatusSchema = z.enum([
  "SCHEDULED",
  "SENDING",
  "SENT",
  "FAILED",
  "CANCELLED",
]);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const reminderStatusSchema = z.enum([
  "PENDING",
  "TRIGGERED",
  "RESOLVED",
  "SNOOZED",
  "DISMISSED",
]);
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;
