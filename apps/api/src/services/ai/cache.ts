import { createHash } from "node:crypto";
import { dbForUser } from "@inbox-copilot/db";
import { logger } from "../../lib/logger.js";

/**
 * The content-hash cache (§5, rule 7).
 *
 * A cache miss must be the only reason this application spends a token. Both
 * lookups here are keyed on a `contentHash` — sha256 of the normalized body —
 * so identical content is never sent twice, whether it arrives as a resync of the
 * same message or as the same newsletter in a second mailbox.
 *
 * Why the hash and not the row's existence: a message can be re-fetched with a
 * corrected body, and a thread's summary goes stale the moment a reply lands. The
 * hash changing is precisely the signal that the old answer no longer describes
 * the content.
 */

export interface CachedClassification {
  id: string;
  category: string;
  priority: string;
  priorityScore: number;
  needsReply: boolean;
  language: string;
  model: string;
  contentHash: string;
}

/**
 * Looks for an existing classification of this exact content.
 *
 * Keyed by message *and* hash: `AiClassification.messageId` is unique, so a row
 * whose hash no longer matches is a stale answer to a changed body, and is
 * reported as a miss (the row is then overwritten, not duplicated).
 */
export async function cachedClassification(
  userId: string,
  messageId: string,
  contentHash: string,
): Promise<CachedClassification | null> {
  const row = await dbForUser(userId).aiClassification.findFirst({
    where: { messageId, contentHash },
    select: {
      id: true,
      category: true,
      priority: true,
      priorityScore: true,
      needsReply: true,
      language: true,
      model: true,
      contentHash: true,
    },
  });

  if (row) {
    logger.debug({ userId, messageId, contentHash }, "ai classification cache hit");
  }
  return row as CachedClassification | null;
}

export interface CachedSummary {
  id: string;
  headline: string;
  summary: string;
  keyPoints: unknown;
  actionItems: unknown;
  model: string;
}

/** Looks for a summary of this thread at this exact content hash. */
export async function cachedSummary(
  userId: string,
  threadId: string,
  contentHash: string,
): Promise<CachedSummary | null> {
  const row = await dbForUser(userId).aiSummary.findFirst({
    where: { threadId, contentHash },
    select: {
      id: true,
      headline: true,
      summary: true,
      keyPoints: true,
      actionItems: true,
      model: true,
    },
  });

  if (row) {
    logger.debug({ userId, threadId, contentHash }, "ai summary cache hit");
  }
  return row as CachedSummary | null;
}

/**
 * The cache key for a thread summary: the ordered message hashes, hashed.
 *
 * Built from the per-message `contentHash` values rather than by re-normalizing the
 * concatenated bodies, so it agrees with the sync engine's hashing by construction
 * and costs nothing to compute. Order is part of the key: the same two messages in
 * the other order is a different thread state.
 */
export function threadContentHash(messageHashes: readonly string[]): string {
  const hash = createHash("sha256");
  for (const messageHash of messageHashes) {
    hash.update(messageHash);
    hash.update("\n");
  }
  return hash.digest("hex");
}
