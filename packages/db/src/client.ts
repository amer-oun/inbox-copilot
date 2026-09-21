/*
 * The generated client, from the explicit `output` in prisma/schema.prisma rather than
 * from `@prisma/client`. `@prisma/client` only re-exports a client generated into the
 * default `node_modules/.prisma/client`, which is the content-hashed pnpm path Next.js
 * could not trace onto a Vercel function. This package is the only importer either way —
 * everything else in the repo imports from `@inbox-copilot/db` — so the change stops here.
 */
import { PrismaClient } from "../generated/client/index.js";
import { tenancyExtension } from "./tenancy.js";

/**
 * Single PrismaClient per process. Cached on globalThis so dev hot-reload
 * doesn't exhaust the Postgres connection pool.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  return new PrismaClient({
    log: process.env["NODE_ENV"] === "production" ? ["warn", "error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * The only client request handlers should touch. Everything it returns is
 * already filtered to `userId` — see `tenancy.ts`.
 */
export function dbForUser(userId: string) {
  return prisma.$extends(tenancyExtension(userId));
}

export type TenantDb = ReturnType<typeof dbForUser>;

/** Cheap round-trip used by the health check. */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
