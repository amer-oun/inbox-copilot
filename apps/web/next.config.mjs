// Plain .mjs rather than .ts: Next's TypeScript config loader does not work with
// the TypeScript version this monorepo pins. JSDoc gives the same type checking.

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prisma's engine is a native binary — it must stay outside the bundle.
  serverExternalPackages: ["@prisma/client", "@inbox-copilot/db"],
  poweredByHeader: false,
};

export default nextConfig;
