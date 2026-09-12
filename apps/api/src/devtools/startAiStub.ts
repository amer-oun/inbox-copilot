import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { startAiStub } from "./aiStub.js";

/**
 * Entrypoint for the development AI stub: `pnpm --filter @inbox-copilot/api ai:stub`
 * (and part of `pnpm dev`).
 *
 * It exits immediately when a real key is configured without a base URL pointing
 * here — running a canned-response server next to a real one is how you end up
 * unsure which answered.
 */

const stubUrl = `http://127.0.0.1:${env.AI_STUB_PORT}`;

if (env.ANTHROPIC_API_KEY !== "" && env.ANTHROPIC_BASE_URL !== stubUrl) {
  logger.info(
    { baseURL: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com" },
    "ai stub not started: a real ANTHROPIC_API_KEY is configured",
  );
  process.exit(0);
}

const server = await startAiStub();

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "ai stub shutting down");
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
