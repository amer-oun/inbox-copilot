import { describe, expect, it } from "vitest";
import {
  cuidSchema,
  DEMO_MAIL_ACCOUNT_ID,
  DEMO_SAMPLE_MODEL,
  DEMO_USER_EMAIL,
  DEMO_USER_ID,
  replyToneSchema,
} from "@inbox-copilot/shared";
import { buildDemoRows, DEMO_DAILY_AI_CALL_CAP } from "./seed.js";
import { DEMO_REMINDERS, DEMO_SCHEDULED, DEMO_THREADS, SAM } from "./fixtures.js";

/**
 * The demo mailbox as rows. `buildDemoRows` is pure, so this is the whole seed checked
 * without a database: shape, ids, the verdicts the real rules reach, and the promise
 * that nothing in it is anybody's real address.
 */

const NOW = new Date("2026-09-22T09:30:00Z");
const rows = buildDemoRows(NOW);

describe("the mailbox", () => {
  it("has the 20–30 threads the brief asks for, and every message in them", () => {
    expect(rows.threads.length).toBeGreaterThanOrEqual(20);
    expect(rows.threads.length).toBeLessThanOrEqual(30);
    expect(rows.messages).toHaveLength(
      DEMO_THREADS.reduce((sum, thread) => sum + thread.messages.length, 0),
    );
  });

  it("covers the mix a real inbox has", () => {
    const categories = new Set(rows.threads.map((thread) => thread.category));
    for (const category of ["WORK", "PERSONAL", "NEWSLETTER", "PROMOTION"]) {
      expect(categories).toContain(category);
    }
    expect(rows.threads.filter((thread) => thread.priority === "URGENT")).toHaveLength(1);
  });

  it("uses CUID-shaped ids everywhere, because the routes validate them", () => {
    const ids = [
      ...rows.threads,
      ...rows.messages,
      ...rows.attachments,
      ...rows.classifications,
      ...rows.summaries,
      ...rows.translations,
      ...rows.scheduled,
      ...rows.reminders,
    ].map((row) => row.id);

    for (const id of ids) expect(cuidSchema.safeParse(id).success, id).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("belongs to the demo user and a mailbox with no grant behind it", () => {
    expect(rows.user.id).toBe(DEMO_USER_ID);
    expect(rows.user.email).toBe(DEMO_USER_EMAIL);
    expect(rows.mailAccount).toMatchObject({
      id: DEMO_MAIL_ACCOUNT_ID,
      userId: DEMO_USER_ID,
      scopes: [],
      // Keeps the watch keeper and the AI sweep away (see seed.ts).
      syncStatus: "PAUSED",
    });
    expect(rows.mailAccount).not.toHaveProperty("accessTokenEnc");
    expect(rows.mailAccount).not.toHaveProperty("refreshTokenEnc");
  });

  it("never emails the demo user, and caps its live AI calls", () => {
    expect(rows.settings.followUpDigest).toBe(false);
    expect(rows.settings.dailyAiCallCap).toBe(DEMO_DAILY_AI_CALL_CAP);
  });

  it("is the same mailbox every time for the same moment", () => {
    expect(buildDemoRows(NOW)).toEqual(rows);
  });
});

describe("invented data only", () => {
  /**
   * Every address is on a reserved domain, or on one of the invented domains the README
   * screenshots already use. A new correspondent on any other domain fails here, so
   * adding one is a decision rather than an accident.
   */
  const INVENTED_DOMAINS = new Set([
    "northwind-freight.com",
    "brightpath-logistics.com",
    "rnicrosoft-verify.com",
    "meridian-legal.co.uk",
    "larkspur-invoicing.com",
    "fastmail-demo.net",
    "meridian-crossings.com",
    "theloadingdock-news.com",
    "harbourline-customs.co.uk",
    "transports-laurent.fr",
    "correo-demo.es",
  ]);

  function allowed(address: string): boolean {
    const domain = address.slice(address.lastIndexOf("@") + 1).replace(/>$/, "");
    return (
      domain.endsWith(".example") ||
      domain.endsWith(".invalid") ||
      INVENTED_DOMAINS.has(domain)
    );
  }

  it("has no address outside the invented set", () => {
    const addresses = [
      rows.user.email,
      rows.mailAccount.emailAddress,
      ...rows.messages.flatMap((message) => [
        message.fromEmail,
        ...(message.to as string[]),
        ...(message.cc as string[]),
      ]),
      ...rows.scheduled.flatMap((item) => item.to as string[]),
    ];
    for (const address of addresses) expect(allowed(address), address).toBe(true);
  });
});

describe("AI results", () => {
  const inbound = rows.messages.filter((message) => message.isOutbound !== true);
  const outbound = rows.messages.filter((message) => message.isOutbound === true);

  it("are stored for every inbound message and no outbound one, as the pipeline would", () => {
    const classified = new Set(rows.classifications.map((row) => row.messageId));
    for (const message of inbound)
      expect(classified.has(message.id as string)).toBe(true);
    for (const message of outbound)
      expect(classified.has(message.id as string)).toBe(false);
  });

  it("say they were written in advance rather than naming a model", () => {
    for (const row of rows.classifications) {
      expect(row.model).toBe(DEMO_SAMPLE_MODEL);
      expect(row.threatModel).toBe(DEMO_SAMPLE_MODEL);
    }
    for (const row of [...rows.summaries, ...rows.translations]) {
      expect(row.model).toBe(DEMO_SAMPLE_MODEL);
    }
  });

  it("include exactly one phishing thread, flagged by the real rules", () => {
    const phishing = rows.threads.filter((thread) => thread.threatLevel === "PHISHING");
    expect(phishing).toHaveLength(1);

    const verdict = rows.classifications.find((row) => row.threatLevel === "PHISHING");
    const reasons = verdict?.threatReasons as string[];
    // Rule text, not fixture text: these sentences are written by services/security.
    expect(reasons.some((reason) => reason.startsWith("DMARC failed"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("account.microsoft.com"))).toBe(true);
    expect(verdict?.threatIntent).toBe("CREDENTIAL_HARVEST");
  });

  it("find nothing wrong with the rest of the mail", () => {
    const others = rows.classifications.filter((row) => row.threatLevel !== "PHISHING");
    for (const row of others) expect(row.threatLevel).toBe("SAFE");
  });

  it("have translations that the cache will serve, so translating costs nothing", () => {
    expect(rows.translations.length).toBeGreaterThanOrEqual(2);
    for (const translation of rows.translations) {
      const message = rows.messages.find((row) => row.id === translation.messageId);
      expect(translation.contentHash).toBe(message?.contentHash);
      expect(translation.targetLang).toBe("en");
    }
  });

  it("have pre-written drafts in threes, in real tones", () => {
    for (const thread of DEMO_THREADS) {
      for (const [tone, drafts] of Object.entries(thread.drafts ?? {})) {
        expect(replyToneSchema.safeParse(tone).success).toBe(true);
        expect(drafts).toHaveLength(3);
      }
    }
  });
});

describe("time", () => {
  it("puts every message and summary in the past, relative to the reset", () => {
    for (const message of rows.messages) {
      expect((message.sentAt as Date).getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
    for (const summary of rows.summaries) {
      expect((summary.createdAt as Date).getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
  });

  it("queues the scheduled sends in the future, at the wall-clock time chosen", () => {
    expect(rows.scheduled).toHaveLength(DEMO_SCHEDULED.length);
    for (const [index, item] of rows.scheduled.entries()) {
      expect((item.sendAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
      expect(item.localSendAt?.endsWith(`T${DEMO_SCHEDULED[index]?.at}`)).toBe(true);
      expect(item.status).toBe("SCHEDULED");
    }
  });

  it("makes every reminder due now, so the follow-ups page is not empty", () => {
    expect(rows.reminders).toHaveLength(DEMO_REMINDERS.length);
    for (const reminder of rows.reminders) {
      expect((reminder.dueAt as Date).getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
  });

  it("watches a message the demo user actually sent", () => {
    for (const reminder of rows.reminders) {
      const watched = rows.messages.find(
        (message) => message.providerMessageId === reminder.watchedMessageId,
      );
      expect(watched?.fromEmail).toBe(SAM.email);
    }
  });
});
