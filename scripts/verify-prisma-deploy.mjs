#!/usr/bin/env node
// Checks that a built web app will actually find Prisma's query engine when deployed.
//
//   pnpm verify:prisma     (after a web build)
//
// This replaced a script that checked the wrong thing. That one asserted the engine appeared
// in Next's file trace, it passed, and the deploy still failed — because being *shipped* and
// being *where Prisma looks* are different questions, and only the second one matters. The
// engine was present at `/var/task/packages/db/generated/client` and Prisma searched
// `/var/task/apps/web/generated/client`, `/var/task/apps/web/.next/server`, and the dead
// build path `/vercel/path0/packages/db/generated/client`.
//
// So the check below is ordered by what the runtime actually does:
//
//   1. the copy exists at apps/web/generated/client — the path a bundled client falls back
//      to, under `process.cwd()`, which in a Vercel function is the project directory;
//   2. that path is in the trace, so it is deployed rather than merely built;
//   3. the packages/db copy is in the trace too, for the case where Next does not bundle
//      the client and `__dirname` is real.
//
// What this cannot tell you is whether Prisma's resolution order has changed. For that,
// reproduce the deployed layout — docs/deployment.md, "Reproducing it locally".

import fs from "node:fs";
import path from "node:path";

const NEXT_DIR = path.join("apps", "web", ".next");
const APP_COPY = path.join("apps", "web", "generated", "client");
const RUNTIME_ENGINE = "libquery_engine-rhel-openssl-3.0.x.so.node";

/** Prisma reads exactly these two things from the directory it resolves. */
const COPY_REQUIRES = ["schema.prisma", RUNTIME_ENGINE];

/** The fallback for a client that was NOT bundled: real `__dirname`, schema beside it. */
const TRACE_REQUIRES = [
  "apps/web/generated/client/schema.prisma",
  `apps/web/generated/client/${RUNTIME_ENGINE}`,
  "packages/db/dist/index.js",
  "packages/db/generated/client/index.js",
  `packages/db/generated/client/${RUNTIME_ENGINE}`,
];

function tracedFiles(dir) {
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
      // Normalise to repo-relative with forward slashes, so this reads the same on Windows
      // as it does in CI.
      traced.add(
        path
          .normalize(path.join(path.dirname(manifest), file))
          .split(path.sep)
          .join("/"),
      );
    }
  }
  return { traced: [...traced], manifests: manifests.length };
}

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  FAIL  ${message}`);
};
const pass = (message) => console.log(`  ok    ${message}`);

// ── 1. The copy Prisma's fallback will look for. ────────────────────────────────────────
console.log("the engine copy under apps/web (what a bundled client resolves to)");
if (!fs.existsSync(APP_COPY)) {
  fail(
    `${APP_COPY} does not exist — run scripts/copy-prisma-engine.mjs (apps/web's build does)`,
  );
} else {
  for (const name of COPY_REQUIRES) {
    if (fs.existsSync(path.join(APP_COPY, name))) pass(`${APP_COPY}/${name}`);
    else fail(`${APP_COPY}/${name} is missing`);
  }
}

// ── 2 & 3. What the build will actually deploy. ─────────────────────────────────────────
if (!fs.existsSync(NEXT_DIR)) {
  console.log(`\nNo build at ${NEXT_DIR}; skipping the trace check.`);
  console.log("  pnpm turbo run build --filter=@inbox-copilot/web");
  process.exit(failures > 0 ? 1 : 2);
}

const { traced, manifests } = tracedFiles(NEXT_DIR);
console.log(`\nfile trace (${manifests} manifests, ${traced.length} distinct files)`);
for (const needle of TRACE_REQUIRES) {
  if (traced.some((f) => f.includes(needle))) pass(needle);
  else fail(`${needle} is not in the trace`);
}

if (failures > 0) {
  console.error(
    `\n${failures} check(s) failed. The function will deploy and then fail at its first\n` +
      "database query. Start with scripts/copy-prisma-engine.mjs and\n" +
      "`outputFileTracingIncludes` in apps/web/next.config.mjs.",
  );
  process.exit(1);
}

console.log("\nPrisma will find its engine: the copy exists and is deployed.");
