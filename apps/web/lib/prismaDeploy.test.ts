import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The four settings that keep Prisma working on Vercel.
 *
 * None of them can be checked by running the app: locally the whole `node_modules` tree is
 * present and everything resolves, so a build with all four deleted passes every other test
 * in this repo and then throws `PrismaClientInitializationError: Prisma Client could not
 * locate the Query Engine` on the first request in production.
 *
 * `pnpm verify:prisma` checks the real outcome against a build. These are the fast guard:
 * they fail on the *edit* that would cause it, which is the one somebody makes while tidying
 * a config they do not have the history for.
 *
 * One of them is here because the first attempt at this fix passed its own check and the
 * deploy still failed. Tracing the engine into `packages/db/generated/client` shipped it —
 * and Prisma never looked there, because Next bundles the client and a bundled client
 * resolves its engine under `process.cwd()`. Being deployed and being findable are
 * different properties, and only the second one keeps the site up.
 */

/** Repo-relative read. `process.cwd()` is apps/web when vitest runs here. */
function repoFile(relative: string): string {
  return readFileSync(join(process.cwd(), "..", "..", relative), "utf8");
}

describe("the generated client has an explicit home", () => {
  const schema = repoFile("packages/db/prisma/schema.prisma");

  it("generates outside node_modules", () => {
    /*
     * The default output is `node_modules/.prisma/client`, which under pnpm means a
     * content-hashed path like `.pnpm/@prisma+client@6.19.3_prism_f06fed13…`. Nothing
     * outside pnpm can name that, so nothing can tell Next.js to ship it.
     *
     * It also means there is exactly *one* client. `@prisma/client` is peer-resolved, and
     * this workspace resolves it twice — apps/web pins TypeScript 6 for Next 15 while the
     * rest is on 7 — so the web app's graph reached a second, never-generated copy with
     * no engine in it at all.
     */
    expect(schema).toMatch(/output\s*=\s*"\.\.\/generated\/client"/);
  });

  it("builds the engine for Vercel's runtime, not just the build machine's", () => {
    // `native` alone is the build container's platform. It is often the same as the
    // runtime's and that is not a thing to rely on.
    expect(schema).toMatch(/binaryTargets\s*=\s*\[[^\]]*"rhel-openssl-3\.0\.x"[^\]]*\]/);
    expect(schema).toMatch(/binaryTargets\s*=\s*\[\s*"native"/);
  });

  it("is imported by relative path, so peer resolution cannot pick a different copy", () => {
    const sources = [
      repoFile("packages/db/src/client.ts"),
      repoFile("packages/db/src/index.ts"),
      repoFile("packages/db/src/tenancy.ts"),
    ];
    for (const source of sources) {
      expect(source).not.toMatch(/from "@prisma\/client"/);
    }
    expect(sources.join("\n")).toContain('from "../generated/client/index.js"');
  });
});

describe("Next.js is told to ship it", () => {
  const config = repoFile("apps/web/next.config.mjs");

  it("names both halves of the client in the file trace", () => {
    /*
     * `serverExternalPackages` keeps the native engine out of the bundle, which is
     * correct — and it also stops Next walking the package, so an external that nothing
     * traced is an external that is simply absent from the function. Measured: one traced
     * file from packages/db before this, forty-one after.
     */
    expect(config).toContain("outputFileTracingIncludes");
    expect(config).toContain("packages/db/generated/client/**");
    expect(config).toContain("packages/db/dist/**");
  });

  it("states the tracing root rather than letting it be inferred", () => {
    // Next infers it from lockfiles, and the inference depends on the directory the build
    // was started from — `apps/web` under Vercel's root directory, the repo root under
    // turbo. A tracing root that moves is a function whose contents depend on the caller.
    expect(config).toContain("outputFileTracingRoot");
  });

  it("keeps the engine out of the bundle", () => {
    expect(config).toMatch(/serverExternalPackages:\s*\[[^\]]*"@prisma\/client"/);
  });
});

describe("turbo caches the generated client with the build", () => {
  it("lists generated/** as a build output", () => {
    /*
     * The subtle one, and the one that would have made this intermittent. `packages/db`'s
     * build script is `prisma generate && tsc`. If `generated/**` is not a declared output,
     * a cache *hit* restores `dist/` and silently omits the client — so the deploy that
     * breaks is the second one, with no change to explain it.
     */
    const turbo = JSON.parse(repoFile("turbo.json")) as {
      tasks: { build: { outputs: string[] } };
    };
    expect(turbo.tasks.build.outputs).toContain("generated/**");
  });
});

describe("the engine is copied where a bundled client will look", () => {
  /*
   * The load-bearing one. From the generated client's own source:
   *
   *     config.dirname = __dirname
   *     if (!fs.existsSync(path.join(__dirname, 'schema.prisma'))) {
   *       const alternativePaths = ["generated/client", "client"]
   *       ... config.dirname = path.join(process.cwd(), alternativePath)
   *     }
   *
   * Next bundles the client — `serverExternalPackages` matches package specifiers and
   * `packages/db` reaches its client by relative path — so `__dirname` becomes a build-time
   * string and that branch always fires in a deployed function. `process.cwd()` there is the
   * project directory, so the engine has to be at `apps/web/generated/client`.
   */

  it("runs the copy before next build", () => {
    const pkg = JSON.parse(repoFile("apps/web/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.build).toContain("copy-prisma-engine.mjs");
    // And in dev, so a local run resolves the engine the same way a deployed one does.
    expect(pkg.scripts.dev).toContain("copy-prisma-engine.mjs");
  });

  it("traces the copy from inside the project directory, not only from packages/db", () => {
    /*
     * Project-relative, so the function receives it at `<task root>/apps/web/generated/client`
     * — the path Prisma searches first. `../../packages/db/...` lands at
     * `<task root>/packages/db/...`, which is shipped and never consulted once bundled.
     */
    const config = repoFile("apps/web/next.config.mjs");
    expect(config).toContain('"generated/client/**"');
  });

  it("copies the schema as well as the engine", () => {
    /*
     * `schema.prisma` is not incidental: its presence is the condition Prisma tests to pick
     * the directory at all, and the engine is then loaded from beside it.
     */
    const script = repoFile("scripts/copy-prisma-engine.mjs");
    expect(script).toContain("schema.prisma");
    expect(script).toContain(".node");
  });
});
