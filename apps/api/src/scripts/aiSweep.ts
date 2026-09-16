import { disconnectDatabase, prisma } from "@inbox-copilot/db";
import { logger } from "../lib/logger.js";
import { closeQueues } from "../lib/queues.js";
import { sweepAllEnrichment, sweepUserEnrichment } from "../services/ai/sweep.js";
import { resolveAiEndpoint } from "../services/ai/endpoint.js";
import { modelFor } from "../services/ai/models.js";

/**
 * Manual enrichment sweep: `pnpm ai:sweep [options]`.
 *
 * By default it finds *gaps* — messages with no classification, threads with no summary,
 * messages never assessed for phishing — and queues them on `ai.enrich`. That is the same
 * work the scheduled half-hourly sweep does.
 *
 *   pnpm ai:sweep                      every mailbox owner, up to the daily budget
 *   pnpm ai:sweep --email=me@x.com     one mailbox owner
 *   pnpm ai:sweep --limit=25           at most 25 messages per user
 *   pnpm ai:sweep --ignore-cap         ignore the remaining daily budget
 *   pnpm ai:sweep --force              re-run messages that ALREADY have rows
 *
 * **`--force` used to mean `--ignore-cap`.** It was renamed because the two overrides are
 * unrelated and a single flag covering both would make "re-assess my mailbox" quietly also
 * mean "and ignore the spend limit". Nothing else changed about the cap behaviour.
 *
 * `--force` is the answer to "the sweep finds nothing because every message already has a
 * stubbed classification". It inverts what the sweep looks for: instead of gaps it takes
 * every message, bypasses the content-hash cache, and **replaces** the existing
 * classification, threat verdict and thread summary. That is the one case rule 7 does not
 * cover — the cache is working exactly as designed, and the stored answer is simply not
 * the answer you want any more, typically because the provider changed.
 *
 * It requires `--email`, because a recompute is a deliberate act with a cost and "every
 * user in the database" is not something to do by accident.
 *
 * The worker must be running for the queued jobs to be processed.
 */

interface Options {
  email?: string;
  limit?: number;
  ignoreCap: boolean;
  force: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { ignoreCap: false, force: false };

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
      case "--ignore-cap":
        options.ignoreCap = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
        console.log(
          [
            "usage: pnpm ai:sweep [--email=someone@example.com] [--limit=N] [--ignore-cap] [--force]",
            "",
            "  --email        one mailbox owner instead of all of them",
            "  --limit=N      at most N messages per user",
            "  --ignore-cap   queue work even with no daily budget left",
            "  --force        re-run messages that already have rows, replacing them.",
            "                 Bypasses the content-hash cache. Requires --email.",
            "",
            "  Note: --force used to mean --ignore-cap. They are separate flags now.",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }

  if (options.force && options.email === undefined) {
    /*
     * A recompute spends a model call per message and overwrites rows, so it is scoped to
     * one person on purpose. Sweeping every user in the database for gaps is cheap and
     * idempotent; re-running every user's whole mailbox is neither.
     */
    throw new Error("--force needs --email=someone@example.com: it re-runs a whole mailbox");
  }

  return options;
}

/** What the recomputed rows will be written by, so the output is checkable afterwards. */
function providerSummary(): string {
  const endpoint = resolveAiEndpoint();
  const models = [
    modelFor("classify", endpoint.provider),
    modelFor("threat", endpoint.provider),
  ];
  return endpoint.stubbed
    ? `${endpoint.provider} (STUBBED — canned answers, ${endpoint.reason})`
    : `${endpoint.provider} (${[...new Set(models)].join(", ")})`;
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

    if (options.force) {
      /*
       * Said out loud before doing it. The rows about to be replaced are the only record
       * of what the previous model concluded, and "which provider wrote this" is the first
       * question about any row afterwards.
       */
      console.log(`Recomputing ${user.email} — existing rows will be REPLACED.`);
      console.log(`  new rows will be written by: ${providerSummary()}`);
    }

    const result = await sweepUserEnrichment({
      userId: user.id,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.ignoreCap ? { ignoreCap: true } : {}),
      ...(options.force ? { recompute: true } : {}),
    });

    console.log(
      `${user.email}: found ${result.found}, queued ${result.queued}` +
        (result.skipped ? ` (skipped: ${result.skipped})` : "") +
        (result.budget === undefined ? "" : `, budget left today ${result.budget}`),
    );

    if (result.recomputed === true) {
      if (result.remaining !== undefined && result.remaining > 0) {
        /*
         * The one thing a partial recompute must not do is look complete. `--limit`
         * defaults to the per-user ceiling, and a mailbox larger than that gets its newest
         * messages done first — so say how many are left rather than leaving the user to
         * wonder why half the inbox changed.
         */
        console.log(
          `\n${result.remaining} message(s) not queued this run (limit ${
            options.limit ?? "default"
          }, newest first).` +
            `\nRun again with --limit=${result.found + result.remaining} to take the rest.`,
        );
      }
      if (!options.ignoreCap && result.budget !== undefined && result.budget < result.found) {
        // The budget trims the batch before the queue sees it, so this is the difference
        // between "queued 200" and "200 will actually be classified".
        console.log(
          `\nThe daily cap will stop this run short: ${result.budget} call(s) left today` +
            ` for ${result.found} queued message(s). Add --ignore-cap to override it.`,
        );
      }
    }

    if (result.queued > 0) console.log("Run the worker (pnpm dev) to process them.");
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
