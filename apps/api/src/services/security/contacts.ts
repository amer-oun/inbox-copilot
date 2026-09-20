import { dbForUser, prisma } from "@inbox-copilot/db";
import { logger } from "../../lib/logger.js";
import { registrableDomain } from "./urls.js";

/**
 * The domains a user actually corresponds with (§6, layer 2).
 *
 * A lookalike check needs something to be a lookalike *of*, and a global brand list
 * is the wrong reference set: `paypa1.com` matters to everyone, but
 * `northwind-logistics.example` only matters to the twelve people who invoice them,
 * and they are exactly the people a targeted attack is aimed at. So the reference set
 * is derived per user from their own mail.
 *
 * Two kinds of evidence, ordered by how much they mean:
 *
 *   1. **Domains they have sent mail to.** The strongest signal available: the user
 *      typed or chose that address themselves.
 *   2. **Domains that write to them repeatedly.** A single inbound message proves
 *      nothing — the phishing mail itself would qualify — so this needs a threshold.
 *
 * Their own mailbox domain is included, because "someone imitating your own company"
 * is a standard opening move.
 */

/** Inbound messages from a domain before it counts as a correspondent. */
export const INBOUND_FAMILIARITY_THRESHOLD = 3;

/**
 * Ceiling on the set. A very old mailbox has thousands of domains, and each one is
 * compared against every candidate — the check is O(set size) per message. The most
 * frequent domains are the ones worth imitating, so the cut is by frequency.
 */
export const MAX_KNOWN_DOMAINS = 500;

/**
 * How long a computed set is reused.
 *
 * The query aggregates the whole mailbox, and enrichment runs per message, so
 * recomputing it for each of a thousand backfilled messages would be a thousand full
 * scans to learn the same answer. Fifteen minutes is well inside "the set of people
 * you email does not change" and well outside a burst of enrichment.
 */
export const KNOWN_DOMAINS_TTL_MS = 15 * 60_000;

interface CacheEntry {
  domains: Set<string>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test hook, and the thing to call after a backfill if freshness ever matters. */
export function resetKnownDomains(userId?: string): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

export interface DomainRow {
  domain: string | null;
  n: number;
  outbound: boolean;
}

/**
 * Aggregates the mailbox's domains in one query.
 *
 * Raw SQL, for the same reason `services/ai/compose.ts` needs it: recipients are
 * stored as formatted `"Name <addr>"` strings in a text array, and "the domain part of
 * each element of `to || cc`" is not a predicate Prisma can express. The tenancy join
 * is therefore written out by hand — `a."userId" = ${userId}` below is rule 4, and it
 * is the one line in this file that must never be edited without thinking.
 *
 * `substring(addr from '[^@]+$')` takes everything after the *last* `@`, because a
 * display name may contain one.
 */
async function queryDomains(userId: string): Promise<DomainRow[]> {
  return prisma.$queryRaw<DomainRow[]>`
    WITH sent AS (
      SELECT lower(regexp_replace(substring(addr from '[^@]+$'), '[>\\s,;].*$', '')) AS domain
      FROM "Message" m
      JOIN "MailAccount" a ON a.id = m."mailAccountId"
      CROSS JOIN LATERAL unnest(m."to" || m."cc") AS addr
      WHERE a."userId" = ${userId}
        AND m."isOutbound" = true
    ),
    received AS (
      SELECT lower(regexp_replace(substring(m."fromEmail" from '[^@]+$'), '[>\\s,;].*$', '')) AS domain
      FROM "Message" m
      JOIN "MailAccount" a ON a.id = m."mailAccountId"
      WHERE a."userId" = ${userId}
        AND m."isOutbound" = false
    ),
    mine AS (
      SELECT lower(regexp_replace(substring(a."emailAddress" from '[^@]+$'), '[>\\s,;].*$', '')) AS domain
      FROM "MailAccount" a
      WHERE a."userId" = ${userId}
    )
    SELECT domain, count(*)::int AS n, true AS outbound FROM sent  WHERE domain <> '' GROUP BY domain
    UNION ALL
    SELECT domain, count(*)::int AS n, true AS outbound FROM mine  WHERE domain <> '' GROUP BY domain
    UNION ALL
    SELECT domain, count(*)::int AS n, false AS outbound FROM received WHERE domain <> '' GROUP BY domain
  `;
}

/**
 * Folds the rows into a set of registrable domains.
 *
 * Exported for the tests, and because the decision it encodes is the interesting part
 * of this file: an outbound domain is admitted on one message, an inbound one needs
 * `INBOUND_FAMILIARITY_THRESHOLD`.
 */
export function foldDomains(rows: readonly DomainRow[]): Set<string> {
  const counts = new Map<string, { outbound: number; inbound: number }>();

  for (const row of rows) {
    const domain = registrableDomain(row.domain);
    if (domain === null) continue;
    const entry = counts.get(domain) ?? { outbound: 0, inbound: 0 };
    if (row.outbound) entry.outbound += row.n;
    else entry.inbound += row.n;
    counts.set(domain, entry);
  }

  const admitted = [...counts.entries()]
    .filter(
      ([, entry]) => entry.outbound > 0 || entry.inbound >= INBOUND_FAMILIARITY_THRESHOLD,
    )
    // Outbound weighs more than inbound when the ceiling has to cut somewhere.
    .sort((a, b) => b[1].outbound * 3 + b[1].inbound - (a[1].outbound * 3 + a[1].inbound))
    .slice(0, MAX_KNOWN_DOMAINS)
    .map(([domain]) => domain);

  return new Set(admitted);
}

/**
 * The user's known domains, from cache when it is warm.
 *
 * A query failure returns an empty set rather than throwing: with no reference set the
 * lookalike rules simply do not fire, which loses a signal. Failing the enrichment
 * instead would lose every other signal too, including the header truth that needs no
 * database at all.
 */
export async function knownDomainsFor(userId: string): Promise<ReadonlySet<string>> {
  const cached = cache.get(userId);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.domains;

  try {
    const domains = foldDomains(await queryDomains(userId));
    cache.set(userId, { domains, expiresAt: Date.now() + KNOWN_DOMAINS_TTL_MS });
    logger.debug(
      { userId, knownDomains: domains.size },
      "known correspondent domains built",
    );
    return domains;
  } catch (error) {
    logger.error({ err: error, userId }, "could not derive known correspondent domains");
    return new Set<string>();
  }
}

/**
 * How many messages this mailbox has already had from an address, not counting this
 * one or anything newer.
 *
 * Bounded by `sentAt` rather than "all messages from this address" so a backfill
 * enriched out of order gives the same answer as the message arriving live: a sender's
 * first message must not stop looking like a first message because the second one has
 * since been stored.
 */
export async function messagesSeenFrom(input: {
  userId: string;
  mailAccountId: string;
  fromEmail: string;
  before: Date;
}): Promise<number> {
  return dbForUser(input.userId).message.count({
    where: {
      mailAccountId: input.mailAccountId,
      fromEmail: input.fromEmail.toLowerCase(),
      isOutbound: false,
      sentAt: { lt: input.before },
    },
  });
}
