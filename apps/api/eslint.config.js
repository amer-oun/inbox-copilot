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
                "googleapis may only be imported inside apps/api/src/providers/. Everything above the port codes against the MailProvider interface, so no feature branches on which mailbox it is reading.",
            },
            {
              name: "@microsoft/microsoft-graph-client",
              allowTypeImports: true,
              message:
                "@microsoft/microsoft-graph-client may only be imported inside apps/api/src/providers/. Everything above the port codes against the MailProvider interface, so no feature branches on which mailbox it is reading.",
            },
          ],
        },
      ],
    },
  },
];
