import { describe, expect, it } from "vitest";
import { redactUrl } from "./logger.js";

/**
 * The OAuth callback puts a one-time authorization code in the request URL, and
 * pino-http logs request URLs. These are the assertions that keep rule 3 true
 * for the log as well as for responses.
 */
describe("redactUrl", () => {
  it("redacts the authorization code and state", () => {
    expect(
      redactUrl("/oauth/google/callback?code=4/0AX4Xxyz&state=abc.def"),
    ).toBe("/oauth/google/callback?code=%5Bredacted%5D&state=%5Bredacted%5D");
  });

  it("redacts token-bearing parameters whatever their case", () => {
    const redacted = redactUrl("/cb?Access_Token=zzz&ID_TOKEN=yyy");
    expect(redacted).not.toContain("zzz");
    expect(redacted).not.toContain("yyy");
  });

  it("leaves ordinary query parameters alone", () => {
    expect(redactUrl("/threads?limit=25&cursor=abc")).toBe(
      "/threads?limit=25&cursor=abc",
    );
  });

  it("passes through a url with no query string", () => {
    expect(redactUrl("/health")).toBe("/health");
  });

  it("handles an undefined url", () => {
    expect(redactUrl(undefined)).toBeUndefined();
  });
});
