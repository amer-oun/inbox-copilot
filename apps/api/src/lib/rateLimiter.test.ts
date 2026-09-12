import { beforeEach, describe, expect, it } from "vitest";
import {
  BUCKET_CAPACITY_UNITS,
  GMAIL_QUOTA_UNITS,
  QUOTA_UNITS_PER_SECOND,
  RateLimiterAbortError,
  TokenBucket,
  acquireGmailQuota,
  bucketFor,
  resetRateLimiters,
} from "./rateLimiter.js";

/**
 * The bucket is the primary rate-limit defense, so these tests are about the
 * arithmetic (does a second of budget actually buy a second of calls) and about not
 * hanging: a waiter must be released by refill, and cancelled by an abort.
 *
 * Time is injected rather than waited on, except where a real release is the point.
 */

/** A bucket whose clock we control. */
function fakeClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("quota costs", () => {
  it("matches Gmail's published unit costs for the methods we call", () => {
    // A wrong number here silently over-spends the budget.
    expect(GMAIL_QUOTA_UNITS["users.threads.get"]).toBe(10);
    expect(GMAIL_QUOTA_UNITS["users.threads.list"]).toBe(10);
    expect(GMAIL_QUOTA_UNITS["users.getProfile"]).toBe(1);
    expect(GMAIL_QUOTA_UNITS["users.history.list"]).toBe(2);
  });

  it("leaves headroom under Gmail's 250 units/second per-user ceiling", () => {
    expect(QUOTA_UNITS_PER_SECOND).toBe(200);
    expect(QUOTA_UNITS_PER_SECOND).toBeLessThan(250);
  });
});

describe("TokenBucket", () => {
  it("serves calls immediately while budget remains", async () => {
    const bucket = new TokenBucket(200, 200, () => 0);

    // 20 thread fetches at 10 units each is exactly one second of budget.
    for (let i = 0; i < 20; i++) {
      await bucket.acquire(10);
    }
    expect(bucket.available).toBeCloseTo(0, 5);
  });

  it("makes the 21st thread fetch wait for a refill", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(200, 200, clock.now);

    for (let i = 0; i < 20; i++) await bucket.acquire(10);

    let served = false;
    const pending = bucket.acquire(10).then(() => {
      served = true;
    });

    // Nothing refills while the clock stands still.
    await Promise.resolve();
    expect(served).toBe(false);
    expect(bucket.queueLength).toBe(1);

    // 10 units at 200/sec is 50ms of waiting.
    clock.advance(60);
    await pending;
    expect(served).toBe(true);
  });

  it("refills proportionally to elapsed time and never above capacity", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(200, 200, clock.now);

    void bucket.acquire(200);
    expect(bucket.available).toBeCloseTo(0, 5);

    clock.advance(500); // half a second
    expect(bucket.available).toBeCloseTo(100, 5);

    clock.advance(10_000); // long idle
    expect(bucket.available).toBe(200);
  });

  it("serves waiters in order, so an expensive call is not starved by cheap ones", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(100, 100, clock.now);
    await bucket.acquire(100);

    const order: string[] = [];
    const expensive = bucket.acquire(50).then(() => order.push("expensive"));
    const cheap = bucket.acquire(1).then(() => order.push("cheap"));

    clock.advance(1_000);
    await Promise.all([expensive, cheap]);

    expect(order).toEqual(["expensive", "cheap"]);
  });

  it("rejects a request larger than the bucket rather than waiting forever", async () => {
    const bucket = new TokenBucket(200, 200);
    await expect(bucket.acquire(201)).rejects.toThrow(/exceeds bucket capacity/);
  });

  describe("cancellation", () => {
    it("rejects a queued waiter when its signal aborts", async () => {
      const clock = fakeClock();
      const bucket = new TokenBucket(200, 200, clock.now);
      await bucket.acquire(200);

      const controller = new AbortController();
      const pending = bucket.acquire(10, controller.signal);
      expect(bucket.queueLength).toBe(1);

      controller.abort();

      await expect(pending).rejects.toThrow(RateLimiterAbortError);
      // Removed from the queue, not left to consume budget later.
      expect(bucket.queueLength).toBe(0);
    });

    it("refuses immediately when the signal is already aborted", async () => {
      const bucket = new TokenBucket(200, 200);
      const controller = new AbortController();
      controller.abort();

      await expect(bucket.acquire(1, controller.signal)).rejects.toThrow(
        RateLimiterAbortError,
      );
      // No budget spent on a call that will never be made.
      expect(bucket.available).toBe(200);
    });

    it("still serves the next waiter after one is cancelled", async () => {
      const clock = fakeClock();
      const bucket = new TokenBucket(200, 200, clock.now);
      await bucket.acquire(200);

      const controller = new AbortController();
      const cancelled = bucket.acquire(10, controller.signal);
      const survivor = bucket.acquire(10);

      controller.abort();
      await expect(cancelled).rejects.toThrow(RateLimiterAbortError);

      clock.advance(100);
      await expect(survivor).resolves.toBeUndefined();
    });
  });
});

describe("acquireGmailQuota", () => {
  beforeEach(() => {
    resetRateLimiters();
  });

  it("shares one bucket across every call for a mailbox", async () => {
    await acquireGmailQuota("mail_1", "users.threads.get");
    await acquireGmailQuota("mail_1", "users.getProfile");

    // 10 + 1 spent from the same bucket, not from two.
    expect(bucketFor("mail_1").available).toBeCloseTo(BUCKET_CAPACITY_UNITS - 11, 0);
  });

  it("gives each mailbox its own budget", async () => {
    await acquireGmailQuota("mail_1", "users.threads.list");

    expect(bucketFor("mail_2").available).toBe(BUCKET_CAPACITY_UNITS);
  });

  it("spends the method's own cost", async () => {
    await acquireGmailQuota("mail_3", "users.history.list");

    expect(bucketFor("mail_3").available).toBeCloseTo(BUCKET_CAPACITY_UNITS - 2, 0);
  });

  it("propagates an abort instead of queueing indefinitely", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      acquireGmailQuota("mail_4", "users.threads.get", controller.signal),
    ).rejects.toThrow(RateLimiterAbortError);
  });
});
