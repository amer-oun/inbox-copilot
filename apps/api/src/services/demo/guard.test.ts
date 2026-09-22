import { describe, expect, it, vi } from "vitest";
import { DEMO_USER_ID } from "@inbox-copilot/shared";

/**
 * The two walls under the route guard (see guard.ts): the send service, and the one
 * function every provider call goes through. Each is tested on its own, without the
 * route in front, because a route that forgets `refuseDemo` is the case they exist for.
 */

const threadFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({ thread: { findFirst: threadFindFirst } }),
  prisma: {},
}));

const { assertNotDemo, DEMO_REFUSALS } = await import("./guard.js");
const { mailProviderFor } = await import("../../providers/registry.js");
const { sendReply } = await import("../send.js");
const { DemoRestrictedError } = await import("../../lib/errors.js");

const REAL_USER = "cldd4kzai000008l3a1b2c3d4";
const THREAD_ID = "cdemothrd0000000000000001";

describe("assertNotDemo", () => {
  it("refuses the demo user with the refusal's own sentence", () => {
    expect(() => assertNotDemo(DEMO_USER_ID, "send")).toThrow(DemoRestrictedError);
    expect(() => assertNotDemo(DEMO_USER_ID, "send")).toThrow(DEMO_REFUSALS.send);
  });

  it("lets every other user through", () => {
    expect(() => assertNotDemo(REAL_USER, "send")).not.toThrow();
  });

  it("answers 403 with the code the UI shows as a notice", () => {
    try {
      assertNotDemo(DEMO_USER_ID, "schedule");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 403, code: "DEMO_READ_ONLY" });
    }
  });
});

describe("mailProviderFor", () => {
  it("never builds a provider client for the demo mailbox", () => {
    expect(() =>
      mailProviderFor("GMAIL", {
        mailAccountId: "cdemoacct0000000000000001",
        userId: DEMO_USER_ID,
        emailAddress: "sam@northwind-freight.com",
      }),
    ).toThrow(DemoRestrictedError);
  });
});

describe("sendReply", () => {
  it("refuses the demo user before reading anything", async () => {
    await expect(
      sendReply({
        userId: DEMO_USER_ID,
        threadId: THREAD_ID,
        body: "Signed and attached.",
        expectsReply: false,
      }),
    ).rejects.toBeInstanceOf(DemoRestrictedError);

    expect(threadFindFirst).not.toHaveBeenCalled();
  });
});
