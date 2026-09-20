import globals from "globals";
import { base } from "./base.js";

/** Server-side packages: the api, the Prisma package, the shared schemas. */
export const node = [
  ...base,
  {
    languageOptions: {
      globals: globals.node,
      // No `project` — see the note in base.js about why this stays syntax-only.
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
  },
];

export default node;
