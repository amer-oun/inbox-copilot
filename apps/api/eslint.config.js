import { node } from "@inbox-copilot/config/eslint/node";

export default [
  ...node,
  {
    /*
     * Rule 5, made mechanical: all provider calls go through the `MailProvider`
     * interface, and the SDKs live behind it. A `googleapis` import anywhere else is
     * the failure this rule exists to prevent — code that talks to Gmail directly and
     * therefore has no Outlook equivalent.
     *
     * Type-only imports are allowed: `import type { gmail_v1 }` is erased, makes no
     * call, and is how a test names the shape of a fixture. The rule is about reaching
     * for the SDK, not about naming its types.
     */
    files: ["src/**/*.ts"],
    ignores: ["src/providers/**"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "googleapis",
              allowTypeImports: true,
              message:
                "Provider SDKs stay behind MailProvider — see apps/api/src/providers/ (CLAUDE.md rule 5).",
            },
            {
              name: "@microsoft/microsoft-graph-client",
              allowTypeImports: true,
              message:
                "Provider SDKs stay behind MailProvider — see apps/api/src/providers/ (CLAUDE.md rule 5).",
            },
          ],
        },
      ],
    },
  },
];
