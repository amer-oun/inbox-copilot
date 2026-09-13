import { defineConfig } from "vitest/config";

/**
 * The web app's tests cover the security-critical pure functions — the email frame
 * builder and its image restoration — not the React tree. `jsdom` is here because
 * `restoreBlockedImages` uses `DOMParser`, which is the browser API that makes the
 * restore a parse rather than a regex over hostile markup.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    restoreMocks: true,
  },
});
