import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import { base } from "./base.js";

/**
 * `apps/web`. Server Components are the default here and `"use client"` is the
 * exception, so the file set is a mix of code that runs in node and code that runs
 * in a browser — hence both global sets rather than a guess per file.
 */
export const next = [
  ...base,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "@next/next": nextPlugin },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
      ...nextPlugin.configs.recommended.rules,
    },
  },
];

export default next;
