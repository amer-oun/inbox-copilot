import { z } from "zod";
import { cuidSchema, languageSchema, pageOf, paginationSchema } from "./common.js";
import { aiActionItemSchema } from "./ai.js";
import { categorySchema, prioritySchema, threatLevelSchema } from "./enums.js";

/**
 * Read contracts for the inbox (ARCHITECTURE §1: the browser sees these shapes,
 * never the DB rows).
 *
 * Two rules shape everything here:
 *   1. No raw email HTML crosses the wire. `bodyHtml` is sanitized in the API
 *      (`services/security/sanitize.ts`) and the field is named to say so, because
 *      a field called `bodyHtml` is a field somebody will eventually render with
 *      `dangerouslySetInnerHTML`.
 *   2. Nothing token-shaped, ever (rule 3).
 */

/** An address as the UI shows it. */
export const addressSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
});
export type AddressDto = z.infer<typeof addressSchema>;

/** "ALL" is a UI tab, not a category — it means "do not filter". */
export const threadCategoryFilterSchema = z.union([z.literal("ALL"), categorySchema]);
export type ThreadCategoryFilter = z.infer<typeof threadCategoryFilterSchema>;

export const threadListQuerySchema = paginationSchema.extend({
  category: threadCategoryFilterSchema.default("ALL"),
});
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

/**
 * One row of the thread list.
 *
 * Deliberately not the whole thread: a list of 25 rows must not carry 25 message
 * bodies. The AI headline is included because it is the row's most useful line
 * when it exists, and it costs one join.
 */
export const threadListItemSchema = z.object({
  id: cuidSchema,
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  /** Who the row is "from": the sender of the newest inbound message. */
  from: addressSchema.nullable(),
  messageCount: z.number().int().positive(),
  lastMessageAt: z.iso.datetime(),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  hasAttachments: z.boolean(),
  category: categorySchema.nullable(),
  priority: prioritySchema.nullable(),
  priorityScore: z.number().int().min(0).max(100).nullable(),
  needsReply: z.boolean(),
  language: languageSchema.nullable(),
  threatLevel: threatLevelSchema,
  /** The AI summary's headline, when this thread has one. */
  summaryHeadline: z.string().nullable(),
});
export type ThreadListItemDto = z.infer<typeof threadListItemSchema>;

export const threadListSchema = pageOf(threadListItemSchema);
export type ThreadListDto = z.infer<typeof threadListSchema>;

export const threadSummarySchema = z.object({
  headline: z.string(),
  summary: z.string(),
  keyPoints: z.array(z.string()),
  actionItems: z.array(aiActionItemSchema),
  model: z.string(),
  createdAt: z.iso.datetime(),
});
export type ThreadSummaryDto = z.infer<typeof threadSummarySchema>;

export const attachmentSchema = z.object({
  id: cuidSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  isInline: z.boolean(),
  /** Deterministic risk tag from the sync engine: "executable" | "macro" | … */
  riskFlag: z.string().nullable(),
});
export type AttachmentDto = z.infer<typeof attachmentSchema>;

export const messageSchema = z.object({
  id: cuidSchema,
  from: addressSchema,
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string().nullable(),
  sentAt: z.iso.datetime(),
  isRead: z.boolean(),
  isOutbound: z.boolean(),
  bodyText: z.string().nullable(),
  /**
   * Sanitized HTML — DOMPurify-cleaned server-side, with remote image sources
   * moved to `data-blocked-src` so nothing loads until the reader asks.
   * Still rendered inside a sandboxed iframe: this is the second layer, not the
   * only one.
   */
  bodyHtmlSanitized: z.string().nullable(),
  /** How many remote images were defused; drives the click-to-load control. */
  blockedRemoteImages: z.number().int().nonnegative(),
  attachments: z.array(attachmentSchema),
});
export type MessageDto = z.infer<typeof messageSchema>;

export const threadDetailSchema = z.object({
  id: cuidSchema,
  subject: z.string().nullable(),
  participants: z.array(addressSchema),
  messageCount: z.number().int().positive(),
  firstMessageAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
  isRead: z.boolean(),
  isStarred: z.boolean(),
  category: categorySchema.nullable(),
  priority: prioritySchema.nullable(),
  priorityScore: z.number().int().min(0).max(100).nullable(),
  needsReply: z.boolean(),
  language: languageSchema.nullable(),
  threatLevel: threatLevelSchema,
  /**
   * Who a reply would be addressed to, computed by the API from the newest message's
   * headers — the same function the send path uses (`services/send.ts`). It is on the
   * read contract so the composer can show the recipient before the user sends, rather
   * than the UI guessing at it and being wrong about a Reply-To.
   *
   * Empty when there is nobody to reply to (a thread of the user's own mail to
   * themselves), which is how the UI knows not to offer a composer.
   */
  replyRecipients: z.array(addressSchema),
  /** Null when the thread was below the summarization threshold (§5). */
  summary: threadSummarySchema.nullable(),
  /** Oldest first — the order a person reads a conversation in. */
  messages: z.array(messageSchema),
});
export type ThreadDetailDto = z.infer<typeof threadDetailSchema>;

export const threadIdParamsSchema = z.object({ threadId: cuidSchema });
