// Plain .mjs rather than .ts: Next's TypeScript config loader does not work with
// the TypeScript version this monorepo pins. JSDoc gives the same type checking.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** The pnpm workspace root, two levels up from apps/web. */
const repoRoot = join(here, "..", "..");

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prisma's engine is a native binary — it must stay outside the bundle. Keeping
  // `@inbox-copilot/db` external with it is what preserves the *relative* import from
  // that package to the generated client: bundled, the path would be rewritten and
  // Prisma's runtime engine lookup — which reads the filesystem next to itself — would
  // have nothing to find.
  serverExternalPackages: ["@prisma/client", "@inbox-copilot/db"],
  poweredByHeader: false,

  /*
   * Where file tracing starts. Stated rather than inferred: Next guesses the workspace
   * root from lockfiles, and the guess changes with the directory the build was invoked
   * from — which in this repo is `apps/web` under Vercel's root directory and the repo
   * root under `turbo run build`. A tracing root that moves is a serverless function
   * whose contents depend on how it was built.
   */
  outputFileTracingRoot: repoRoot,

  /*
   * The Prisma client, named explicitly, in two places — and the *first* entry is the one
   * that matters. Being in the trace is not the same as being where Prisma looks.
   *
   * `generated/client/**` is a copy made by `scripts/copy-prisma-engine.mjs`, which the
   * `build` script runs before `next build`. It is project-relative, so the function gets
   * it at `<task root>/apps/web/generated/client` — and that is exactly the directory
   * Prisma's generated client falls back to when it has been bundled:
   *
   *     config.dirname = __dirname
   *     if (!fs.existsSync(path.join(__dirname, 'schema.prisma'))) {
   *       // "generated/client", then "client", under process.cwd()
   *     }
   *
   * Next *does* bundle it — `serverExternalPackages` matches package specifiers, and
   * `packages/db` reaches its client by relative path — so `__dirname` becomes a build-time
   * string literal and that branch always fires in a deployed function. An earlier version
   * of this config traced the engine into `packages/db/generated/client` and the deploy
   * still failed: the file was there, and Prisma looked under `apps/web` and at the dead
   * build path `/vercel/path0/packages/db/generated/client`. See docs/deployment.md.
   *
   * The `../../packages/db/**` entries stay as the other half of the pair, for the case
   * where the client is *not* bundled — then `__dirname` is real, `schema.prisma` sits
   * beside it, and the first branch wins. One duplicated engine is a cheap price for both
   * resolutions working; a production outage diagnosed from a list of searched paths is
   * not.
   *
   * `/**\/*` rather than a list of routes: Auth.js reaches the database from any page that
   * reads a session, which is every authenticated page, and a list would be a second place
   * to remember.
   */
  outputFileTracingIncludes: {
    "/**/*": [
      "generated/client/**",
      "../../packages/db/dist/**",
      "../../packages/db/generated/client/**",
    ],
  },
};

export default nextConfig;
