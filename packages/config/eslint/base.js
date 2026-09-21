import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

/**
 * The lint rules every package in this repo shares.
 *
 * Two things are deliberately *not* here. There is no type-aware configuration
 * (`recommendedTypeChecked`): `pnpm typecheck` already runs the real compiler over
 * every package, so a second, slower type check with a different TypeScript version
 * would buy noise rather than coverage. And there is no formatting opinion — that is
 * Prettier's job, and `eslint-config-prettier` at the end of the chain switches off
 * every rule the two could argue about.
 *
 * What is left is what a type checker cannot say: rules about what the code is allowed
 * to reach for.
 */

/** Build output and generated clients. Nothing here was written by a person. */
export const ignores = [
  "**/dist/**",
  // The Prisma client, generated to an explicit path so Next.js can trace it onto a
  // serverless function (packages/db/prisma/schema.prisma). Machine-written, and it
  // ships a 17MB engine binary alongside.
  "**/generated/client/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/node_modules/**",
  "**/coverage/**",
  "**/next-env.d.ts",
];

export const base = tseslint.config(
  { ignores },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      // The house rules, made mechanical: no `any`, no non-null `!` outside tests,
      // type-only imports written as such, and no stray `console`.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      /*
       * `verbatimModuleSyntax` is on everywhere, so a type imported as a value is a
       * runtime import of a module that may only exist at compile time. Inline
       * `import()` types are left alone (`disallowTypeAnnotations: false`): they are
       * erased, they emit nothing, and forbidding them would break the one place this
       * repo needs them — `vi.importActual<typeof import("./x.js")>` inside a hoisted
       * `vi.mock` factory.
       */
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      /*
       * Logging is structured and goes through pino, with `userId` and
       * `mailAccountId` on every line. A `console.log` is both unstructured and
       * unfiltered, which is how an OAuth token reaches a terminal (rule 3).
       */
      "no-console": "error",
    },
  },
  {
    /*
     * Tests, fixtures and one-shot scripts. `!` is allowed in tests by the house rules
     * — a fixture the test itself constructed is not the uncertainty the rule exists
     * for — and a script whose whole output is a printed report has nowhere else to
     * write it.
     */
    files: [
      "**/*.test.{ts,tsx}",
      "**/__fixtures__/**",
      "**/vitest.config.*",
      "**/scripts/**",
      "**/devtools/**",
    ],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
  prettier,
);

export default base;
