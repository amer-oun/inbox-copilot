import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/*
 * Importing `queueWorkers.js` pulls in the whole service graph, and with it the real
 * `lib/redis.js`, whose module body constructs an ioredis client. Nothing here needs one,
 * and leaving it to be constructed left a handle open that outlived the test worker —
 * which vitest reports as an unhandled `ERR_IPC_CHANNEL_CLOSED` long after every
 * assertion has passed. Mocked, so this file reads source and nothing else.
 */
vi.mock("./lib/redis.js", () => ({
  redis: {},
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  pingRedis: vi.fn(),
}));

const { QUEUE_NAMES } = await import("./lib/queues.js");
const { WORKER_QUEUES } = await import("./queueWorkers.js");

/**
 * One definition of the queue consumers, read off the source.
 *
 * `WORKER_IN_PROCESS` gives this app two places that can host the workers — the
 * dedicated `worker.ts` and, on a one-service host, `index.ts`. The thing that must not
 * happen is a second copy of the wiring, because of *how* two copies drift: a queue
 * added to one and not the other is work that is enqueued, accepted by a producer, and
 * then silently never run. Nothing throws and nothing logs.
 *
 * So these are source-reading tests, like the Resend one in `digest.test.ts`. They
 * cannot be satisfied by a mock, and they fail on the shape of the change rather than
 * on its behaviour — which is the point, since the behaviour they are protecting is an
 * absence.
 */

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("every queue has a consumer", () => {
  it("consumes every name in QUEUE_NAMES", () => {
    /*
     * The one that catches the realistic mistake: adding a queue, a schema and a
     * producer — and forgetting the consumer. A producer with no consumer is not an
     * error, it is a job that sits in Redis until it is swept away by `removeOnFail`.
     */
    expect([...WORKER_QUEUES].sort()).toEqual(Object.values(QUEUE_NAMES).sort());
  });
});

describe("both entrypoints use the same wiring", () => {
  it("builds workers in exactly one module", () => {
    // `new Worker(` is the tell. If it appears in an entrypoint, the wiring has been
    // copied rather than called.
    expect(source("./worker.ts")).not.toContain("new Worker(");
    expect(source("./index.ts")).not.toContain("new Worker(");
    expect(source("./queueWorkers.ts")).toContain("new Worker<");
  });

  it("has both entrypoints call startWorkers", () => {
    expect(source("./worker.ts")).toContain("startWorkers");
    expect(source("./index.ts")).toContain("startWorkers");
  });

  it("registers the repeatable schedulers only in the shared module", () => {
    /*
     * The four keepers — AI sweep, watch, scheduled-send sweeper, follow-up check — are
     * upserted where the workers are built, so a deployment that hosts the workers gets
     * the schedules and one that does not gets neither. Registering them in an
     * entrypoint instead would mean an API with `WORKER_IN_PROCESS=false` quietly
     * owning schedules it cannot serve.
     */
    for (const scheduler of [
      "scheduleAiSweep",
      "scheduleWatchKeeper",
      "scheduleSendSweeper",
      "scheduleFollowUpCheck",
    ]) {
      expect(source("./queueWorkers.ts")).toContain(scheduler);
      expect(source("./worker.ts")).not.toContain(scheduler);
      expect(source("./index.ts")).not.toContain(scheduler);
    }
  });

  it("leaves the shared module out of the lifecycle business", () => {
    /*
     * In-process, the HTTP server is still using Redis, the queue producers and the
     * database after the workers stop — so `startWorkers` must not close any of them,
     * and must not install a signal handler or call `process.exit`. Each entrypoint
     * owns what it opened.
     */
    const shared = source("./queueWorkers.ts");
    expect(shared).not.toContain("process.on(");
    expect(shared).not.toContain("process.exit(");
    expect(shared).not.toContain("disconnectRedis");
    expect(shared).not.toContain("disconnectDatabase");
    expect(shared).not.toContain("closeQueues");
  });

  it("gates the in-process workers on the env flag", () => {
    // Not on NODE_ENV, and not on a guess about the host: §1 still wants them apart,
    // and `pnpm dev` still runs them apart.
    expect(source("./index.ts")).toContain("env.WORKER_IN_PROCESS");
  });
});
