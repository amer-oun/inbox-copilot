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
   * The Prisma client, named explicitly.
   *
   * `serverExternalPackages` above means Next does not bundle `@inbox-copilot/db`, so it
   * also does not walk it — and an external package that nothing traced is a package that
   * is simply absent from the deployed function. Measured on this repo: before this, the
   * web app's 718 traced files included exactly one file from `packages/db` (its
   * `package.json`) and nothing at all from Prisma, which is the whole of
   * `PrismaClientInitializationError: Prisma Client could not locate the Query Engine`.
   *
   * Both entries are needed and they fail differently:
   *   - `generated/client/**` is the client and the engine binary. Prisma's own tracing
   *     hook finds the `.so.node` once it lives at a nameable path, but not the
   *     `runtime/` directory its `index.js` requires.
   *   - `dist/**` is `packages/db` itself — the tenancy extension, the shared
   *     `PrismaClient` instance. Without it the import resolves to nothing.
   *
   * `/**\/*` rather than a list of routes: Auth.js reaches the database from any page
   * that reads a session, which is every authenticated page, and a list would be a
   * second place to remember.
   */
  outputFileTracingIncludes: {
    "/**/*": ["../../packages/db/dist/**", "../../packages/db/generated/client/**"],
  },
};

export default nextConfig;
