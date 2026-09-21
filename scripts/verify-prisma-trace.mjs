#!/usr/bin/env node
// Checks that `next build` put the Prisma client and its native engine into the web app's
// file trace — the list of files Vercel copies into each serverless function.
//
//   pnpm verify:trace          (after pnpm build, or turbo run build --filter=…/web)
//
// This exists because the failure it catches is invisible until production. The build
// succeeds, `next start` works locally (the whole node_modules tree is right there), and
// the first request on Vercel throws:
//
//   PrismaClientInitializationError: Prisma Client could not locate the Query Engine
//
// Measured on this repo before the fix: 718 traced files, of which one came from
// packages/db (its package.json) and none from Prisma at all. After: 41 from packages/db,
// engine included. Run this after upgrading Next or Prisma, or after touching
// `outputFileTracingIncludes` / `serverExternalPackages` in apps/web/next.config.mjs.

import fs from "node:fs";
import path from "node:path";

const NEXT_DIR = path.join("apps", "web", ".next");

/**
 * Everything a deployed function needs from this workspace.
 *
 * The engine is the headline, but it is not the only way to be broken — and the two halves
 * fail differently, so both are named:
 *   - `generated/client/**` is the client Prisma wrote, plus the engine binary and the
 *     `runtime/` directory `index.js` requires.
 *   - `dist/**` is packages/db itself: the shared client instance and the tenancy
 *     extension every query goes through.
 */
const REQUIRED = [
  "packages/db/dist/index.js",
  "packages/db/dist/client.js",
  "packages/db/dist/tenancy.js",
  "packages/db/generated/client/index.js",
  "packages/db/generated/client/package.json",
  // Prisma reads this at startup to know which engine to look for.
  "packages/db/generated/client/schema.prisma",
  // Vercel's Node runtime. `native` would be the build machine's, which is not the same
  // thing even when it happens to match.
  "packages/db/generated/client/libquery_engine-rhel-openssl-3.0.x.so.node",
];

function traceFiles(dir) {
  const manifests = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".nft.json")) manifests.push(p);
    }
  };
  walk(dir);

  const traced = new Set();
  for (const manifest of manifests) {
    const { files } = JSON.parse(fs.readFileSync(manifest, "utf8"));
    for (const file of files) {
      // Trace entries are relative to the manifest; normalise to repo-relative, forward
      // slashes, so the check reads the same on Windows and on Linux.
      traced.add(
        path
          .normalize(path.join(path.dirname(manifest), file))
          .split(path.sep)
          .join("/"),
      );
    }
  }
  return { traced, manifests: manifests.length };
}

if (!fs.existsSync(NEXT_DIR)) {
  console.error(`No build found at ${NEXT_DIR}. Run a web build first:`);
  console.error("  pnpm turbo run build --filter=@inbox-copilot/web");
  process.exit(2);
}

const { traced, manifests } = traceFiles(NEXT_DIR);
const files = [...traced];
const missing = REQUIRED.filter((needle) => !files.some((f) => f.includes(needle)));

console.log(`${manifests} trace manifests, ${files.length} distinct traced files`);
console.log(
  `  from packages/db: ${files.filter((f) => f.includes("packages/db")).length}`,
);

for (const needle of REQUIRED) {
  console.log(`  ${missing.includes(needle) ? "MISSING" : "ok     "}  ${needle}`);
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} file(s) the deployed function needs are not in the trace.\n` +
      "The function will deploy and then fail at its first database query.\n" +
      "Check `outputFileTracingIncludes` in apps/web/next.config.mjs, and that\n" +
      "`prisma generate` ran (packages/db/generated/client should exist).",
  );
  process.exit(1);
}

console.log("\nPrisma client and engine are in the trace.");
