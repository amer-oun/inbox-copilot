#!/usr/bin/env node
// Copies the Prisma query engine and schema into apps/web, where Prisma will look for them
// at runtime on Vercel. Runs as the first step of the web app's build.
//
//   node scripts/copy-prisma-engine.mjs
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────
//
// Read the generated client's own resolution, from `packages/db/generated/client/index.js`:
//
//     config.dirname = __dirname
//     if (!fs.existsSync(path.join(__dirname, 'schema.prisma'))) {
//       const alternativePaths = ["generated/client", "client"]
//       const alternativePath = alternativePaths.find((altPath) =>
//         fs.existsSync(path.join(process.cwd(), altPath, 'schema.prisma'))
//       ) ?? alternativePaths[0]
//       config.dirname = path.join(process.cwd(), alternativePath)
//       config.isBundled = true
//     }
//
// Next.js **bundles** this client into a server chunk — `serverExternalPackages` names
// packages, and `packages/db` reaches its client by a relative path, which is not a package
// specifier. Once bundled there is no `schema.prisma` beside the code, so the branch above
// fires and Prisma looks for the engine under `process.cwd()` instead. In a Vercel function
// the working directory is the project directory, so the path it wants is:
//
//     /var/task/apps/web/generated/client
//
// The engine that `prisma generate` produced is at `packages/db/generated/client`, which in
// the deployed function is `/var/task/packages/db/generated/client` — present, and never
// looked at. The third path in Prisma's "locations searched" list is the *build machine's*
// absolute path (`/vercel/path0/packages/db/generated/client`), baked in at generate time
// and gone by the time the function runs. That is the whole error.
//
// So this copies the two files Prisma needs — the schema it checks for and the engine
// binary it loads — into `apps/web/generated/client`, and `outputFileTracingIncludes` in
// `apps/web/next.config.mjs` ships that directory with the function.
//
// Verified by reproducing the deployed layout locally: a bundled client with its data files
// stripped, the build-time directory moved out of the way, and `process.cwd()` set to a fake
// `apps/web`. Without this copy the probe reproduces the production error and its list of
// searched locations exactly; with it, the query runs.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "packages", "db", "generated", "client");
const destination = join(repoRoot, "apps", "web", "generated", "client");

/** Vercel's Node runtime. Named so a missing one is a warning rather than a surprise. */
const RUNTIME_ENGINE = "libquery_engine-rhel-openssl-3.0.x.so.node";

/** What Prisma reads from `config.dirname`: the schema it probes for, and the engine. */
function isNeeded(name) {
  return name === "schema.prisma" || name.endsWith(".node");
}

if (!existsSync(source)) {
  console.error(
    `Prisma client not found at ${source}.\n` +
      "Run `prisma generate` first — `pnpm turbo run build --filter=@inbox-copilot/web`\n" +
      "does it as part of building packages/db.",
  );
  process.exit(1);
}

const wanted = readdirSync(source).filter(isNeeded);
const engines = wanted.filter((name) => name.endsWith(".node"));

if (engines.length === 0) {
  console.error(
    `No query engine in ${source}.\n` +
      "`binaryTargets` in packages/db/prisma/schema.prisma decides which are built.",
  );
  process.exit(1);
}

// Replaced wholesale rather than merged: a stale engine from a previous Prisma version is
// worse than none, because it loads and then disagrees with the schema.
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

let bytes = 0;
for (const name of wanted) {
  cpSync(join(source, name), join(destination, name));
  bytes += statSync(join(source, name)).size;
}

const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(
  `prisma: copied ${wanted.length} files (${mb} MB) to apps/web/generated/client`,
);
console.log(`prisma: engines ${engines.join(", ")}`);

if (!engines.includes(RUNTIME_ENGINE)) {
  // Not fatal: a laptop build only needs its own engine, and this script also runs for
  // `pnpm dev`. On Vercel the Linux build produces this one as `native` anyway.
  console.warn(
    `prisma: warning — ${RUNTIME_ENGINE} is not among them.\n` +
      "prisma: a build for Vercel needs it; check `binaryTargets` in the schema.",
  );
}
