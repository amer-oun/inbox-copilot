import { disconnectDatabase } from "@inbox-copilot/db";
import { logger } from "../lib/logger.js";
import { disconnectRedis } from "../lib/redis.js";
import { resetDemoMailbox } from "../services/demo/seed.js";

/**
 * Restore the demo mailbox now: `pnpm demo:seed`.
 *
 * Optional. The API seeds the demo on the first demo request in each process
 * (`ensureDemoMailbox`), so a deployment needs no seed step. This is for looking at
 * the seeded data in `pnpm db:studio` without starting the app, and for putting the
 * mailbox back by hand after experimenting with it.
 *
 * It writes only the demo user's rows (services/demo/seed.ts), and it works whether or
 * not `DEMO_MODE` is on — the flag decides whether anyone may *sign in* to the demo,
 * not whether its rows may exist.
 */
async function main(): Promise<void> {
  const restored = await resetDemoMailbox();
  logger.info(
    { restored },
    restored ? "demo mailbox restored" : "another restore held the lock; nothing done",
  );
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, "demo seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectRedis().catch(() => undefined);
    await disconnectDatabase();
  });
