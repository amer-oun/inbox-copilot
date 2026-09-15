import type { Prisma } from "@inbox-copilot/db";

/**
 * The mailbox audit trail.
 *
 * One mailbox once disappeared with nothing left to say what removed it: the only
 * evidence was a log line on stdout, and stdout does not survive the process. These rows
 * do, and they survive the mailbox too — `MailAccountEvent` has no foreign key to
 * `MailAccount`, so the disconnect record is not deleted by the delete it documents.
 *
 * Two rules about how it is written, both of which are the difference between an audit
 * trail and a decoration:
 *
 *   1. **In the same transaction as the change.** A record written after a successful
 *      delete is a record that is missing exactly when the process died mid-delete —
 *      which is one of the cases you go looking for it. So the caller passes a
 *      transaction client and the row goes in with the write.
 *   2. **It does not fail the operation, and it cannot be skipped either.** Those sound
 *      contradictory and the resolution is the transaction: there is no `try/catch`
 *      around the insert, so a failure rolls back the whole thing. A disconnect that
 *      could not be recorded does not happen. That is the right trade for an operation a
 *      user can simply repeat.
 *
 * `requestId` correlates the row with the API log lines for the same request
 * (`lib/requestId.ts`). Null means it did not come from one.
 */

/** The minimum shape this needs: a client, transactional or not. */
type Writer = {
  mailAccountEvent: {
    create: (args: { data: Prisma.MailAccountEventUncheckedCreateInput }) => Promise<unknown>;
  };
};

export interface MailAccountEventInput {
  kind: "CONNECTED" | "RECONNECTED" | "DISCONNECTED";
  userId: string;
  mailAccountId: string;
  provider: "GMAIL" | "OUTLOOK";
  emailAddress: string;
  requestId?: string | null;
  /** Disconnect only: whether the grant was actually revoked at the provider. */
  grantRevoked?: boolean | null;
}

/**
 * Records one lifecycle event.
 *
 * `userId` is written explicitly as well as being stamped by the tenancy extension: this
 * is called with a transaction client, and a transaction client is not the place to find
 * out whether the extension came along for the ride.
 */
export async function recordMailAccountEvent(
  db: Writer,
  input: MailAccountEventInput,
): Promise<void> {
  await db.mailAccountEvent.create({
    data: {
      kind: input.kind,
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      provider: input.provider,
      emailAddress: input.emailAddress,
      requestId: input.requestId ?? null,
      grantRevoked: input.grantRevoked ?? null,
    },
  });
}

/*
 * Note what this function does *not* do: log.
 *
 * It ran inside the transaction, and an earlier version logged "mailbox disconnected"
 * from in here — which a live test caught announcing a disconnect that then rolled back.
 * The log line for a lifecycle change belongs after the commit, where the callers in
 * `services/mailAccounts.ts` already write one carrying the same `requestId`. The row is
 * the record that survives; the line is only for whoever is watching.
 */
