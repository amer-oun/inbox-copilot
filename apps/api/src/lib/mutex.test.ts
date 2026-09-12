import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Redis mutex, against a fake Redis that models the parts that matter: `SET NX`
 * fails while a key is held, and the release script only deletes a matching token.
 *
 * The fencing is the point of the Lua release: a holder whose lock already expired
 * must not delete the lock its successor now holds. That is asserted directly here,
 * because the failure mode — two token refreshes, or two summaries, believing they
 * are alone — is invisible until it corrupts something.
 */

const store = vi.hoisted(() => new Map<string, string>());

const redisMock = vi.hoisted(() => ({
  set: vi.fn(
    async (key: string, value: string, _px: string, _ttl: number, nx: string) => {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
  ),
  eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
    if (store.get(key) === token) {
      store.delete(key);
      return 1;
    }
    return 0;
  }),
}));

vi.mock("./redis.js", () => ({ redis: redisMock }));

const { MutexTimeoutError, withMutex } = await import("./mutex.js");
const { AbortedError } = await import("./retry.js");

beforeEach(() => {
  store.clear();
  redisMock.set.mockClear();
  redisMock.eval.mockClear();
});

describe("withMutex", () => {
  it("runs the function and releases the lock", async () => {
    const result = await withMutex("thing", async () => "done");

    expect(result).toBe("done");
    expect(store.size).toBe(0);
  });

  it("releases the lock when the function throws", async () => {
    await expect(withMutex("thing", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(store.size).toBe(0);
  });

  it("serializes two callers on the same key", async () => {
    const order: string[] = [];

    await Promise.all([
      withMutex("same", async () => {
        order.push("first-in");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("first-out");
      }, { retryDelayMs: 1 }),
      withMutex("same", async () => {
        order.push("second-in");
      }, { retryDelayMs: 1 }),
    ]);

    // The second body cannot start before the first finished.
    expect(order).toEqual(["first-in", "first-out", "second-in"]);
  });

  it("does not serialize different keys", async () => {
    const inside: string[] = [];

    await Promise.all([
      withMutex("a", async () => {
        inside.push("a-in");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
      withMutex("b", async () => {
        inside.push("b-in");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
    ]);

    expect(inside).toEqual(["a-in", "b-in"]);
  });

  it("times out rather than waiting forever", async () => {
    store.set("mutex:held", "someone-else");

    await expect(
      withMutex("held", async () => "never", { waitMs: 20, retryDelayMs: 5 }),
    ).rejects.toThrow(MutexTimeoutError);
  });

  it("only deletes its own lock", async () => {
    // The holder's lock expired and a successor took it: releasing must be a no-op.
    await withMutex("fenced", async () => {
      store.set("mutex:fenced", "successor-token");
    });

    expect(store.get("mutex:fenced")).toBe("successor-token");
  });

  it("survives a failed release, leaving the ttl to clean up", async () => {
    redisMock.eval.mockRejectedValueOnce(new Error("redis gone"));

    // The caller's result matters more than the release.
    await expect(withMutex("thing", async () => "kept")).resolves.toBe("kept");
  });
});

describe("withMutex cancellation", () => {
  it("does not acquire when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn();

    await expect(withMutex("thing", fn, { signal: controller.signal })).rejects.toThrow(
      AbortedError,
    );
    expect(fn).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("stops waiting when the signal aborts mid-wait", async () => {
    // A retried or killed job must release its worker slot rather than sitting out
    // the full wait for a lock it no longer needs.
    store.set("mutex:busy", "someone-else");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const started = Date.now();
    await expect(
      withMutex("busy", async () => "never", {
        waitMs: 5_000,
        retryDelayMs: 5,
        signal: controller.signal,
      }),
    ).rejects.toThrow(AbortedError);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still runs when the signal never fires", async () => {
    const controller = new AbortController();
    await expect(
      withMutex("thing", async () => "ok", { signal: controller.signal }),
    ).resolves.toBe("ok");
  });
});
