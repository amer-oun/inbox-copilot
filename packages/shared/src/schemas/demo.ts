import { z } from "zod";

/**
 * The public demo: one shared, invented mailbox that anyone can open without Google.
 *
 * These constants are shared by web and api because the demo is recognized by *id*,
 * not by a flag somebody could set on a row. The web app mints its internal JWT with
 * a `demo` session claim; the API refuses any token whose claim and subject disagree
 * — a demo claim naming a real user, or a real claim naming the demo user — so the
 * two kinds of session cannot be confused in either direction.
 *
 * Every demo row id comes from `demoId`, which keeps them CUID-shaped (the routes
 * validate ids as such) and fixed across resets, so a link a visitor opened before a
 * reset still resolves afterwards.
 */

const DEMO_ID_WIDTH = 16;

/** `c` + `demo` + a four-letter kind + a zero-padded number: 25 characters, like a cuid. */
export function demoId(kind: string, n: number): string {
  if (!/^[a-z]{4}$/.test(kind))
    throw new Error(`demo id kind must be 4 letters: ${kind}`);
  if (!Number.isInteger(n) || n < 0) throw new Error(`demo id number must be >= 0: ${n}`);
  return `cdemo${kind}${n.toString().padStart(DEMO_ID_WIDTH, "0")}`;
}

export const DEMO_USER_ID = demoId("user", 1);
export const DEMO_MAIL_ACCOUNT_ID = demoId("acct", 1);

/**
 * The demo user's login email, on the reserved `.invalid` TLD (RFC 2606).
 *
 * Auth.js links accounts by email, so the demo user must have an address no Google
 * account can ever carry — otherwise someone signing in with it would land on the
 * shared mailbox.
 */
export const DEMO_USER_EMAIL = "demo@inbox-copilot.invalid";

/** The address the invented mailbox belongs to, as shown in the app. */
export const DEMO_MAILBOX_ADDRESS = "sam@northwind-freight.com";
export const DEMO_MAILBOX_NAME = "Sam Whitfield";

/**
 * The `model` recorded on AI output that was written in advance for the demo.
 *
 * The app promises that anything a model wrote names the model. The seeded summaries,
 * verdict explanations, translations and drafts were written by hand, so they carry
 * this instead of a real model id, and the UI says so in words.
 */
export const DEMO_SAMPLE_MODEL = "demo-sample";

export function isDemoUserId(userId: string): boolean {
  return userId === DEMO_USER_ID;
}

export function isDemoSampleModel(model: string | null | undefined): boolean {
  return model === DEMO_SAMPLE_MODEL;
}

/** Error codes the demo guards answer with, so the UI can phrase them as notices. */
export const DEMO_ERROR_CODES = {
  /** Sending, scheduling, connecting a mailbox: never available in the demo. */
  readOnly: "DEMO_READ_ONLY",
  /** A live model call the demo's budget cannot afford right now. */
  aiLimited: "DEMO_AI_LIMITED",
} as const;

export const demoSessionResponseSchema = z.object({
  /** True when this call restored the mailbox to its seeded state. */
  reset: z.boolean(),
  /** When the mailbox was last restored. */
  seededAt: z.iso.datetime(),
});
export type DemoSessionResponseDto = z.infer<typeof demoSessionResponseSchema>;
