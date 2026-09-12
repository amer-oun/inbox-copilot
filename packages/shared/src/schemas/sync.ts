import { z } from "zod";
import { cuidSchema } from "./common.js";
import { syncStatusSchema } from "./enums.js";

/** Mailbox sync contracts (ARCHITECTURE §4). */

/** BullMQ job states, as reported to the UI. */
export const syncJobStateSchema = z.enum([
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "unknown",
]);
export type SyncJobState = z.infer<typeof syncJobStateSchema>;

export const syncJobSchema = z.object({
  state: syncJobStateSchema,
  /** Threads processed so far; absent until the worker reports one. */
  threadsProcessed: z.number().int().nonnegative().nullable(),
  attemptsMade: z.number().int().nonnegative(),
  /** Safe summary of the last failure — never a provider payload. */
  failedReason: z.string().nullable(),
});

export const syncStatusResponseSchema = z.object({
  mailAccountId: cuidSchema,
  syncStatus: syncStatusSchema,
  syncError: z.string().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  /** Oldest point the backfill has reached. */
  backfilledUntil: z.iso.datetime().nullable(),
  /** True once a delta cursor exists, i.e. incremental sync can take over. */
  hasCursor: z.boolean(),
  threadCount: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  /** Null when no backfill job is queued or recently finished. */
  job: syncJobSchema.nullable(),
});
export type SyncStatusResponse = z.infer<typeof syncStatusResponseSchema>;

export const startSyncResponseSchema = z.object({
  /** False when a backfill for this mailbox was already queued or running. */
  enqueued: z.boolean(),
  jobId: z.string().min(1),
  syncStatus: syncStatusSchema,
});
export type StartSyncResponse = z.infer<typeof startSyncResponseSchema>;
