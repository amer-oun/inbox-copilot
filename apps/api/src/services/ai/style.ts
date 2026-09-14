import { dbForUser } from "@inbox-copilot/db";
import {
  aiWritingStyleSchema,
  type Formality,
  type WritingStyleDto,
} from "@inbox-copilot/shared";
import { aiStyleJobId, aiStyleQueue, type AiStyleJob } from "../../lib/queues.js";
import { logger } from "../../lib/logger.js";
import { callStructured } from "./client.js";
import { promptMetadata, truncateForPrompt, type MessageForPrompt } from "./content.js";
import { untrustedSentSamplesBlock, type WritingStyleForPrompt } from "./prompts.js";
import type { AiSettings } from "./usage.js";
import type { UntrustedEmailInput } from "./prompts.js";

/**
 * The writing-style profile (§5): sample the user's own sent mail, describe how they
 * write, and inject that description into every reply and compose prompt.
 *
 * §5 calls this the single biggest quality lever, and that matches what the output
 * looks like: without it a draft is competent and anonymous — recognisably a
 * chatbot's idea of an email. With it the draft opens the way the user opens, signs
 * off the way they sign off, and is as short as they usually are.
 *
 * Two halves, deliberately split by what each is good at:
 *
 *   - **Counted in code**: average sentence length and emoji use. These are exact
 *     measurements over the samples. Asking a model for a number a `split()` can
 *     compute is paying more for a worse answer.
 *   - **Judged by the model**: greeting, sign-off, register, and the free-form
 *     descriptor. These are pattern-recognition over inconsistent evidence, which
 *     is the thing a model is actually better at than a regex.
 */

/** §5 says ~30 sent messages. */
export const STYLE_SAMPLE_SIZE = 30;

/**
 * How many rows to read to find those 30. Most sent mail is short replies whose own
 * text is two lines under a quoted original, so the usable sample is a fraction of
 * what is stored.
 */
const STYLE_SCAN_SIZE = 150;

/**
 * Below this, there is no style to describe — three one-line replies would produce a
 * confident profile of nothing, which is worse than no profile because the reply
 * prompt would then follow it.
 */
export const STYLE_MIN_SAMPLES = 3;

/** Own text needed for a message to count as a sample. */
const MIN_SAMPLE_CHARS = 40;

/**
 * Per-sample ceiling. Thirty samples at this size is a large but bounded prompt, and
 * style is visible in the first paragraph — the twelfth is not paying for itself.
 */
const MAX_SAMPLE_CHARS = 1_200;

/** A profile older than this is rebuilt when something asks for one. */
export const STYLE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

const TOOL_NAME = "record_writing_style";
const TOOL_DESCRIPTION =
  "Record how the person who sent the messages in the sent_messages block writes. This is the only way to respond.";

/** Columns needed to sample sent mail. */
const SENT_SELECT = {
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
  mailAccount: { select: { emailAddress: true } },
} as const;

/**
 * Markers at which a reply stops being the user's own writing.
 *
 * Everything from the first match onwards is dropped. This matters for quality —
 * quoted text is somebody else's voice, and a profile built over it describes the
 * average of the user's correspondents — and for safety: a quoted original is
 * attacker-authored text, and this is the layer that keeps it out of the prompt that
 * shapes every future draft.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^\s*>/, // quoted line
  /^\s*On .{0,120}\bwrote:\s*$/i, // Gmail/Apple attribution
  /^\s*Le .{0,120}\ba écrit\s*:\s*$/i, // the French form of the same
  /^\s*-{2,}\s*(original message|forwarded message|message d'origine)/i,
  /^\s*_{5,}\s*$/, // Outlook's divider
  /^\s*From:\s.+@/i, // Outlook's quoted header block
  /^\s*De\s*:\s.+@/i,
  /^\s*(Sent|Envoyé)\s*(from|de)\b.{0,40}$/i, // "Sent from my iPhone"
];

/** A signature block begins here (RFC 3676's delimiter, and the loose form). */
const SIGNATURE_MARKER = /^\s*--\s*$/;

/**
 * The user's own words from a sent message: everything before the first quote
 * marker, minus a trailing signature block.
 *
 * The sign-off is *kept* — it is one of the fields being profiled — so the cut is at
 * `-- `, not at the last friendly line.
 */
export function stripQuotedText(text: string): string {
  const lines = text.split(/\r?\n/);
  const own: string[] = [];

  for (const line of lines) {
    if (QUOTE_MARKERS.some((marker) => marker.test(line))) break;
    if (SIGNATURE_MARKER.test(line)) break;
    own.push(line);
  }

  return own.join("\n").trim();
}

/** Average words per sentence, over all the samples. Rounded; 0 when unmeasurable. */
export function averageSentenceLength(texts: readonly string[]): number {
  let sentences = 0;
  let words = 0;

  for (const text of texts) {
    for (const part of text.split(/[.!?]+(?:\s|$)/)) {
      const count = part.trim().split(/\s+/).filter((word) => word.length > 0).length;
      // A one-word "fragment" is usually a list item or an abbreviation's leftovers,
      // not a sentence, and counting those would drag the average toward one.
      if (count < 2) continue;
      sentences += 1;
      words += count;
    }
  }

  return sentences === 0 ? 0 : Math.round(words / sentences);
}

/**
 * Whether this person uses emoji.
 *
 * `Extended_Pictographic` rather than a hand-listed range: the emoji a real person
 * uses are not confined to the block everyone remembers, and a false "no emoji"
 * would make every draft slightly more formal than the user is.
 */
export function usesEmoji(texts: readonly string[]): boolean {
  return texts.some((text) => /\p{Extended_Pictographic}/u.test(text));
}

interface Sample {
  own: string;
  block: UntrustedEmailInput;
}

/** Turns sent rows into samples, dropping the ones with too little of the user in them. */
function toSamples(
  rows: readonly (MessageForPrompt & { mailAccount: { emailAddress: string } })[],
): Sample[] {
  const samples: Sample[] = [];

  for (const row of rows) {
    if (samples.length >= STYLE_SAMPLE_SIZE) break;

    // Only the plain-text body. An HTML-only sent message would need converting, and
    // converted HTML brings layout artifacts that read as writing habits.
    const own = stripQuotedText(row.bodyText ?? "");
    if (own.length < MIN_SAMPLE_CHARS) continue;

    samples.push({
      own,
      block: {
        metadata: promptMetadata(row, row.mailAccount.emailAddress),
        body: truncateForPrompt(own, MAX_SAMPLE_CHARS),
      },
    });
  }

  return samples;
}

export interface BuildStyleInput {
  userId: string;
  settings?: AiSettings;
  signal?: AbortSignal;
  /** Rebuild even if the stored profile is recent. */
  force?: boolean;
}

export interface BuildStyleResult {
  style: WritingStyleDto | null;
  /** Set when no call was made: "fresh" | "too-few-samples". */
  skipped?: string;
  sampleCount: number;
}

/**
 * Builds (or refreshes) the profile.
 *
 * Runs after a backfill and on demand. A recent profile is not rebuilt unless asked:
 * this is a Sonnet call over thirty messages, and a person's writing does not change
 * between two syncs.
 */
export async function buildWritingStyle(
  input: BuildStyleInput,
): Promise<BuildStyleResult> {
  const log = logger.child({ userId: input.userId });
  const db = dbForUser(input.userId);

  const existing = await db.userWritingStyle.findFirst({ where: { userId: input.userId } });

  if (
    input.force !== true &&
    existing !== null &&
    existing.sampleCount >= STYLE_MIN_SAMPLES &&
    Date.now() - existing.updatedAt.getTime() < STYLE_MAX_AGE_MS
  ) {
    return { style: toDto(existing), skipped: "fresh", sampleCount: existing.sampleCount };
  }

  const rows = await db.message.findMany({
    where: { isOutbound: true, isDraft: false },
    orderBy: { sentAt: "desc" },
    take: STYLE_SCAN_SIZE,
    select: SENT_SELECT,
  });

  const samples = toSamples(
    rows as unknown as (MessageForPrompt & { mailAccount: { emailAddress: string } })[],
  );

  if (samples.length < STYLE_MIN_SAMPLES) {
    /*
     * Nothing is written in this case, not even a "we tried" row: the reply prompt
     * asks whether a profile exists, and an empty one that exists would be injected
     * as a description of a writer nobody has read.
     */
    log.info(
      { sentRowsScanned: rows.length, samples: samples.length },
      "not enough sent mail to profile a writing style",
    );
    return {
      style: existing === null ? null : toDto(existing),
      skipped: "too-few-samples",
      sampleCount: samples.length,
    };
  }

  const ownTexts = samples.map((sample) => sample.own);

  const { data, model } = await callStructured({
    userId: input.userId,
    feature: "style",
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    schema: aiWritingStyleSchema,
    userContent: untrustedSentSamplesBlock(samples.map((sample) => sample.block)),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    logContext: { samples: samples.length },
  });

  const fields = {
    // The model returns "" for "this person does not do this"; that is a real finding
    // and is stored as null rather than as an empty greeting to prepend.
    greeting: data.greeting.trim() === "" ? null : data.greeting,
    signOff: data.signOff.trim() === "" ? null : data.signOff,
    formality: data.formality,
    avgSentenceLen: averageSentenceLength(ownTexts),
    usesEmoji: usesEmoji(ownTexts),
    descriptor: data.descriptor,
    sampleCount: samples.length,
  };

  /*
   * `userId` is the unique key *and* the tenancy key, so this upsert is narrowed by
   * construction — unlike the path-scoped models, where the tenancy extension cannot
   * narrow a unique `where` and the ownership check has to come from a prior read.
   */
  const saved = await db.userWritingStyle.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, ...fields },
    update: fields,
  });

  log.info(
    {
      samples: samples.length,
      model,
      formality: fields.formality,
      avgSentenceLen: fields.avgSentenceLen,
      usesEmoji: fields.usesEmoji,
    },
    "writing style profile built",
  );

  return { style: toDto(saved), sampleCount: samples.length };
}

interface StyleRow {
  greeting: string | null;
  signOff: string | null;
  formality: string | null;
  avgSentenceLen: number | null;
  usesEmoji: boolean;
  descriptor: string | null;
  sampleCount: number;
  updatedAt: Date;
}

function toDto(row: StyleRow): WritingStyleDto {
  return {
    greeting: row.greeting,
    signOff: row.signOff,
    formality: asFormality(row.formality),
    avgSentenceLen: row.avgSentenceLen,
    usesEmoji: row.usesEmoji,
    descriptor: row.descriptor,
    sampleCount: row.sampleCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The column is a string (the schema predates the enum), so a value written by an
 * older build — or by hand — might not be one of the three. Unknown becomes null
 * rather than being passed through: the DTO promises the enum.
 */
function asFormality(value: string | null): Formality | null {
  return value === "casual" || value === "neutral" || value === "formal" ? value : null;
}

/**
 * The stored profile, in the shape the prompt builders want, or `null`.
 *
 * `null` is a first-class answer: a user with no sent mail yet gets drafts without a
 * style block rather than drafts told to imitate a writer we have never seen.
 */
export async function loadWritingStyle(
  userId: string,
): Promise<WritingStyleForPrompt | null> {
  const row = await dbForUser(userId).userWritingStyle.findFirst({
    where: { userId },
    select: {
      greeting: true,
      signOff: true,
      formality: true,
      avgSentenceLen: true,
      usesEmoji: true,
      descriptor: true,
      sampleCount: true,
    },
  });

  if (row === null || row.sampleCount < STYLE_MIN_SAMPLES) return null;
  return row;
}

/** The stored profile as a DTO, for `GET /writing-style`. */
export async function getWritingStyle(userId: string): Promise<WritingStyleDto | null> {
  const row = await dbForUser(userId).userWritingStyle.findFirst({
    where: { userId },
  });
  return row === null ? null : toDto(row);
}

/**
 * Queues a profile build for one user.
 *
 * Called when a backfill finishes, and by anything else that decides the profile is
 * due. Failures are logged, never thrown: a mailbox that synced correctly must not be
 * failed because Redis hiccuped on the follow-up, and the profile is a quality
 * improvement rather than a correctness requirement.
 *
 * The finished-job dance is the same one `enqueueEnrichment` needs, for the same
 * reason: BullMQ keeps completed jobs for a while, and silently refuses to re-add an
 * id it still holds — which would make the *second* backfill of a mailbox unable to
 * refresh a profile the first one built.
 */
export async function enqueueStyleProfile(input: {
  userId: string;
  force?: boolean;
}): Promise<boolean> {
  const log = logger.child({ userId: input.userId });

  try {
    const queue = aiStyleQueue();
    const jobId = aiStyleJobId(input.userId);
    const existing = await queue.getJob(jobId);

    if (existing) {
      const state = await existing.getState();
      if (state === "waiting" || state === "active" || state === "delayed") return false;
      await existing.remove();
    }

    await queue.add(
      "style",
      { userId: input.userId, ...(input.force === true ? { force: true } : {}) } satisfies AiStyleJob,
      { jobId },
    );
    return true;
  } catch (error) {
    log.error({ err: error }, "could not queue a writing style profile");
    return false;
  }
}
