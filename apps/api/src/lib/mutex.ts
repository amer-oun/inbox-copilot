import { randomBytes } from "node:crypto";
import { redis } from "./redis.js";
import { logger } from "./logger.js";
import { AbortedError } from "./retry.js";

/**
 * Single-instance Redis mutex (SET NX PX + fenced release).
 *
 * Used to serialize work that must not happen twice at once:
 *   - OAuth token refreshes. Microsoft rotates the refresh token on every use, so
 *     two concurrent refreshes for one mailbox invalidate each other and the
 *     mailbox ends up needing a manual reconnect.
 *   - thread summarization. Two messages of one thread enrich concurrently, both
 *     miss the content-hash cache because neither has written yet, and one of the
 *     two Sonnet calls is pure waste.
 *
 * The lock value is a random token and release is a compare-and-delete Lua
 * script, so a process whose lock already expired cannot delete someone else's.
 * This is not Redlock — one Redis, so it is only as available as that Redis.
 */

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface MutexOptions {
  /** Lock lifetime. Must exceed the worst-case critical section. */
  ttlMs?: number;
  /** How long to wait for the holder before giving up. */
  waitMs?: number;
  /** Poll interval while waiting. */
  retryDelayMs?: number;
  /** Abandons the wait when the work is cancelled (a retried or killed job). */
  signal?: AbortSignal;
}

export class MutexTimeoutError extends Error {
  constructor(key: string, waitMs: number) {
    super(`timed out after ${waitMs}ms waiting for lock "${key}"`);
    this.name = "MutexTimeoutError";
  }
}

/**
 * Abortable poll delay. A cancelled job must stop waiting for a lock it no longer
 * needs, rather than holding a worker slot until the wait deadline.
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError("mutex wait aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError("mutex wait aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Runs `fn` while holding `key`. Waiters that acquire the lock after the holder
 * finishes must re-read state — the work they were queued for may already be
 * done (that is exactly the token-refresh case).
 */
export async function withMutex<T>(
  key: string,
  fn: () => Promise<T>,
  options: MutexOptions = {},
): Promise<T> {
  const ttlMs = options.ttlMs ?? 15_000;
  const waitMs = options.waitMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 100;

  const lockKey = `mutex:${key}`;
  const token = randomBytes(16).toString("base64url");
  const deadline = Date.now() + waitMs;

  for (;;) {
    if (options.signal?.aborted) throw new AbortedError("mutex wait aborted");

    const acquired = await redis.set(lockKey, token, "PX", ttlMs, "NX");
    if (acquired === "OK") break;
    if (Date.now() >= deadline) throw new MutexTimeoutError(key, waitMs);
    await sleep(retryDelayMs, options.signal);
  }

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE_SCRIPT, 1, lockKey, token);
    } catch (error) {
      // A failed release is survivable — the TTL expires it. Losing the
      // caller's result or error to a Redis blip is not.
      logger.warn({ err: error, lockKey }, "failed to release mutex; relying on ttl");
    }
  }
}
