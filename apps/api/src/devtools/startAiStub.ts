import type { Server } from "node:http";
import { logger } from "../lib/logger.js";
import { resolveAiEndpoint, type AiEndpoint } from "../services/ai/endpoint.js";
import { AiStubPortInUseError, startAiStub } from "./aiStub.js";

/**
 * Entrypoint for the development AI stub: `pnpm --filter @inbox-copilot/api ai:stub`
 * (and part of `pnpm dev`).
 *
 * It starts **only when the stub is the endpoint the AI layer has actually resolved**,
 * and asks `resolveAiEndpoint` rather than re-deriving that from the environment. One
 * rule in one place: an earlier version here read `ANTHROPIC_API_KEY` directly, which
 * was right until `AI_PROVIDER` existed and then kept starting a canned-response server
 * next to every `pnpm dev` running on Gemini. Two answers to "where do AI calls go" is
 * how you end up unsure which one answered.
 *
 * A resolution that *throws* — `AI_PROVIDER=gemini` with no key, production with nothing
 * configured — is also not a reason to start: the stub is never the fix for a
 * misconfigured provider, and standing one up would turn a loud failure into canned
 * answers in a database.
 */

function resolveOrExit(): AiEndpoint {
  try {
    return resolveAiEndpoint();
  } catch (error) {
    logger.info(
      { reason: error instanceof Error ? error.message : String(error) },
      "ai stub not started: the AI provider is not configured",
    );
    process.exit(0);
  }
}

const endpoint = resolveOrExit();

if (!endpoint.stubbed) {
  logger.info(
    { provider: endpoint.provider, reason: endpoint.reason },
    "ai stub not started: AI calls go to a real provider",
  );
  process.exit(0);
}

let server: Server;
try {
  server = await startAiStub();
} catch (error) {
  if (error instanceof AiStubPortInUseError) {
    // Another stub already has the port, which is the outcome we wanted anyway.
    // Exiting 0 keeps `pnpm dev` alive: the api and worker do not care who answers.
    logger.info({ port: error.port }, "ai stub already running on this port; not starting a second");
    process.exit(0);
  }
  throw error;
}

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "ai stub shutting down");
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
