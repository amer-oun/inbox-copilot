/**
 * Formatting, for the whole repo. One file, no per-package overrides: a diff that is
 * partly about where the line breaks is a diff nobody reads carefully.
 *
 * `printWidth` is 90 because that is closest to what this codebase was already
 * hand-written to — measured, not guessed: at 90 the fewest existing files change.
 * It does not reach zero, because the code predates Prettier. Adopting it is
 * therefore a reformat, and `pnpm format` is meant to be run and reviewed **on its
 * own**, never mixed into a change that also does something.
 *
 * That is also why `format:check` is not part of `pnpm lint`. Until the reformat
 * lands, a failing formatter would make the lint task useless — and a lint task
 * people learn to ignore is worse than no lint task.
 */

/** @type {import("prettier").Config} */
export const prettierConfig = {
  printWidth: 90,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  arrowParens: "always",
  endOfLine: "lf",
};

export default prettierConfig;
