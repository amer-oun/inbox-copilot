import { createHash } from "node:crypto";
import { dbForUser, type Prisma } from "@inbox-copilot/db";
import {
  DEMO_MAIL_ACCOUNT_ID,
  DEMO_MAILBOX_ADDRESS,
  DEMO_MAILBOX_NAME,
  DEMO_SAMPLE_MODEL,
  DEMO_USER_EMAIL,
  DEMO_USER_ID,
  demoId,
  type DemoSessionResponseDto,
} from "@inbox-copilot/shared";
import { htmlToText } from "../../lib/html.js";
import { logger } from "../../lib/logger.js";
import { connectRedis, redis } from "../../lib/redis.js";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "../../lib/timezone.js";
import { foldDomains, type DomainRow } from "../security/contacts.js";
import { domainOf, headerSignals } from "../security/headers.js";
import { evaluateRules, unionVerdict } from "../security/phishing.js";
import { isPunycodeHost, lookalikeOf, urlSignals } from "../security/urls.js";
import {
  DEMO_REMINDERS,
  DEMO_SCHEDULED,
  DEMO_THREADS,
  DEMO_TIMEZONE,
  DEMO_WRITING_STYLE,
  SAM,
  SENDER_HISTORY,
  type DemoMessage,
  type DemoPerson,
  type DemoThread,
  type DemoThreatReading,
} from "./fixtures.js";

/**
 * Seeding and resetting the demo mailbox.
 *
 * **One shared demo user, restored rather than cloned.** Every visitor signs in as the
 * same user, so "one visitor's actions do not affect the next" is a reset policy:
 *
 *   - `startDemoSession` (each "Try the demo" click) restores the mailbox when a
 *     previous visitor changed it — appealed a verdict, dismissed a reminder, cancelled
 *     a scheduled send — or when the last restore is over half an hour old, which is
 *     also what keeps "22 minutes ago" true;
 *   - `ensureDemoMailbox` (every demo request, memoized) seeds it when it is missing,
 *     so a fresh database or a failed restore heals without a deploy step.
 *
 * The honest limit of a shared user: two visitors at the same moment see each other's
 * changes, and a new visitor's restore can undo a change the other made a minute ago.
 * The cost of avoiding that is a mailbox per visitor, and for a portfolio demo the
 * shared one is the right trade.
 *
 * **Rows are rebuilt, not patched.** A restore deletes the demo mailbox's threads (the
 * cascade takes messages, verdicts, summaries, drafts, translations and appeals with
 * them) and writes the fixture again under the same fixed ids, in one transaction —
 * so a visitor mid-restore reads the old mailbox or the new one, never half of each,
 * and a thread URL opened before the restore still resolves after it.
 *
 * `AiUsage` is deliberately *not* reset. It is the ledger the demo's daily AI cap
 * counts, and resetting it would refill the budget on every visit.
 */

const MINUTE_MS = 60_000;

/** A restore older than this is redone on the next "Try the demo". */
export const DEMO_RESTORE_AFTER_MS = 30 * MINUTE_MS;

/** A mailbox older than this is restored on any demo request, not just a new session. */
const DEMO_STALE_AFTER_MS = 12 * 60 * MINUTE_MS;

/** How often a process re-checks that the demo mailbox exists. */
const ENSURE_INTERVAL_MS = MINUTE_MS;

/** Postgres advisory lock key, so two restores cannot interleave. Any fixed number. */
const RESET_LOCK_KEY = 74_110_326;

/** Set when a visitor changes something the next visitor would notice. */
const CHANGED_KEY = "demo:changed";

/**
 * The demo's daily budget for live model calls, in the ledger's own units (calls).
 * Enforced by the ordinary cap check in `services/ai/client.ts`; see ai.ts for the
 * per-visitor and hourly limits under it.
 */
export const DEMO_DAILY_AI_CALL_CAP = 60;

/* ── Building rows (pure) ──────────────────────────────────────────────────────── */

function formatAddress(person: DemoPerson): string {
  return `${person.name} <${person.email}>`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function plainText(message: DemoMessage): string {
  const raw = message.text ?? htmlToText(message.html ?? "");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const DEFAULT_EXPLANATION: Readonly<Record<DemoThread["intent"], string>> = {
  BENIGN_PERSONAL:
    "Ordinary correspondence from someone you write to regularly. Nothing in it asks for a password, a code or a payment.",
  BENIGN_TRANSACTIONAL:
    "An automated notice from a service you use. Its links stay on the sender's own domain and nothing asks you to sign in from the email.",
  BENIGN_MARKETING:
    "Marketing from a sender you have had mail from before. It passes its authentication checks and asks for nothing beyond a click.",
};

export function messageIdFor(threadN: number, index: number): string {
  return demoId("mesg", threadN * 100 + index + 1);
}

export function threadIdFor(threadN: number): string {
  return demoId("thrd", threadN);
}

function providerMessageIdFor(threadN: number, index: number): string {
  return `demo-msg-${threadN}-${index + 1}`;
}

/** Oldest first, as the thread view reads them. */
function orderedMessages(thread: DemoThread): DemoMessage[] {
  return [...thread.messages].sort((a, b) => b.minutesAgo - a.minutesAgo);
}

function isOutbound(message: DemoMessage): boolean {
  return message.from.email === SAM.email;
}

/**
 * The known-domain set, folded by the real function from the rows the real query
 * would have returned: outbound recipients, the mailbox's own domain, and inbound
 * senders counted with their history.
 */
export function demoKnownDomains(): ReadonlySet<string> {
  const rows: DomainRow[] = [{ domain: domainOf(SAM.email), n: 1, outbound: true }];
  const inbound = new Map<string, number>();

  for (const thread of DEMO_THREADS) {
    for (const message of thread.messages) {
      if (isOutbound(message)) {
        for (const person of [...message.to, ...(message.cc ?? [])]) {
          rows.push({ domain: domainOf(person.email), n: 1, outbound: true });
        }
      } else {
        inbound.set(message.from.email, (inbound.get(message.from.email) ?? 0) + 1);
      }
    }
  }
  for (const [email, count] of inbound) {
    rows.push({
      domain: domainOf(email),
      n: count + (SENDER_HISTORY[email] ?? 0),
      outbound: false,
    });
  }

  return foldDomains(rows);
}

export interface DemoRows {
  user: Prisma.UserCreateInput & { id: string };
  settings: Prisma.UserSettingsUncheckedCreateInput;
  style: Prisma.UserWritingStyleUncheckedCreateInput;
  mailAccount: Prisma.MailAccountUncheckedCreateInput & { id: string };
  threads: Prisma.ThreadCreateManyInput[];
  messages: Prisma.MessageCreateManyInput[];
  attachments: Prisma.AttachmentCreateManyInput[];
  classifications: Prisma.AiClassificationCreateManyInput[];
  summaries: Prisma.AiSummaryCreateManyInput[];
  translations: Prisma.TranslationCreateManyInput[];
  scheduled: Prisma.ScheduledEmailCreateManyInput[];
  reminders: Prisma.FollowUpReminderCreateManyInput[];
}

const SEVERITY = { UNKNOWN: -1, SAFE: 0, SPAM: 1, SUSPICIOUS: 2, PHISHING: 3 } as const;

/**
 * The whole demo mailbox as rows, with every time relative to `now`.
 *
 * Pure: no database, no clock of its own. The layer 1 and 2 verdicts are computed
 * here by the same functions the enrichment pipeline uses, from the auth results and
 * bodies in the fixture — so the phishing banner's reasons are the rules' own words,
 * and a change to a rule changes the demo the way it would change a real mailbox.
 * Only the layer 3 reading (the "model" half) comes from the fixture.
 */
export function buildDemoRows(now: Date): DemoRows {
  const at = (minutesAgo: number): Date =>
    new Date(now.getTime() - minutesAgo * MINUTE_MS);
  const known = demoKnownDomains();

  const rows: DemoRows = {
    user: {
      id: DEMO_USER_ID,
      name: DEMO_MAILBOX_NAME,
      email: DEMO_USER_EMAIL,
      timezone: DEMO_TIMEZONE,
      locale: "en",
    },
    settings: {
      id: demoId("setg", 1),
      userId: DEMO_USER_ID,
      aiEnabled: true,
      autoSummarize: true,
      autoCategorize: true,
      phishingProtection: true,
      defaultTone: "PROFESSIONAL",
      translationLang: "en",
      followUpDays: 3,
      // The digest is the one feature that emails the user; the demo user is not real.
      followUpDigest: false,
      dailyAiCallCap: DEMO_DAILY_AI_CALL_CAP,
      storeFullBodies: true,
    },
    style: {
      id: demoId("styl", 1),
      userId: DEMO_USER_ID,
      ...DEMO_WRITING_STYLE,
    },
    mailAccount: {
      id: DEMO_MAIL_ACCOUNT_ID,
      userId: DEMO_USER_ID,
      provider: "GMAIL",
      emailAddress: DEMO_MAILBOX_ADDRESS,
      displayName: DEMO_MAILBOX_NAME,
      // No token columns and no scopes: there is no grant behind this mailbox.
      scopes: [],
      /*
       * PAUSED keeps the background jobs away: the watch keeper and the AI sweep only
       * look at PENDING/BACKFILLING/ACTIVE/ERROR mailboxes. The provider wall in
       * `mailProviderFor` would refuse them anyway (guard.ts), but a job that is never
       * queued is quieter than one that is refused every hour.
       */
      syncStatus: "PAUSED",
      // The restore time. `startDemoSession` reads it to decide whether to restore again.
      lastSyncedAt: now,
      backfilledUntil: at(90 * 24 * 60),
    },
    threads: [],
    messages: [],
    attachments: [],
    classifications: [],
    summaries: [],
    translations: [],
    scheduled: [],
    reminders: [],
  };

  /** Inbound messages per sender already placed, oldest first across the mailbox. */
  const seenInFixture = new Map<string, number>();
  const allInbound = DEMO_THREADS.flatMap((thread) =>
    thread.messages.filter((message) => !isOutbound(message)),
  ).sort((a, b) => b.minutesAgo - a.minutesAgo);
  const priorInFixture = new Map<DemoMessage, number>();
  for (const message of allInbound) {
    const count = seenInFixture.get(message.from.email) ?? 0;
    priorInFixture.set(message, count);
    seenInFixture.set(message.from.email, count + 1);
  }

  for (const thread of DEMO_THREADS) {
    const threadId = threadIdFor(thread.n);
    const messages = orderedMessages(thread);
    const newestInbound = [...messages].reverse().find((message) => !isOutbound(message));
    let worst: keyof typeof SEVERITY = "UNKNOWN";
    const hashes: string[] = [];

    messages.forEach((message, index) => {
      const id = messageIdFor(thread.n, index);
      const outbound = isOutbound(message);
      const bodyText = plainText(message);
      const contentHash = sha256(bodyText);
      hashes.push(contentHash);
      const internetMessageId = `<demo-${thread.n}-${index + 1}@northwind-freight.example>`;
      const fromDomain = domainOf(message.from.email);
      const authResults = outbound
        ? null
        : {
            spf: message.auth?.spf ?? "pass",
            dkim: message.auth?.dkim ?? "pass",
            dmarc: message.auth?.dmarc ?? "pass",
            returnPath:
              message.auth?.returnPath ?? `bounces@${fromDomain ?? "example.com"}`,
            displayNameMismatch: false,
          };

      rows.messages.push({
        id,
        threadId,
        mailAccountId: DEMO_MAIL_ACCOUNT_ID,
        providerMessageId: providerMessageIdFor(thread.n, index),
        internetMessageId,
        fromName: message.from.name,
        fromEmail: message.from.email,
        to: message.to.map(formatAddress),
        cc: (message.cc ?? []).map(formatAddress),
        bcc: [],
        replyTo: message.replyTo ?? null,
        subject: index === 0 ? thread.subject.replace(/^Re: /, "") : thread.subject,
        bodyText,
        bodyHtml: message.html ?? null,
        snippet: snippetOf(bodyText),
        sentAt: at(message.minutesAgo),
        isRead: outbound ? true : (message.isRead ?? false),
        isOutbound: outbound,
        isDraft: false,
        hasAttachments: (message.attachments?.length ?? 0) > 0,
        headers: { "message-id": internetMessageId },
        ...(authResults === null ? {} : { authResults }),
        contentHash,
      });

      (message.attachments ?? []).forEach((attachment, j) => {
        rows.attachments.push({
          id: demoId("atch", thread.n * 1000 + index * 10 + j),
          messageId: id,
          providerAttachmentId: null,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          isInline: false,
          riskFlag: attachment.riskFlag ?? null,
        });
      });

      if (outbound) return;

      // ── Layers 1 and 2: the real rules over the fixture's headers and body ──
      const seen =
        (SENDER_HISTORY[message.from.email] ?? 0) + (priorInFixture.get(message) ?? 0);
      const header = headerSignals({
        authResults,
        fromEmail: message.from.email,
        replyTo: message.replyTo ?? null,
      });
      const fromHost = message.from.email.slice(message.from.email.lastIndexOf("@") + 1);
      const rules = evaluateRules({
        header,
        urls: urlSignals({
          bodyHtml: message.html ?? null,
          bodyText,
          knownDomains: known,
        }),
        sender: {
          messagesSeenFrom: seen,
          firstTimeSender: seen === 0,
          lookalikeDomain: lookalikeOf(header.fromDomain, known),
          punycodeSender: isPunycodeHost(fromHost),
        },
        attachments: (message.attachments ?? []).flatMap((attachment) =>
          attachment.riskFlag === undefined
            ? []
            : [{ filename: attachment.filename, riskFlag: attachment.riskFlag }],
        ),
      });

      // ── Layer 3: the pre-written reading, unioned exactly as the pipeline does ──
      const reading: DemoThreatReading = message.threat ?? {
        intent: thread.intent,
        assessedLevel: "SAFE",
        explanation: DEFAULT_EXPLANATION[thread.intent],
      };
      const verdict = unionVerdict(rules, { confidence: 0.9, ...reading });
      if (SEVERITY[verdict.level] > SEVERITY[worst]) worst = verdict.level;

      rows.classifications.push({
        id: demoId("clsf", thread.n * 100 + index + 1),
        messageId: id,
        category: thread.category,
        priority: thread.priority,
        priorityScore: thread.priorityScore,
        needsReply: thread.needsReply && message === newestInbound,
        language: thread.language,
        confidence: 0.92,
        threatLevel: verdict.level,
        threatScore: verdict.score,
        threatReasons: verdict.reasons,
        ruleSignals: rules as unknown as Prisma.InputJsonValue,
        threatIntent: reading.intent,
        threatExplanation: reading.explanation,
        threatModel: DEMO_SAMPLE_MODEL,
        model: DEMO_SAMPLE_MODEL,
        contentHash,
        createdAt: at(message.minutesAgo - 1),
      });

      if (message.translationEn) {
        rows.translations.push({
          id: demoId("tran", thread.n * 100 + index + 1),
          messageId: id,
          targetLang: "en",
          sourceLang: message.translationEn.sourceLang,
          translatedText: message.translationEn.text,
          contentHash,
          model: DEMO_SAMPLE_MODEL,
          createdAt: at(message.minutesAgo - 2),
        });
      }
    });

    const first = messages[0] as DemoMessage;
    const last = messages[messages.length - 1] as DemoMessage;
    const participants = new Map<string, DemoPerson>();
    for (const message of messages) {
      for (const person of [message.from, ...message.to, ...(message.cc ?? [])]) {
        participants.set(person.email, person);
      }
    }

    rows.threads.push({
      id: threadId,
      mailAccountId: DEMO_MAIL_ACCOUNT_ID,
      providerThreadId: `demo-thread-${thread.n}`,
      subject: thread.subject,
      snippet: snippetOf(plainText(last)),
      participants: [...participants.values()].map((person) => ({
        name: person.name,
        email: person.email,
      })),
      messageCount: messages.length,
      firstMessageAt: at(first.minutesAgo),
      lastMessageAt: at(last.minutesAgo),
      isRead: messages.every((message) => isOutbound(message) || message.isRead === true),
      isStarred: thread.isStarred ?? false,
      isArchived: false,
      isTrashed: false,
      category: thread.category,
      priority: thread.priority,
      priorityScore: thread.priorityScore,
      threatLevel: worst,
      needsReply: thread.needsReply,
      language: thread.language,
      providerLabels: thread.isStarred ? ["INBOX", "STARRED"] : ["INBOX"],
    });

    if (thread.summary) {
      rows.summaries.push({
        id: demoId("summ", thread.n),
        threadId,
        contentHash: sha256(hashes.join(":")),
        model: DEMO_SAMPLE_MODEL,
        headline: thread.summary.headline,
        summary: thread.summary.summary,
        keyPoints: thread.summary.keyPoints,
        actionItems: thread.summary.actionItems as unknown as Prisma.InputJsonValue,
        createdAt: at(Math.max(0, last.minutesAgo - 2)),
      });
    }
  }

  for (const item of DEMO_SCHEDULED) {
    const day = utcToZonedWallTime(
      new Date(now.getTime() + item.inDays * 24 * 60 * MINUTE_MS),
      DEMO_TIMEZONE,
    ).slice(0, 10);
    const localSendAt = `${day}T${item.at}`;
    const thread = item.threadN === undefined ? undefined : findThread(item.threadN);
    const parentIndex = thread === undefined ? -1 : thread.messages.length - 1;

    rows.scheduled.push({
      id: demoId("schd", item.n),
      userId: DEMO_USER_ID,
      mailAccountId: DEMO_MAIL_ACCOUNT_ID,
      threadId: thread === undefined ? null : threadIdFor(thread.n),
      to: item.to.map(formatAddress),
      cc: [],
      bcc: [],
      subject: item.subject,
      bodyText: item.body,
      bodyHtml: textToHtml(item.body),
      sendAt: zonedWallTimeToUtc(localSendAt, DEMO_TIMEZONE),
      timezone: DEMO_TIMEZONE,
      localSendAt,
      expectsReply: item.expectsReply ?? false,
      parentMessageId: thread === undefined ? null : messageIdFor(thread.n, parentIndex),
      status: "SCHEDULED",
      idempotencyKey: `demo-scheduled-${item.n}`,
      createdAt: at(3 * 60),
    });
  }

  for (const item of DEMO_REMINDERS) {
    const thread = findThread(item.threadN);
    const messages = orderedMessages(thread);
    const watchedIndex = messages.map(isOutbound).lastIndexOf(true);
    if (watchedIndex === -1) {
      throw new Error(`demo reminder ${item.n} is on a thread with no outbound message`);
    }
    const watched = messages[watchedIndex] as DemoMessage;

    rows.reminders.push({
      id: demoId("remd", item.n),
      userId: DEMO_USER_ID,
      threadId: threadIdFor(thread.n),
      watchedMessageId: providerMessageIdFor(thread.n, watchedIndex),
      reason: item.reason,
      dueAt: at(item.dueMinutesAgo),
      status: item.status,
      createdAt: at(watched.minutesAgo - 1),
    });
  }

  return rows;
}

function findThread(n: number): DemoThread {
  const thread = DEMO_THREADS.find((candidate) => candidate.n === n);
  if (thread === undefined) throw new Error(`no demo thread ${n}`);
  return thread;
}

/* ── Writing rows ──────────────────────────────────────────────────────────────── */

/**
 * Restores the demo mailbox to its seeded state. Returns false when another restore
 * held the lock, in which case that one is doing the same work.
 */
export async function resetDemoMailbox(now: Date = new Date()): Promise<boolean> {
  const rows = buildDemoRows(now);
  const db = dbForUser(DEMO_USER_ID);

  // Cleared before the restore rather than after, so a change a visitor makes while
  // the restore runs marks the mailbox again instead of being forgotten.
  await clearDemoChanged();

  const restored = await db.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${RESET_LOCK_KEY}) AS locked`;
      if (lock?.locked !== true) return false;

      await tx.user.upsert({
        where: { id: DEMO_USER_ID },
        create: rows.user,
        update: { name: DEMO_MAILBOX_NAME, timezone: DEMO_TIMEZONE },
      });
      await tx.userSettings.upsert({
        where: { userId: DEMO_USER_ID },
        create: rows.settings,
        update: rows.settings,
      });
      await tx.userWritingStyle.upsert({
        where: { userId: DEMO_USER_ID },
        create: rows.style,
        update: rows.style,
      });
      await tx.mailAccount.upsert({
        where: { id: DEMO_MAIL_ACCOUNT_ID },
        create: rows.mailAccount,
        update: rows.mailAccount,
      });

      // Scheduled sends hang off the thread with SetNull, so they go explicitly.
      // Everything else under a thread goes with it by cascade.
      await tx.scheduledEmail.deleteMany({ where: { userId: DEMO_USER_ID } });
      await tx.followUpReminder.deleteMany({ where: { userId: DEMO_USER_ID } });
      await tx.threatAppeal.deleteMany({ where: { userId: DEMO_USER_ID } });
      await tx.thread.deleteMany({ where: { mailAccountId: DEMO_MAIL_ACCOUNT_ID } });

      await tx.thread.createMany({ data: rows.threads });
      await tx.message.createMany({ data: rows.messages });
      await tx.attachment.createMany({ data: rows.attachments });
      await tx.aiClassification.createMany({ data: rows.classifications });
      await tx.aiSummary.createMany({ data: rows.summaries });
      await tx.translation.createMany({ data: rows.translations });
      await tx.scheduledEmail.createMany({ data: rows.scheduled });
      await tx.followUpReminder.createMany({ data: rows.reminders });
      return true;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );

  if (restored) {
    logger.info(
      {
        userId: DEMO_USER_ID,
        mailAccountId: DEMO_MAIL_ACCOUNT_ID,
        threads: rows.threads.length,
        messages: rows.messages.length,
      },
      "demo mailbox restored",
    );
  }
  return restored;
}

async function demoMailboxRestoredAt(): Promise<Date | null> {
  const row = await dbForUser(DEMO_USER_ID).mailAccount.findFirst({
    where: { id: DEMO_MAIL_ACCOUNT_ID },
    select: { lastSyncedAt: true },
  });
  return row?.lastSyncedAt ?? null;
}

let lastEnsuredAt = 0;
let ensuring: Promise<void> | null = null;

/**
 * Makes sure the demo mailbox exists and is not stale. Cheap after the first call in a
 * process: one timestamp comparison, then one indexed read a minute.
 *
 * The first call in a process applies the full new-session policy
 * (`startDemoSession`), not just "does it exist". On a free host a new process usually
 * means a cold start after at least a quarter of an hour with no traffic — so nobody is
 * mid-visit, and it is also the case where the visitor's own "Try the demo" call timed
 * out against a sleeping API and never got to restore anything.
 */
export async function ensureDemoMailbox(now: Date = new Date()): Promise<void> {
  if (now.getTime() - lastEnsuredAt < ENSURE_INTERVAL_MS) return;
  const firstInProcess = lastEnsuredAt === 0;
  ensuring ??= (async () => {
    try {
      if (firstInProcess) {
        await startDemoSession(now);
      } else {
        const restoredAt = await demoMailboxRestoredAt();
        if (
          restoredAt === null ||
          now.getTime() - restoredAt.getTime() > DEMO_STALE_AFTER_MS
        ) {
          await resetDemoMailbox(now);
        }
      }
      lastEnsuredAt = now.getTime();
    } finally {
      ensuring = null;
    }
  })();
  await ensuring;
}

/** Test hook. */
export function resetDemoMemo(): void {
  lastEnsuredAt = 0;
  ensuring = null;
}

/**
 * A new visitor pressed "Try the demo": give them the mailbox as seeded.
 *
 * Restores when a previous visitor changed something, or when the last restore is
 * older than `DEMO_RESTORE_AFTER_MS`. Otherwise the mailbox is already as seeded and
 * restoring it again would only disturb whoever else is looking at it.
 */
export async function startDemoSession(
  now: Date = new Date(),
): Promise<DemoSessionResponseDto> {
  const restoredAt = await demoMailboxRestoredAt();
  const changed = await demoChanged();
  const stale =
    restoredAt === null || now.getTime() - restoredAt.getTime() > DEMO_RESTORE_AFTER_MS;

  if (changed || stale) {
    const reset = await resetDemoMailbox(now);
    lastEnsuredAt = now.getTime();
    return { reset, seededAt: (reset ? now : (restoredAt ?? now)).toISOString() };
  }

  return { reset: false, seededAt: (restoredAt ?? now).toISOString() };
}

/* ── The "a visitor changed something" marker ──────────────────────────────────── */

/** Called by the routes that let a demo visitor change what the next one would see. */
export async function markDemoChanged(): Promise<void> {
  try {
    await connectRedis();
    await redis.set(CHANGED_KEY, String(Date.now()));
  } catch (error) {
    // Losing the marker costs one visitor a mailbox with somebody else's change in it,
    // for at most `DEMO_RESTORE_AFTER_MS`. Not worth failing their request over.
    logger.warn(
      { err: error, userId: DEMO_USER_ID },
      "could not mark the demo as changed",
    );
  }
}

/** True when the marker is set — or when Redis cannot say, which errs toward a restore. */
async function demoChanged(): Promise<boolean> {
  try {
    await connectRedis();
    return (await redis.exists(CHANGED_KEY)) === 1;
  } catch (error) {
    logger.warn({ err: error, userId: DEMO_USER_ID }, "could not read the demo marker");
    return true;
  }
}

async function clearDemoChanged(): Promise<void> {
  try {
    await connectRedis();
    await redis.del(CHANGED_KEY);
  } catch (error) {
    logger.warn({ err: error, userId: DEMO_USER_ID }, "could not clear the demo marker");
  }
}
