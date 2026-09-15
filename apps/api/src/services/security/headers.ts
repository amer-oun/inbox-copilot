import {
  authVerdictSchema,
  type AuthVerdict,
  type HeaderSignals,
} from "@inbox-copilot/shared";
import { registrableDomain } from "./urls.js";

/**
 * Layer 1 of §6: header truth.
 *
 * Free, deterministic, and the layer nothing can talk its way past — which is why it
 * runs first and why its output is what the model is later shown. Everything here
 * comes from `Message.authResults`, written at sync time by the provider's own parse
 * of the *receiving* server's `Authentication-Results` header. That provenance is the
 * whole value: a forged copy of that header can be added by anyone upstream, so only
 * the topmost one — the one our provider added — is read (see
 * `providers/gmail/map.ts`).
 *
 * The rule this file exists to keep: **a missing verdict is not a pass.** Phase 2
 * records "the header did not say" as `null`, and the temptation at this layer is to
 * treat null as benign because most mail with no DMARC verdict is fine. It is not
 * benign, it is *unknown*, and the difference matters precisely for the mail this
 * feature is for: a domain with no published policy is the easiest domain in the
 * world to forge.
 */

/**
 * The stored `authResults` JSON, read defensively.
 *
 * It is our own column, but it was shaped from sender-supplied headers and written by
 * an older build than the one reading it. A row that does not parse yields "nothing
 * known" — every verdict null, no alignment claims — which scores as unknown rather
 * than as safe.
 */
export interface StoredAuthResults {
  spf: AuthVerdict | null;
  dkim: AuthVerdict | null;
  dmarc: AuthVerdict | null;
  returnPath: string | null;
  displayNameMismatch: boolean;
}

const UNKNOWN_AUTH: StoredAuthResults = {
  spf: null,
  dkim: null,
  dmarc: null,
  returnPath: null,
  displayNameMismatch: false,
};

function asVerdict(value: unknown): AuthVerdict | null {
  const parsed = authVerdictSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseStoredAuthResults(value: unknown): StoredAuthResults {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...UNKNOWN_AUTH };
  }

  const row = value as Record<string, unknown>;
  return {
    spf: asVerdict(row["spf"]),
    dkim: asVerdict(row["dkim"]),
    dmarc: asVerdict(row["dmarc"]),
    returnPath: typeof row["returnPath"] === "string" ? row["returnPath"] : null,
    // Anything that is not exactly `true` is "we did not find a mismatch", not "the
    // name is fine": the check may not have run at all on an older row.
    displayNameMismatch: row["displayNameMismatch"] === true,
  };
}

/** The domain part of an address, lower-cased. Null for anything unparseable. */
export function domainOf(address: string | null | undefined): string | null {
  if (typeof address !== "string") return null;
  // A display name may itself contain an "@", so the last one wins — the same reason
  // `services/send.ts` splits on the last "<".
  const at = address.lastIndexOf("@");
  if (at === -1 || at === address.length - 1) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .replace(/[>\s,;]+$/, "")
    .toLowerCase();
  return domain === "" ? null : domain;
}

export interface HeaderSignalInput {
  authResults: unknown;
  fromEmail: string;
  replyTo: string | null;
}

/**
 * Reads layer 1 into signals.
 *
 * Alignment is compared on the *registrable* domain, not the full host:
 * `bounces.mail.stripe.com` and `stripe.com` are the same party, and a check that
 * called that a mismatch would flag every large sender's mail and teach the user to
 * ignore the banner. The same function is used for the link checks, so "same party"
 * means one thing in this codebase.
 */
export function headerSignals(input: HeaderSignalInput): HeaderSignals {
  const auth = parseStoredAuthResults(input.authResults);

  const fromDomain = registrableDomain(domainOf(input.fromEmail));
  const replyToDomain = registrableDomain(domainOf(input.replyTo));
  const returnPathDomain = registrableDomain(domainOf(auth.returnPath));

  return {
    fromDomain,
    spf: auth.spf,
    dkim: auth.dkim,
    dmarc: auth.dmarc,
    displayNameMismatch: auth.displayNameMismatch,
    replyToDomain,
    /*
     * A Reply-To at all is ordinary — mailing lists and ticketing systems set one.
     * What is worth a signal is a Reply-To pointing at a *different party* than the
     * From, because that is how a reply intended for a colleague reaches an attacker.
     */
    replyToDiffers:
      replyToDomain !== null && fromDomain !== null && replyToDomain !== fromDomain,
    returnPathDomain,
    /*
     * `null`, not `false`, when there is no Return-Path: the distinction is the point
     * of this layer. "The envelope sender does not match" is evidence; "we never saw
     * an envelope sender" is an absence, and the scoring treats the two differently.
     */
    returnPathAligned:
      returnPathDomain === null || fromDomain === null
        ? null
        : returnPathDomain === fromDomain,
  };
}

/**
 * Whether DMARC's own result makes the underlying SPF/DKIM results moot.
 *
 * DMARC passes when at least one of SPF and DKIM both passes *and* is aligned with
 * the From domain. So a `dmarc=pass` with `spf=fail` is a perfectly ordinary
 * forwarded-mail signature, and scoring that SPF failure would flag correctly
 * configured senders all day. The converse does not hold: a DMARC fail is never made
 * moot by anything.
 */
export function dmarcVouchesFor(signals: HeaderSignals): boolean {
  return signals.dmarc === "pass";
}
