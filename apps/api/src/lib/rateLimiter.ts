import { logger } from "./logger.js";

/**
 * Per-mailbox token bucket sized in Gmail quota units.
 *
 * This is the *primary* defense against rate limiting: requests are paced so the
 * limit is not reached, rather than fired at full speed and retried after Gmail
 * rejects them. Retry (lib/retry.ts) is the fallback for the cases pacing cannot
 * predict — a shared-quota project, another process, a quota change.
 *
 * Gmail's published per-user ceiling is 250 quota units/second. The budget here is
 * deliberately below it: the headroom absorbs the user's other clients (their phone,
 * the Gmail web UI) which draw on the same per-user quota we do.
 *
 * Scope note: the bucket is in-process and keyed by mailbox. One worker process is
 * the current topology (§1), so that is the whole picture; running several workers
 * would need this moved behind Redis, because two processes would each think they
 * own the full budget.
 */

/** Units per second, per mailbox. Gmail allows 250; we spend 200. */
export const QUOTA_UNITS_PER_SECOND = 200;

/**
 * Burst ceiling. One second of budget: enough for a batch of thread fetches to
 * start immediately, not enough to empty a second's quota twice over.
 */
export const BUCKET_CAPACITY_UNITS = QUOTA_UNITS_PER_SECOND;

/**
 * Documented Gmail API quota costs. A wrong number here is a silent
 * over-spend, so they are listed explicitly rather than defaulted.
 */
export const GMAIL_QUOTA_UNITS = {
  "users.getProfile": 1,
  "users.history.list": 2,
  "users.threads.list": 10,
  "users.threads.get": 10,
  "users.messages.list": 5,
  "users.messages.get": 5,
  "users.messages.attachments.get": 5,
  "users.messages.modify": 5,
  "users.messages.send": 100,
  "users.drafts.create": 10,
  "users.watch": 100,
  "users.stop": 50,
} as const satisfies Record<string, number>;

export type GmailMethod = keyof typeof GMAIL_QUOTA_UNITS;

export class RateLimiterAbortError extends Error {
  constructor() {
    super("rate limiter wait aborted");
    this.name = "RateLimiterAbortError";
  }
}

interface Waiter {
  units: number;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * A single bucket. Refills continuously rather than on a timer tick: tokens are
 * computed from elapsed time, so there is no interval to leak and no drift.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly waiters: Waiter[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly capacity: number = BUCKET_CAPACITY_UNITS,
    private readonly refillPerSecond: number = QUOTA_UNITS_PER_SECOND,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  /** For tests and logging; not a decision input. */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  get queueLength(): number {
    return this.waiters.length;
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) return;

    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsedMs / 1_000) * this.refillPerSecond,
    );
    this.lastRefillMs = nowMs;
  }

  /**
   * Waits until `units` are available, then spends them.
   *
   * FIFO: a cheap call does not jump ahead of an expensive one that has been
   * waiting, or a `threads.get`-heavy backfill could starve behind a stream of
   * one-unit calls.
   */
  async acquire(units: number, signal?: AbortSignal): Promise<void> {
    if (units > this.capacity) {
      // Nothing could ever satisfy this; better a loud error than a permanent wait.
      throw new Error(
        `request of ${units} units exceeds bucket capacity of ${this.capacity}`,
      );
    }
    if (signal?.aborted) throw new RateLimiterAbortError();

    this.refill();

    if (this.waiters.length === 0 && this.tokens >= units) {
      this.tokens -= units;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { units, resolve, reject };

      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new RateLimiterAbortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this.waiters.push(waiter);
      this.schedule();
    });
  }

  /** Wakes waiters that can now be served, and arms a timer for the next one. */
  private drain(): void {
    this.refill();

    while (this.waiters.length > 0) {
      const next = this.waiters[0] as Waiter;
      if (this.tokens < next.units) break;

      this.waiters.shift();
      this.tokens -= next.units;
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.resolve();
    }

    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    const next = this.waiters[0];
    if (!next) return;

    const deficit = Math.max(0, next.units - this.tokens);
    const waitMs = Math.max(5, Math.ceil((deficit / this.refillPerSecond) * 1_000));

    /*
     * Deliberately NOT unref'd. A queued waiter is work in progress — a backfill
     * page waiting its turn — and if this timer did not hold the event loop open,
     * Node would consider the loop empty and exit with the wait unsettled, stopping
     * a sync silently. No waiters means no timer, so nothing is held open for free.
     */
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, waitMs);
  }
}

const buckets = new Map<string, TokenBucket>();

/** The bucket for one mailbox, created on first use. */
export function bucketFor(mailAccountId: string): TokenBucket {
  let bucket = buckets.get(mailAccountId);
  if (!bucket) {
    bucket = new TokenBucket();
    buckets.set(mailAccountId, bucket);
  }
  return bucket;
}

/**
 * Spends the quota cost of `method` for this mailbox, waiting if the budget is
 * currently exhausted. Every Gmail call goes through here before it is fired.
 */
export async function acquireGmailQuota(
  mailAccountId: string,
  method: GmailMethod,
  signal?: AbortSignal,
): Promise<void> {
  const bucket = bucketFor(mailAccountId);
  const units = GMAIL_QUOTA_UNITS[method];

  if (bucket.available < units) {
    logger.debug(
      { mailAccountId, method, units, queued: bucket.queueLength },
      "waiting on gmail quota budget",
    );
  }

  await bucket.acquire(units, signal);
}

/** Test hook: forget every bucket so one test cannot starve the next. */
export function resetRateLimiters(): void {
  buckets.clear();
}
