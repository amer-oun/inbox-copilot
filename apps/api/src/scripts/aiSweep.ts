import { disconnectDatabase, prisma } from "@inbox-copilot/db";
import { logger } from "../lib/logger.js";
import { closeQueues } from "../lib/queues.js";
import { sweepAllEnrichment, sweepUserEnrichment } from "../services/ai/sweep.js";

/**
 * Manual enrichment sweep: `pnpm ai:sweep [options]`.
 *
 * Finds messages with no AI classification and queues them on `ai.enrich`. This is
 * the same work the scheduled half-hourly sweep does; run it directly to enrich a
 * mailbox that synced before the AI layer existed, or to pick up messages a spent
 * daily cap skipped without waiting for the schedule.
 *
 *   pnpm ai:sweep                      every mailbox owner, up to the daily budget
 *   pnpm ai:sweep --email=me@x.com     one mailbox owner
 *   pnpm ai:sweep --limit=25           at most 25 messages per user
 *   pnpm ai:sweep --force              ignore the remaining daily budget
 *
 * The worker must be running for the queued jobs to be processed.
 */

interface Options {
  email?: string;
  limit?: number;
  force: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { force: false };

  for (const arg of argv) {
    const [flag, value] = arg.split("=");
    switch (flag) {
      case "--email":
        if (value) options.email = value;
        break;
      case "--limit": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`--limit must be a positive integer, got "${value ?? ""}"`);
        }
        options.limit = parsed;
        break;
      }
      case "--force":
        options.force = true;
        break;
      case "--help":
        console.log(
          "usage: pnpm ai:sweep [--email=someone@example.com] [--limit=N] [--force]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.email !== undefined) {
    // The one lookup by address: everything after this is scoped to the user id.
    const user = await prisma.user.findUnique({
      where: { email: options.email },
      select: { id: true, email: true },
    });
    if (!user) throw new Error(`no user with email ${options.email}`);

    const result = await sweepUserEnrichment({
      userId: user.id,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.force ? { force: true } : {}),
    });
    console.log(
      `${user.email}: found ${result.found}, queued ${result.queued}` +
        (result.skipped ? ` (skipped: ${result.skipped})` : "") +
        (result.budget === undefined ? "" : `, budget left today ${result.budget}`),
    );
    return;
  }

  const results = await sweepAllEnrichment(
    options.limit === undefined ? {} : { perUserLimit: options.limit },
  );

  if (results.length === 0) {
    console.log("no mailbox owners to sweep");
    return;
  }
  for (const result of results) {
    console.log(
      `${result.userId}: found ${result.found}, queued ${result.queued}` +
        (result.skipped ? ` (skipped: ${result.skipped})` : ""),
    );
  }
  const queued = results.reduce((sum, result) => sum + result.queued, 0);
  console.log(`\n${queued} enrichment job(s) queued across ${results.length} user(s).`);
  if (queued > 0) console.log("Run the worker (pnpm dev) to process them.");
}

try {
  await main();
} catch (error) {
  logger.error({ err: error }, "ai sweep failed");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([closeQueues(), disconnectDatabase()]);
}
