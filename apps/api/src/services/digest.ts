import { dbForUser } from "@inbox-copilot/db";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { sendAppEmail } from "../lib/resend.js";

/**
 * The follow-up digest (§9).
 *
 * **Resend is used here and nowhere else, and it never carries the user's own mail.**
 * That boundary is the point of putting the digest in its own file. The user's mail
 * goes out through `MailProvider.sendMessage`, from their own mailbox, with their own
 * authentication — a transactional email service is a fine way to tell somebody "three
 * threads are waiting" and a terrible way to send their correspondence, because it
 * would arrive from our domain, fail their recipients' DMARC alignment, and be
 * invisible in their own Sent folder.
 *
 * The rest of this file is about not being annoying:
 *
 *   - opt-in (`UserSettings.followUpDigest`, default false);
 *   - one row is mailed once (`digestSentAt`), so a reminder that stays unanswered for
 *     a week does not produce seven emails;
 *   - nothing to send means nothing sent, including no "you have 0 reminders" mail;
 *   - the body is **our** text plus subjects the user themselves wrote or received. It
 *     is escaped like any other untrusted content, because a subject line is
 *     sender-chosen and this is the one place we render one into HTML ourselves.
 */

/** Subjects per digest. Beyond this it is a list nobody reads. */
const MAX_ITEMS = 10;

/** HTML-escapes text for the digest body. Subjects are sender-chosen. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface DigestResult {
  sent: boolean;
  /** Why not, when not: "opt-out", "no-items", "no-address", "not-configured". */
  reason?: string;
  items?: number;
}

/**
 * Mails one user their overdue follow-ups, if they asked for that.
 *
 * Marks the rows *after* the send rather than before. The two failure modes are not
 * symmetrical: marking first and failing to send loses the digest silently, while
 * sending and failing to mark repeats it once — and a duplicate the user can see is
 * better than a gap they cannot.
 */
export async function sendFollowUpDigest(input: {
  userId: string;
  now?: Date;
}): Promise<DigestResult> {
  const now = input.now ?? new Date();
  const db = dbForUser(input.userId);

  const settings = await db.userSettings.findFirst({
    where: { userId: input.userId },
    select: { followUpDigest: true },
  });

  // Absent settings means the schema default, which is off. The digest is the one
  // feature here that mails a person, so "we could not tell" resolves to "do not".
  if (settings?.followUpDigest !== true) return { sent: false, reason: "opt-out" };

  const rows = await db.followUpReminder.findMany({
    where: {
      status: "TRIGGERED",
      dueAt: { lte: now },
      digestSentAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
    orderBy: { dueAt: "asc" },
    take: MAX_ITEMS,
    select: { id: true, dueAt: true, reason: true, thread: { select: { subject: true } } },
  });

  if (rows.length === 0) return { sent: false, reason: "no-items" };

  const user = await db.user.findFirst({
    where: { id: input.userId },
    select: { email: true, name: true },
  });

  if (!user?.email) {
    logger.warn({ userId: input.userId }, "digest is on but the account has no address");
    return { sent: false, reason: "no-address" };
  }

  const subject =
    rows.length === 1
      ? "1 message is still waiting for a reply"
      : `${rows.length} messages are still waiting for a reply`;

  const items = rows
    .map((row) => {
      const title = row.thread?.subject ?? row.reason ?? "(no subject)";
      const waitingDays = Math.max(
        0,
        Math.floor((now.getTime() - row.dueAt.getTime()) / (24 * 3_600_000)),
      );
      const waited =
        waitingDays === 0 ? "due today" : waitingDays === 1 ? "1 day overdue" : `${waitingDays} days overdue`;
      return `<li><strong>${escapeHtml(title)}</strong> — ${waited}</li>`;
    })
    .join("\n");

  const html = [
    `<p>You asked to be reminded about messages nobody has answered.</p>`,
    `<ul>`,
    items,
    `</ul>`,
    `<p><a href="${escapeHtml(env.WEB_APP_URL)}/follow-ups">Open your follow-ups</a></p>`,
    `<p style="color:#666;font-size:12px">You are getting this because follow-up digests are on in your settings. Turn them off there.</p>`,
  ].join("\n");

  const result = await sendAppEmail({
    to: user.email,
    subject,
    html,
    // A plain-text alternative, built from our own words rather than by stripping tags.
    text: `${subject}. Open ${env.WEB_APP_URL}/follow-ups to see them.`,
  });

  if (!result.sent) return { sent: false, reason: result.reason ?? "not-configured" };

  await db.followUpReminder.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { digestSentAt: now },
  });

  logger.info(
    { userId: input.userId, items: rows.length },
    "follow-up digest sent to the account address",
  );

  return { sent: true, items: rows.length };
}
