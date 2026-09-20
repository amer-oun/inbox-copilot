import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reference set the lookalike rules measure against (§6).
 *
 * What is worth testing here is the admission policy, because it is the difference
 * between a useful check and a self-defeating one: if a single inbound message made a
 * domain "known", the phishing mail under examination would vouch for itself.
 */

const queryRaw = vi.hoisted(() => vi.fn());
const messageCount = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({ message: { count: messageCount } }),
  prisma: { $queryRaw: queryRaw },
  Prisma: {},
}));

const {
  foldDomains,
  INBOUND_FAMILIARITY_THRESHOLD,
  knownDomainsFor,
  messagesSeenFrom,
  resetKnownDomains,
} = await import("./contacts.js");

beforeEach(() => {
  resetKnownDomains();
  queryRaw.mockReset().mockResolvedValue([]);
  messageCount.mockReset().mockResolvedValue(0);
});

describe("foldDomains", () => {
  it("admits a domain the user has written to, on one message", () => {
    // The strongest evidence available: they chose that address themselves.
    const domains = foldDomains([{ domain: "northwind.example", n: 1, outbound: true }]);
    expect([...domains]).toEqual(["northwind.example"]);
  });

  it("does not admit a domain on a single inbound message", () => {
    /*
     * The rule that keeps the check from vouching for its own suspect: one message from
     * a stranger must not make the stranger familiar, or a lookalike domain would become
     * "known" the moment it wrote to you.
     */
    expect([...foldDomains([{ domain: "evil.test", n: 1, outbound: false }])]).toEqual(
      [],
    );
  });

  it("admits an inbound domain once it has written repeatedly", () => {
    const domains = foldDomains([
      { domain: "newsletter.test", n: INBOUND_FAMILIARITY_THRESHOLD, outbound: false },
    ]);
    expect([...domains]).toEqual(["newsletter.test"]);
  });

  it("reduces subdomains to the party that owns them", () => {
    const domains = foldDomains([
      { domain: "mail.northwind.example", n: 2, outbound: true },
      { domain: "billing.northwind.example", n: 1, outbound: true },
    ]);
    expect([...domains]).toEqual(["northwind.example"]);
  });

  it("ignores rows it cannot read as a domain", () => {
    expect([
      ...foldDomains([
        { domain: null, n: 4, outbound: true },
        { domain: "", n: 4, outbound: true },
      ]),
    ]).toEqual([]);
  });

  it("combines inbound and outbound counts for the same party", () => {
    const domains = foldDomains([
      { domain: "shop.example", n: 1, outbound: false },
      { domain: "shop.example", n: 1, outbound: true },
    ]);
    expect([...domains]).toEqual(["shop.example"]);
  });
});

describe("knownDomainsFor", () => {
  it("queries once and then serves from cache", async () => {
    /*
     * Enrichment runs per message, and this query aggregates the whole mailbox: without
     * the cache a thousand backfilled messages would mean a thousand full scans to learn
     * the same answer.
     */
    queryRaw.mockResolvedValue([{ domain: "shop.example", n: 3, outbound: true }]);

    const first = await knownDomainsFor("user_1");
    const second = await knownDomainsFor("user_1");

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("caches per user", async () => {
    await knownDomainsFor("user_1");
    await knownDomainsFor("user_2");
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("returns an empty set rather than failing the assessment", async () => {
    /*
     * With no reference set the lookalike rules do not fire, which loses one signal.
     * Throwing would lose every other signal too — including the header truth that needs
     * no database at all.
     */
    queryRaw.mockRejectedValue(new Error("connection reset"));

    expect([...(await knownDomainsFor("user_1"))]).toEqual([]);
  });

  it("scopes the query to the user", async () => {
    await knownDomainsFor("user_42");

    // Raw SQL bypasses the tenancy extension, so the ownership predicate is a parameter
    // of this query and nothing else. Rule 4 lives in that argument.
    expect(queryRaw.mock.calls[0]?.slice(1)).toContain("user_42");
  });
});

describe("messagesSeenFrom", () => {
  it("counts only earlier inbound mail from that address", async () => {
    const before = new Date("2026-09-14T09:00:00Z");
    await messagesSeenFrom({
      userId: "user_1",
      mailAccountId: "mail_1",
      fromEmail: "Dana@Northwind.Example",
      before,
    });

    expect(messageCount).toHaveBeenCalledWith({
      where: {
        mailAccountId: "mail_1",
        // Lower-cased, because the stored column is and an address is case-insensitive.
        fromEmail: "dana@northwind.example",
        isOutbound: false,
        // Bounded by time, so a backfill enriched out of order gives the same answer as
        // the message arriving live.
        sentAt: { lt: before },
      },
    });
  });
});
