import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordMailAccountEvent } from "./mailAccountEvents.js";

/**
 * The audit writer.
 *
 * Small on purpose: the interesting behaviour is in *where* it is called from (inside the
 * transaction that changes the mailbox — see `providers/revocation.test.ts` and the
 * connect tests), and what it refuses to leave out.
 */

const create = vi.hoisted(() => vi.fn());

const writer = { mailAccountEvent: { create } };

beforeEach(() => {
  create.mockReset().mockResolvedValue({});
});

describe("recordMailAccountEvent", () => {
  it("writes every field the trail is for", async () => {
    await recordMailAccountEvent(writer, {
      kind: "DISCONNECTED",
      userId: "user_1",
      mailAccountId: "mail_1",
      provider: "GMAIL",
      emailAddress: "person@example.com",
      requestId: "req-1",
      grantRevoked: true,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        kind: "DISCONNECTED",
        userId: "user_1",
        mailAccountId: "mail_1",
        provider: "GMAIL",
        emailAddress: "person@example.com",
        requestId: "req-1",
        grantRevoked: true,
      },
    });
  });

  it("writes userId explicitly rather than relying on the tenancy extension", async () => {
    /*
     * It is called with a transaction client, and a transaction client is not the place to
     * discover whether the extension came along. The column is not nullable, so a missing
     * stamp would be a failed insert inside the transaction that deletes a mailbox.
     */
    await recordMailAccountEvent(writer, {
      kind: "CONNECTED",
      userId: "user_1",
      mailAccountId: "mail_1",
      provider: "GMAIL",
      emailAddress: "person@example.com",
    });

    expect(create.mock.calls[0]?.[0].data.userId).toBe("user_1");
  });

  it("normalizes an absent request id and revocation flag to null", async () => {
    // Explicit nulls rather than absent keys: "this did not come from a request" is a fact
    // the row should state, and an omitted column would read as an older write.
    await recordMailAccountEvent(writer, {
      kind: "CONNECTED",
      userId: "user_1",
      mailAccountId: "mail_1",
      provider: "GMAIL",
      emailAddress: "person@example.com",
    });

    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      requestId: null,
      grantRevoked: null,
    });
  });

  it("does not log, because it runs before the commit", async () => {
    /*
     * An earlier version logged from in here, and a live test caught it announcing a
     * disconnect that then rolled back. The log line belongs after the commit, where the
     * callers already write one with the same requestId.
     */
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./mailAccountEvents.ts", import.meta.url), "utf8"),
    );

    expect(source).not.toContain("logger.info");
    expect(source).not.toContain("../lib/logger.js");
  });

  it("does not swallow a write failure", async () => {
    /*
     * No try/catch, deliberately. The caller runs this inside the transaction that changes
     * the mailbox, so a throw rolls that change back — which is how "the record cannot be
     * skipped" is enforced rather than hoped for.
     */
    create.mockRejectedValue(new Error("insert failed"));

    await expect(
      recordMailAccountEvent(writer, {
        kind: "DISCONNECTED",
        userId: "user_1",
        mailAccountId: "mail_1",
        provider: "GMAIL",
        emailAddress: "person@example.com",
      }),
    ).rejects.toThrow(/insert failed/);
  });
});
