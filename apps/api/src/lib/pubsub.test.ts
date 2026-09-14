import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeGmailNotification, expectedAudience } from "./pubsub.js";
import { env } from "./env.js";

/**
 * Decoding a push, and the audience it is checked against.
 *
 * Verification itself is exercised end to end against a mocked JWKS in
 * `routes/webhooks.test.ts`; what is here is the part with no network in it.
 */

function envelope(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      messageId: "pubsub-1",
    },
    subscription: "projects/p/subscriptions/s",
    ...overrides,
  };
}

beforeEach(() => {
  env.GMAIL_PUBSUB_AUDIENCE = "";
});

describe("expectedAudience", () => {
  it("defaults to the webhook's own URL", () => {
    // A deployment that forgets the variable still requires *an* audience rather than
    // accepting any token Google ever signed.
    expect(expectedAudience()).toBe(
      new URL("/webhooks/gmail", env.API_PUBLIC_URL).toString(),
    );
  });

  it("uses the configured value when there is one", () => {
    env.GMAIL_PUBSUB_AUDIENCE = "inbox-copilot-push";
    expect(expectedAudience()).toBe("inbox-copilot-push");
  });
});

describe("decodeGmailNotification", () => {
  it("reads the mailbox address and lower-cases it", () => {
    const decoded = decodeGmailNotification(
      envelope({ emailAddress: "Person@Example.com", historyId: 4242 }),
    );

    expect(decoded).toEqual({
      emailAddress: "person@example.com",
      claimedHistoryId: "4242",
      messageId: "pubsub-1",
    });
  });

  it("keeps the history id as a string whichever way it was sent", () => {
    // Gmail sends a number; some tooling replays it as a string. It is only ever logged,
    // so the one requirement is that it does not throw.
    expect(
      decodeGmailNotification(envelope({ emailAddress: "a@b.test", historyId: "99" }))
        ?.claimedHistoryId,
    ).toBe("99");
  });

  it("returns null for a body that is not a Pub/Sub envelope", () => {
    expect(decodeGmailNotification({ hello: "world" })).toBeNull();
    expect(decodeGmailNotification(null)).toBeNull();
    expect(decodeGmailNotification("string")).toBeNull();
  });

  it("returns null for a push with no data", () => {
    expect(decodeGmailNotification({ message: {} })).toBeNull();
    expect(decodeGmailNotification({ message: { data: "" } })).toBeNull();
  });

  it("returns null rather than throwing on undecodable data", () => {
    // Pub/Sub retries a failed delivery, so throwing here would be a retry loop over a
    // message that can never parse.
    expect(decodeGmailNotification({ message: { data: "!!!not base64!!!" } })).toBeNull();
  });

  it("returns null when the payload has no mailbox address", () => {
    expect(decodeGmailNotification(envelope({ historyId: 1 }))).toBeNull();
  });

  it("drops unknown fields instead of carrying them along", () => {
    /*
     * A push is a trigger. Anything beyond "which mailbox" has no business travelling
     * further into the application, so the schema does not pass it through.
     */
    const decoded = decodeGmailNotification(
      envelope({
        emailAddress: "a@b.test",
        historyId: 1,
        syncCursor: "9999999",
        userId: "somebody-else",
      }),
    );

    expect(Object.keys(decoded ?? {}).sort()).toEqual([
      "claimedHistoryId",
      "emailAddress",
      "messageId",
    ]);
  });

  it("survives a payload that is JSON but not an object", () => {
    expect(decodeGmailNotification(envelope("just a string"))).toBeNull();
    expect(decodeGmailNotification(envelope(42))).toBeNull();
  });
});

describe("what a hostile publisher can achieve", () => {
  it("cannot name a mailbox id, a user, or a cursor — only an address", () => {
    // Everything the decoder returns is either a lookup key or a log field. There is no
    // field here that reaches a write.
    const decoded = decodeGmailNotification(
      envelope({ emailAddress: "victim@example.com", historyId: 1 }),
    );

    expect(decoded?.emailAddress).toBe("victim@example.com");
    expect(decoded).not.toHaveProperty("mailAccountId");
    expect(decoded).not.toHaveProperty("userId");
    expect(decoded).not.toHaveProperty("syncCursor");
  });
});

describe("the mocked-free path", () => {
  it("does not touch the network when merely decoding", async () => {
    // Importing this module must not fetch Google's keys, so that a process which never
    // receives a push never reaches out.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    decodeGmailNotification(envelope({ emailAddress: "a@b.test" }));

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
