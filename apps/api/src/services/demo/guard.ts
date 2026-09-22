import { isDemoUserId } from "@inbox-copilot/shared";
import { DemoRestrictedError } from "../../lib/errors.js";

/**
 * The demo's hard line: nothing done as the demo user reaches a mail provider.
 *
 * Enforced three times, deliberately, because each layer can be bypassed by a
 * mistake in a different place:
 *
 *   1. **Routes** refuse the request (`middleware/demo.ts`), so the visitor gets a
 *      plain answer before any work is done.
 *   2. **Services** that send or schedule call this, so a new route that forgets the
 *      middleware still cannot send.
 *   3. **`mailProviderFor`** calls this too, so no code path at all can get a Gmail
 *      client for the demo mailbox. The demo mailbox also has no tokens, which would
 *      be a fourth wall — but an accidental one, and a failed token refresh marks a
 *      mailbox REVOKED, which is not the answer to give.
 *
 * Keyed on the user id rather than on the request, so it holds in the worker too:
 * a scheduled send has no request, only the user it belongs to.
 */

/** What each refusal says. Full sentences, because the UI shows them as they stand. */
export const DEMO_REFUSALS = {
  send: "Sending is disabled in the demo. Nothing was sent.",
  schedule: "Send later is disabled in the demo. Nothing was scheduled.",
  connect:
    "Connecting a mailbox is disabled in the demo. Gmail access is invite-only while Google reviews the app.",
  sync: "The demo mailbox is sample data, so there is nothing to sync.",
  disconnect: "The demo mailbox is sample data and cannot be disconnected.",
  compose: "Composing new mail is disabled in the demo.",
  writingStyle: "The demo's writing style is sample data and cannot be rebuilt.",
  provider: "The demo cannot reach a mail provider.",
} as const;

export type DemoRefusal = keyof typeof DEMO_REFUSALS;

export function assertNotDemo(userId: string, refusal: DemoRefusal): void {
  if (isDemoUserId(userId)) throw new DemoRestrictedError(DEMO_REFUSALS[refusal]);
}
