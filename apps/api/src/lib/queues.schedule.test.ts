import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_CHECK_INTERVAL_MS,
  QUEUE_NAMES,
  SCHEDULE_SEND_JOB_OPTIONS,
  SCHEDULE_SWEEP_INTERVAL_MS,
  followUpCheckJobSchema,
  scheduleSendJobId,
  scheduleSendJobSchema,
} from "./queues.js";

/**
 * Queue configuration for phase 10.
 *
 * These read like trivia and they are not: `attempts: 1` on the scheduled-send queue is
 * the phase-6 "do not retry a send whose outcome is unknown" rule, expressed as a
 * config value where nothing else can restate it. A well-meaning change to
 * `DEFAULT_JOB_OPTIONS`, or a refactor that drops the per-queue override, would silently
 * turn one ambiguous failure into five delivery attempts — and duplicated mail is the
 * one failure in this application that cannot be undone.
 */

describe("the scheduled-send queue", () => {
  it("gives a send exactly one attempt", () => {
    /*
     * A 429 or a 502 from a send does not say whether the message went out. Retrying is
     * a coin flip on whether the user's correspondent gets the same mail twice, and
     * `services/schedule.ts` therefore records FAILED and stops. This is the belt to
     * that braces: even if the service starts throwing, BullMQ will not try again.
     */
    expect(SCHEDULE_SEND_JOB_OPTIONS.attempts).toBe(1);
    expect(SCHEDULE_SEND_JOB_OPTIONS.backoff).toBeUndefined();
  });

  it("keeps failed jobs long enough to explain a missing send", () => {
    // "Why did my 9am mail not go out" has to be answerable a week later.
    const removeOnFail = SCHEDULE_SEND_JOB_OPTIONS.removeOnFail as { age: number };
    expect(removeOnFail.age).toBeGreaterThanOrEqual(7 * 24 * 3_600);
  });
});

describe("job ids", () => {
  it("contains no colon, which BullMQ reserves for its own keys", () => {
    // A custom job id with a colon is rejected outright: BullMQ builds Redis keys with
    // `:` as the separator.
    expect(scheduleSendJobId("cldd4kzai000108l3a1b2c3d4")).not.toContain(":");
  });

  it("is derived from the row id, so a re-queue collapses onto the same job", () => {
    /*
     * The dedup that matters here is against the *sweeper*: a row whose delayed job is
     * still in Redis gets swept, the enqueue lands on the same id, and nothing is
     * duplicated. The database `idempotencyKey` is the backstop below that.
     */
    expect(scheduleSendJobId("abc")).toBe(scheduleSendJobId("abc"));
    expect(scheduleSendJobId("abc")).not.toBe(scheduleSendJobId("def"));
  });
});

describe("payload schemas", () => {
  it("carries an id and a user, and no mail", () => {
    /*
     * The row is the source of truth, so the job says only *which* row. A payload
     * carrying the body would be a second copy of the mail, and the two could disagree
     * about whether it should still go out — which is exactly what happens when a user
     * cancels after the job was queued.
     */
    const parsed = scheduleSendJobSchema.parse({
      scheduledEmailId: "cldd4kzai000108l3a1b2c3d4",
      userId: "user_1",
      body: "this should be dropped",
      to: ["attacker@evil.example"],
    });

    expect(Object.keys(parsed).sort()).toEqual(["scheduledEmailId", "userId"]);
  });

  it("validates on the way in, because a job outlives the deploy that wrote it", () => {
    expect(() => scheduleSendJobSchema.parse({ userId: "user_1" })).toThrow();
    expect(() => followUpCheckJobSchema.parse({})).not.toThrow();
  });
});

describe("cadences", () => {
  it("sweeps for due sends every minute", () => {
    /*
     * Far more often than any other keeper in this app, and for a reason none of them
     * share: this is the only thing between a lost Redis job and mail that silently
     * never goes out at a time the user chose. A 9am send discovered at 9:01 is a
     * working feature; one discovered at 10am is not. The cost is one query on the
     * `(status, sendAt)` index that finds nothing almost every time.
     */
    expect(SCHEDULE_SWEEP_INTERVAL_MS).toBe(60_000);
  });

  it("checks follow-ups every quarter hour", () => {
    // The precision that matters is how fast a reminder *disappears* after a reply, and
    // the delta sync queues a check the moment it writes inbound mail. This is the floor
    // under that, not the mechanism.
    expect(FOLLOWUP_CHECK_INTERVAL_MS).toBe(15 * 60_000);
  });
});

describe("queue names", () => {
  it("names the follow-up queue as §9 does", () => {
    expect(QUEUE_NAMES.followupCheck).toBe("followup.check");
  });
});
