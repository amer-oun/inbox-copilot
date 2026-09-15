import { createHash } from "node:crypto";
import { dbForUser, type Prisma } from "@inbox-copilot/db";
import {
  aiThreatAssessmentSchema,
  ruleSignalsSchema,
  threatIntentSchema,
  type AiThreatAssessmentOutput,
  type HeaderSignals,
  type RiskyAttachment,
  type RuleSignals,
  type SenderSignals,
  type ThreatIntent,
  type ThreatLevel,
  type UrlSignals,
} from "@inbox-copilot/shared";
import { AiCapExceededError, AiDisabledError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { callStructured } from "../ai/client.js";
import { promptBody } from "../ai/content.js";
import { threatSignalsBlock, untrustedEmailBlock } from "../ai/prompts.js";
import type { AiSettings } from "../ai/usage.js";
import { knownDomainsFor, messagesSeenFrom } from "./contacts.js";
import { dmarcVouchesFor, headerSignals } from "./headers.js";
import { lookalikeOf, isPunycodeHost, registrableDomain, urlSignals } from "./urls.js";

/**
 * Layered phishing and spam detection (§6).
 *
 * The layering is the design, not an implementation detail:
 *
 *   1. `headers.ts` reads what the receiving server recorded — SPF, DKIM, DMARC,
 *      display-name and envelope alignment. Free, and unlobbyable.
 *   2. `urls.ts` and `contacts.ts` add heuristics over the links and the sender,
 *      measured against the domains this user actually corresponds with.
 *   3. The model reads the body *plus the findings of 1 and 2*, and answers the one
 *      question they cannot: what was the sender trying to do, and how do we say that
 *      to the person who received it.
 *
 * And then the verdict is a **union**: `unionVerdict` takes whichever of the rules'
 * floor and the model's level is more severe. A DMARC fail stays suspicious however
 * fluent the prose, which is the whole reason for doing the cheap layers first. §6 is
 * blunt about why: hand this to the model alone and a well-written email will talk it
 * round.
 *
 * Nothing here is a spam filter. The mailbox provider already ran one, and this is not
 * an attempt to beat it — it is an attempt to explain to a user why a message that
 * reached their inbox should not be trusted.
 */

/**
 * Severity ordering, for the union.
 *
 * SPAM sits below SUSPICIOUS deliberately: unsolicited bulk mail is a nuisance, and a
 * message with a failed DMARC is a danger. So a model that reads a forged mail as
 * "spam" cannot pull it down out of the suspicious band.
 */
const SEVERITY: Readonly<Record<ThreatLevel, number>> = {
  UNKNOWN: 0,
  SAFE: 1,
  SPAM: 2,
  SUSPICIOUS: 3,
  PHISHING: 4,
};

/** The more severe of two levels. The only way a level is ever combined. */
export function moreSevere(a: ThreatLevel, b: ThreatLevel): ThreatLevel {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * The rule table.
 *
 * Two independent dials per rule, and the difference between them is the most
 * important thing in this file:
 *
 *   - `weight` adds to a score. Scores accumulate, so several weak signals can add up
 *     to a verdict no single one of them justifies.
 *   - `floor` is a level this rule *requires* on its own. Only rules with no innocent
 *     explanation get one. A first-time sender has an innocent explanation — everyone
 *     you know was once a first-time sender — so it has a weight of 8 and no floor,
 *     and a legitimate newsletter therefore never gets flagged for being new.
 *
 * The `reason` strings are shown to the user verbatim, so they are written to teach
 * the signal rather than to name it: "the sender's own domain says this is not from
 * them" is something a person can carry to the next email, and "DMARC=fail" is not.
 */
export interface FiredRule {
  id: string;
  weight: number;
  floor?: ThreatLevel;
  reason: string;
}

/** Score at or above which the rules alone require suspicion. */
export const RULE_SUSPICION_THRESHOLD = 30;

/** Rule score at or above which the model call escalates to the deep tier. */
export const ESCALATE_RULE_SCORE = 45;

export interface SignalSet {
  header: HeaderSignals;
  urls: UrlSignals;
  sender: SenderSignals;
  attachments: RiskyAttachment[];
}

/**
 * Applies the rules to a signal set.
 *
 * Deterministic and synchronous: the same signals always produce the same score,
 * floor and reasons, which is what makes the stored `ruleSignals` re-derivable and the
 * fingerprint meaningful.
 */
export function firedRules(signals: SignalSet): FiredRule[] {
  const fired: FiredRule[] = [];
  const { header, urls, sender } = signals;

  // ── Layer 1: header truth ────────────────────────────────────────────────────
  /*
   * DMARC is the only one of the three that is a statement by the From domain's owner
   * about their own mail, which is why it carries the most weight and a floor: a fail
   * means the domain published a policy and this message violates it.
   */
  if (header.dmarc === "fail") {
    fired.push({
      id: "dmarc-fail",
      weight: 45,
      floor: "SUSPICIOUS",
      reason: `DMARC failed: ${header.fromDomain ?? "the sender's domain"} publishes a policy saying this message did not come from them.`,
    });
  } else if (header.dmarc === null) {
    /*
     * The null-is-not-safe rule from phase 2, and the place it earns its keep. Most
     * mail with no DMARC result is fine; a domain with no published policy is also the
     * easiest domain to forge, so this is a small weight and never a floor.
     */
    fired.push({
      id: "dmarc-missing",
      weight: 12,
      reason:
        "No DMARC result: the receiving server could not confirm this message came from the domain it claims.",
    });
  } else if (header.dmarc === "temperror" || header.dmarc === "permerror") {
    fired.push({
      id: "dmarc-error",
      weight: 10,
      reason: `DMARC could not be evaluated (${header.dmarc}), so the sender's domain was not verified.`,
    });
  }

  /*
   * SPF and DKIM are only read when DMARC did not already pass. DMARC passes when at
   * least one of them passes *and* is aligned with the From domain — so a `dmarc=pass`
   * with `spf=fail` is an ordinary forwarded message, and scoring it would flag
   * correctly configured senders every day until the user stopped reading the banner.
   */
  if (!dmarcVouchesFor(header)) {
    if (header.spf === "fail") {
      fired.push({
        id: "spf-fail",
        weight: 25,
        reason:
          "SPF failed: the server that sent this is not one the sender's domain authorizes.",
      });
    } else if (header.spf === "softfail") {
      fired.push({
        id: "spf-softfail",
        weight: 10,
        reason: "SPF soft-failed: the sending server is not one the domain lists, only tolerated.",
      });
    } else if (header.spf === null) {
      fired.push({
        id: "spf-missing",
        weight: 6,
        reason: "No SPF result: the sending server was not checked against the domain's list.",
      });
    }

    if (header.dkim === "fail") {
      fired.push({
        id: "dkim-fail",
        weight: 25,
        reason:
          "DKIM failed: the message's signature does not verify, so it may have been altered in transit.",
      });
    } else if (header.dkim === null || header.dkim === "none") {
      fired.push({
        id: "dkim-missing",
        weight: 6,
        reason: "The message carries no verified DKIM signature.",
      });
    }
  }

  /*
   * §6 calls this one of the highest-signal cheap checks, and it is: a display name
   * that shows one address while the message comes from another is a deliberate act.
   * Nobody's mail client does this by accident.
   */
  if (header.displayNameMismatch) {
    fired.push({
      id: "display-name-mismatch",
      weight: 35,
      floor: "SUSPICIOUS",
      reason:
        "The sender's name shows one email address, but the message was actually sent from a different one.",
    });
  }

  if (header.replyToDiffers) {
    fired.push({
      id: "reply-to-differs",
      weight: 20,
      reason: `A reply would go to ${header.replyToDomain ?? "another domain"}, not to ${header.fromDomain ?? "the sender's domain"}.`,
    });
  }

  if (header.returnPathAligned === false) {
    fired.push({
      id: "return-path-misaligned",
      weight: 15,
      reason: `The delivery path says this came from ${header.returnPathDomain ?? "another domain"} rather than ${header.fromDomain ?? "the sender's domain"}.`,
    });
  } else if (header.returnPathAligned === null) {
    fired.push({
      id: "return-path-unknown",
      weight: 5,
      reason: "No delivery path was recorded, so where the message was actually sent from is unknown.",
    });
  }

  // ── Layer 2: heuristics ─────────────────────────────────────────────────────
  const lookalike = sender.lookalikeDomain;
  if (lookalike !== null) {
    if (lookalike.viaHomoglyphs && lookalike.distance === 0) {
      /*
       * Character-for-character the known domain once confusables are folded. There is
       * no innocent version of this: a company does not accidentally register its own
       * name in Cyrillic.
       */
      fired.push({
        id: "sender-homoglyph",
        weight: 45,
        floor: "SUSPICIOUS",
        reason: `The sender's domain ${lookalike.domain} is ${lookalike.resembles} spelled with lookalike characters.`,
      });
    } else {
      fired.push({
        id: "sender-lookalike",
        weight: 35,
        floor: "SUSPICIOUS",
        reason: `The sender's domain ${lookalike.domain} closely resembles ${lookalike.resembles}, which you do correspond with — but is not it.`,
      });
    }
  }

  if (sender.punycodeSender) {
    fired.push({
      id: "sender-punycode",
      weight: 25,
      reason:
        "The sender's domain is written in a script that renders differently from how it is stored, which is used to imitate familiar names.",
    });
  }

  if (sender.firstTimeSender) {
    /*
     * Weak, and weak on purpose. Every correspondent was once a first-time sender, so
     * this exists to *add* to other evidence, never to carry a verdict. A legitimate
     * newsletter's first message scores 8 and stays SAFE.
     */
    fired.push({
      id: "first-time-sender",
      weight: 8,
      reason: "This is the first message this mailbox has received from this address.",
    });
  }

  for (const host of urls.rawIpHosts) {
    fired.push({
      id: "link-raw-ip",
      weight: 30,
      floor: "SUSPICIOUS",
      reason: `A link points at a bare IP address (${host}) instead of a domain name.`,
    });
  }

  for (const host of urls.punycodeHosts) {
    fired.push({
      id: "link-punycode",
      weight: 25,
      reason: `A link's address (${host}) is written in a script that renders differently from how it is stored.`,
    });
  }

  for (const link of urls.lookalikeHosts) {
    fired.push({
      id: "link-lookalike",
      weight: 35,
      floor: "SUSPICIOUS",
      reason: `A link goes to ${link.domain}, which closely resembles ${link.resembles} without being it.`,
    });
  }

  for (const mismatch of urls.displayMismatches) {
    fired.push({
      id: "link-display-mismatch",
      weight: 30,
      reason: `A link that reads ${mismatch.shownHost} actually goes to ${mismatch.actualHost}.`,
    });
  }

  for (const attachment of signals.attachments) {
    if (attachment.riskFlag === "executable") {
      fired.push({
        id: "attachment-executable",
        weight: 35,
        floor: "SUSPICIOUS",
        reason: `The attachment ${attachment.filename} is a program, not a document. Opening it runs it.`,
      });
    } else if (attachment.riskFlag === "macro") {
      fired.push({
        id: "attachment-macro",
        weight: 30,
        floor: "SUSPICIOUS",
        reason: `The attachment ${attachment.filename} is a document that can contain macros — code that runs when you open it.`,
      });
    } else if (attachment.riskFlag === "archive") {
      fired.push({
        id: "attachment-archive",
        weight: 10,
        reason: `The attachment ${attachment.filename} is an archive, which hides what is inside it from scanners.`,
      });
    }
  }

  return fired;
}

/** Stable JSON: object keys sorted, so a fingerprint does not depend on insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Hash of the deterministic findings.
 *
 * The model's interpretation is cached against this *and* the body's content hash, so
 * an interpretation is reused only when both the text and the facts around it are
 * unchanged. That second half matters: a sender who was new yesterday is familiar
 * today, and a first-time-sender explanation should not outlive the fact.
 */
export function fingerprintOf(signals: SignalSet): string {
  return createHash("sha256").update(canonical(signals)).digest("hex").slice(0, 32);
}

/**
 * The deterministic verdict.
 *
 * The floor is SUSPICIOUS when any floor-setting rule fired *or* when the accumulated
 * score crosses `RULE_SUSPICION_THRESHOLD` — three weak signals at once is itself a
 * signal. The rules never return PHISHING: naming an attack requires reading intent,
 * which is the model's job. What the rules can say is "something here is wrong", and
 * that is exactly the claim a well-written email must not be able to argue away.
 */
export function evaluateRules(signals: SignalSet): RuleSignals {
  const fired = firedRules(signals);

  const score = Math.min(
    100,
    fired.reduce((total, rule) => total + rule.weight, 0),
  );
  const hasFloorRule = fired.some((rule) => rule.floor !== undefined);
  const floor: ThreatLevel =
    hasFloorRule || score >= RULE_SUSPICION_THRESHOLD ? "SUSPICIOUS" : "SAFE";

  return ruleSignalsSchema.parse({
    version: 1,
    fingerprint: fingerprintOf(signals),
    header: signals.header,
    urls: signals.urls,
    sender: signals.sender,
    attachments: signals.attachments,
    score,
    floor,
    reasons: fired.map((rule) => rule.reason),
  });
}

/**
 * What a model level is worth as a score.
 *
 * Anchors rather than a scale the model is asked to produce. Asking for a number
 * invites arguing about it — a persuasive email is precisely a text arguing for a
 * lower number — whereas a level is a four-way judgment that the union can handle. A
 * model SAFE contributes 0, which cannot lower anything the rules found.
 */
const MODEL_LEVEL_SCORE: Readonly<Record<AiThreatAssessmentOutput["assessedLevel"], number>> = {
  SAFE: 0,
  SPAM: 40,
  SUSPICIOUS: 60,
  PHISHING: 85,
};

/** How an intent reads in a reason line, when the model's judgment raised the verdict. */
const INTENT_REASON: Readonly<Record<ThreatIntent, string>> = {
  CREDENTIAL_HARVEST: "reads as an attempt to get you to enter a password or a login code",
  BEC: "reads as someone impersonating a colleague to get an action out of you",
  INVOICE_FRAUD: "reads as a false or altered payment request",
  MALWARE: "reads as an attempt to get you to open a file",
  EXTORTION: "reads as a threat intended to pressure you",
  ADVANCE_FEE: "reads as a promised windfall that will ask you to pay first",
  BENIGN_MARKETING: "reads as ordinary marketing",
  BENIGN_TRANSACTIONAL: "reads as an ordinary automated notice",
  BENIGN_PERSONAL: "reads as ordinary correspondence",
  UNCLEAR: "could not be read either way",
};

export interface Verdict {
  level: ThreatLevel;
  score: number;
  reasons: string[];
}

/**
 * The union: rules set a floor the model cannot lower.
 *
 * One function, so there is exactly one place where a level is decided, and so the
 * property §6 asks for can be tested directly rather than inferred from a call graph.
 *
 * When the model's reading is *less* severe than the floor, its disagreement is kept
 * as a reason rather than dropped. A user looking at a suspicious banner on a mail that
 * reads perfectly normally deserves to be told that both of those things are true —
 * that is the case where the layering is doing its work, and hiding it would make the
 * banner look like a bug.
 */
export function unionVerdict(
  rules: RuleSignals,
  model: AiThreatAssessmentOutput | null,
): Verdict {
  if (model === null) {
    return { level: rules.floor, score: rules.score, reasons: [...rules.reasons] };
  }

  const level = moreSevere(rules.floor, model.assessedLevel);
  const score = Math.max(rules.score, MODEL_LEVEL_SCORE[model.assessedLevel]);
  const reasons = [...rules.reasons];

  if (SEVERITY[model.assessedLevel] > SEVERITY[rules.floor]) {
    reasons.push(`Read in full, the message ${INTENT_REASON[model.intent]}.`);
  } else if (SEVERITY[model.assessedLevel] < SEVERITY[rules.floor]) {
    reasons.push(
      `The text itself ${INTENT_REASON[model.intent]}, but the checks above stand regardless of how it reads.`,
    );
  }

  return { level, score, reasons };
}

/** The message columns this layer reads. */
export const THREAT_MESSAGE_SELECT = {
  id: true,
  subject: true,
  fromName: true,
  fromEmail: true,
  to: true,
  cc: true,
  replyTo: true,
  sentAt: true,
  bodyText: true,
  bodyHtml: true,
  snippet: true,
  isOutbound: true,
  hasAttachments: true,
  contentHash: true,
  authResults: true,
  attachments: { select: { filename: true, riskFlag: true } },
} as const;

export interface MessageForThreat {
  id: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string;
  to: string[];
  cc: string[];
  replyTo: string | null;
  sentAt: Date;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  isOutbound: boolean;
  hasAttachments: boolean;
  contentHash: string;
  authResults: unknown;
  attachments: { filename: string; riskFlag: string | null }[];
}

/**
 * Runs layers 1 and 2 over one message.
 *
 * The two database reads here (the user's known domains, and how often this sender has
 * written before) are what make the heuristics personal rather than generic — and both
 * degrade to "no signal" rather than failing, because header truth needs neither of
 * them and is the half that matters most.
 */
export async function collectSignals(input: {
  userId: string;
  mailAccountId: string;
  message: MessageForThreat;
}): Promise<SignalSet> {
  const { message } = input;

  const known = await knownDomainsFor(input.userId);
  const seen = await messagesSeenFrom({
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    fromEmail: message.fromEmail,
    before: message.sentAt,
  });

  const header = headerSignals({
    authResults: message.authResults,
    fromEmail: message.fromEmail,
    replyTo: message.replyTo,
  });

  const fromHost = message.fromEmail.slice(message.fromEmail.lastIndexOf("@") + 1).toLowerCase();

  const sender: SenderSignals = {
    messagesSeenFrom: seen,
    firstTimeSender: seen === 0,
    lookalikeDomain: lookalikeOf(header.fromDomain, known),
    punycodeSender: isPunycodeHost(fromHost),
  };

  return {
    header,
    urls: urlSignals({
      bodyHtml: message.bodyHtml,
      bodyText: message.bodyText ?? message.snippet,
      knownDomains: known,
    }),
    sender,
    attachments: message.attachments
      .filter((attachment): attachment is { filename: string; riskFlag: string } =>
        attachment.riskFlag !== null,
      )
      .map((attachment) => ({ filename: attachment.filename, riskFlag: attachment.riskFlag })),
  };
}

/**
 * The classification fields, when a threat assessment is the first thing to write the
 * row.
 *
 * `AiClassification` is one row shared by two stages, and either can run first:
 * classification is off for some users, and threat detection is off for others. So each
 * stage writes its own half and leaves the other half *visibly* unwritten, which is the
 * same choice `classify.ts` makes in the other direction with its `THREAT_PLACEHOLDER`.
 * "und" is the ISO 639-2 code for an undetermined language, and a confidence of 0 says
 * plainly that nothing classified this.
 */
const CLASSIFY_PLACEHOLDER = {
  category: "OTHER",
  priority: "LOW",
  priorityScore: 0,
  needsReply: false,
  language: "und",
  confidence: 0,
} as const;

const TOOL_NAME = "record_threat_assessment";
const TOOL_DESCRIPTION =
  "Record what the sender of the email in the untrusted_email block was trying to do, and the explanation to show the person who received it. This is the only way to respond.";

export interface AssessThreatInput {
  userId: string;
  mailAccountId: string;
  mailboxAddress: string;
  message: MessageForThreat;
  settings?: AiSettings;
  signal?: AbortSignal;
}

export interface AssessThreatResult {
  level: ThreatLevel;
  score: number;
  reasons: string[];
  rules: RuleSignals;
  intent: ThreatIntent | null;
  /** True when no model call was made — cache hit, cap, AI off, or rules already decisive. */
  rulesOnly: boolean;
  fromCache: boolean;
  model: string | null;
  skipped?: string;
}

/**
 * Assesses one message and writes the verdict.
 *
 * Order of operations, each step of which is a decision:
 *
 *   1. Outbound mail is skipped. Scoring the user's own sent mail would put a threat
 *      banner on their own words.
 *   2. Layers 1 and 2 run *first and always*. They cost no tokens, so there is no
 *      version of this where the cheap evidence is skipped to save money.
 *   3. The cache is checked (rule 7) against the body hash **and** the signal
 *      fingerprint.
 *   4. The model runs, on the deep tier when the rules already found hard evidence.
 *   5. The verdict is the union, and the row is written with both halves kept apart:
 *      `ruleSignals` records what the rules alone concluded, so a verdict can always be
 *      taken apart afterwards.
 */
export async function assessMessageThreat(
  input: AssessThreatInput,
): Promise<AssessThreatResult> {
  const { message } = input;
  const log = logger.child({
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    messageId: message.id,
  });

  const signals = await collectSignals(input);
  const rules = evaluateRules(signals);

  if (message.isOutbound) {
    return {
      level: "UNKNOWN",
      score: 0,
      reasons: [],
      rules,
      intent: null,
      rulesOnly: true,
      fromCache: false,
      model: null,
      skipped: "outbound",
    };
  }

  const db = dbForUser(input.userId);

  /*
   * Rule 7, with the extra term this layer needs. A row whose body hash matches but
   * whose signals have changed is a miss: the interpretation was written about a
   * different set of facts.
   */
  const cached = await db.aiClassification.findFirst({
    where: { messageId: message.id, contentHash: message.contentHash },
    select: {
      threatLevel: true,
      threatIntent: true,
      threatExplanation: true,
      threatModel: true,
      ruleSignals: true,
    },
  });

  if (cached !== null && cached.threatLevel !== "UNKNOWN") {
    const storedFingerprint = (cached.ruleSignals as { fingerprint?: unknown } | null)
      ?.fingerprint;
    if (storedFingerprint === rules.fingerprint) {
      log.debug({ level: cached.threatLevel }, "threat assessment cache hit");
      const parsedIntent = threatIntentSchema.safeParse(cached.threatIntent);
      const storedRules = ruleSignalsSchema.safeParse(cached.ruleSignals);
      return {
        level: cached.threatLevel,
        score: storedRules.success ? storedRules.data.score : rules.score,
        reasons: storedRules.success ? storedRules.data.reasons : rules.reasons,
        rules: storedRules.success ? storedRules.data : rules,
        intent: parsedIntent.success ? parsedIntent.data : null,
        rulesOnly: cached.threatExplanation === null,
        fromCache: true,
        model: cached.threatModel,
      };
    }
  }

  let assessment: AiThreatAssessmentOutput | null = null;
  let model: string | null = null;
  let skipped: string | undefined;

  /*
   * The deep tier is for the case where the cheap layers already found something. That
   * is the moment the remaining question stops being "is anything wrong" — the rules
   * have answered that — and becomes "is this aimed at this person, and what do we tell
   * them", which is worth the better reader.
   */
  const feature = rules.score >= ESCALATE_RULE_SCORE ? "threatDeep" : "threat";

  try {
    const called = await callStructured({
      userId: input.userId,
      feature,
      toolName: TOOL_NAME,
      toolDescription: TOOL_DESCRIPTION,
      schema: aiThreatAssessmentSchema,
      // Mail first, our findings last: the attacker does not get the final word (§7).
      userContent: [
        untrustedEmailBlock({
          metadata: threatMetadata(message, input.mailboxAddress),
          body: promptBody(message),
        }),
        threatSignalsBlock({
          reasons: rules.reasons,
          spf: rules.header.spf,
          dkim: rules.header.dkim,
          dmarc: rules.header.dmarc,
          ruleScore: rules.score,
          ruleFloor: rules.floor,
          messagesSeenFrom: rules.sender.messagesSeenFrom,
          linkCount: rules.urls.linkCount,
        }),
      ].join("\n\n"),
      ...(input.settings ? { settings: input.settings } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      logContext: { messageId: message.id, ruleScore: rules.score, ruleFloor: rules.floor },
    });

    assessment = called.data;
    model = called.model;
  } catch (error) {
    /*
     * A spent cap or disabled AI is not a failure here, and this is the one stage where
     * that is more than a convenience: layers 1 and 2 are a complete, useful verdict on
     * their own. A mailbox that has run out of budget still gets its DMARC failures
     * flagged — it just does not get the explanation.
     */
    if (error instanceof AiCapExceededError) skipped = "cap";
    else if (error instanceof AiDisabledError) skipped = "disabled";
    else throw error;

    log.warn({ skipped, ruleFloor: rules.floor }, "threat assessed by rules alone");
  }

  const verdict = unionVerdict(rules, assessment);

  const fields = {
    threatLevel: verdict.level,
    threatScore: verdict.score,
    threatReasons: verdict.reasons as unknown as Prisma.InputJsonValue,
    ruleSignals: rules as unknown as Prisma.InputJsonValue,
    threatIntent: assessment?.intent ?? null,
    threatExplanation: assessment?.explanation ?? null,
    threatModel: model,
    contentHash: message.contentHash,
  };

  /*
   * Upsert, because either stage may be the first to write this row — and `create`
   * therefore has to supply the classification half. The tenancy extension cannot
   * narrow a unique `where` on a path-scoped model, so the ownership guarantee comes
   * from the caller having loaded this message through `dbForUser` (see
   * `services/ai/enrich.ts`).
   */
  await db.aiClassification.upsert({
    where: { messageId: message.id },
    create: {
      messageId: message.id,
      ...CLASSIFY_PLACEHOLDER,
      model: model ?? "rules-only",
      ...fields,
    },
    update: fields,
  });

  log.info(
    {
      level: verdict.level,
      score: verdict.score,
      ruleScore: rules.score,
      ruleFloor: rules.floor,
      intent: assessment?.intent ?? null,
      modelLevel: assessment?.assessedLevel ?? null,
      feature: assessment === null ? null : feature,
      rules: rules.reasons.length,
    },
    "threat assessed",
  );

  return {
    level: verdict.level,
    score: verdict.score,
    reasons: verdict.reasons,
    rules,
    intent: assessment?.intent ?? null,
    rulesOnly: assessment === null,
    fromCache: false,
    model,
    ...(skipped === undefined ? {} : { skipped }),
  };
}

/**
 * The envelope facts the threat prompt gets.
 *
 * Deliberately not `promptMetadata` from the AI layer: that one is tuned for
 * classification and hides a Reply-To behind a boolean. Here the *addresses* are the
 * evidence, so they are given in full — and the model is separately told, in the
 * signals block, what our own checks made of them.
 */
function threatMetadata(
  message: MessageForThreat,
  mailboxAddress: string,
): Record<string, string | number | boolean | null> {
  return {
    from: message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail,
    from_domain: registrableDomain(
      message.fromEmail.slice(message.fromEmail.lastIndexOf("@") + 1),
    ),
    reply_to: message.replyTo,
    to: message.to.join(", "),
    cc: message.cc.join(", "),
    subject: message.subject ?? "(no subject)",
    sent_at: message.sentAt.toISOString(),
    mailbox_owner: mailboxAddress,
    has_attachments: message.hasAttachments,
    attachments: message.attachments.map((attachment) => attachment.filename).join(", "),
  };
}

/**
 * Rolls the thread's denormalized `threatLevel` up from its messages.
 *
 * The worst message wins, and not only the newest: a thread is as dangerous as the most
 * dangerous thing in it, and a benign follow-up must not clear the banner on the
 * forged message above it. This is the one field in §6 the list view reads, which is
 * why it is a rollup rather than "whatever was assessed last".
 */
export async function refreshThreadThreatLevel(
  userId: string,
  threadId: string,
): Promise<ThreatLevel> {
  const db = dbForUser(userId);

  /*
   * The thread filter goes inside `AND`, not at the top level, and that is not a style
   * choice. The tenancy extension merges its own predicate in with a spread:
   *
   *   where: { ...existing, ...tenantFilter(rule, userId) }
   *
   * and for `AiClassification` that predicate is keyed on `message`. A top-level
   * `where: { message: { threadId } }` is therefore *overwritten* by it, and the query
   * silently widens to every assessed message the user owns — which rolled the worst
   * verdict in the mailbox onto every thread in it. (Found by running this against a real
   * database; the mocked tests could not see it, because the mock has no extension.)
   * Under `AND` the two predicates sit side by side and both apply.
   */
  const rows = await db.aiClassification.findMany({
    where: { AND: [{ message: { threadId } }] },
    select: { threatLevel: true },
  });

  const level = rows.reduce<ThreatLevel>(
    (worst, row) => moreSevere(worst, row.threatLevel),
    "UNKNOWN",
  );

  await db.thread.update({ where: { id: threadId }, data: { threatLevel: level } });
  return level;
}
