import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which endpoint AI calls go to.
 *
 * This decides whether classifications in the database came from a model or from
 * canned responses, so each branch is pinned — especially the production ones, where
 * the wrong answer means either an outage or a database quietly full of fake output.
 */

const envValues = vi.hoisted(() => ({
  NODE_ENV: "development" as string,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_BASE_URL: "",
  AI_STUB_PORT: 4010,
}));

vi.mock("../../lib/env.js", () => ({ env: envValues }));

const { resolveAiEndpoint, STUB_API_KEY } = await import("./endpoint.js");
const { UpstreamError } = await import("../../lib/errors.js");

const DEFAULTS = { ...envValues };

beforeEach(() => {
  Object.assign(envValues, DEFAULTS);
});

afterEach(() => {
  Object.assign(envValues, DEFAULTS);
});

describe("resolveAiEndpoint", () => {
  it("uses the local stub when there is no key, in development", () => {
    const endpoint = resolveAiEndpoint();

    expect(endpoint).toMatchObject({
      baseURL: "http://127.0.0.1:4010",
      stubbed: true,
      apiKey: STUB_API_KEY,
    });
  });

  it("uses the real API when a key is set", () => {
    envValues.ANTHROPIC_API_KEY = "sk-ant-real";

    const endpoint = resolveAiEndpoint();

    // baseURL undefined = the SDK's own default. Nothing rewrites it.
    expect(endpoint.baseURL).toBeUndefined();
    expect(endpoint.stubbed).toBe(false);
    expect(endpoint.apiKey).toBe("sk-ant-real");
  });

  it("prefers an explicit base URL over the key", () => {
    // A gateway in front of the API: real key, different host.
    envValues.ANTHROPIC_API_KEY = "sk-ant-real";
    envValues.ANTHROPIC_BASE_URL = "https://ai-gateway.internal";

    const endpoint = resolveAiEndpoint();

    expect(endpoint.baseURL).toBe("https://ai-gateway.internal");
    expect(endpoint.apiKey).toBe("sk-ant-real");
    // A gateway is not a stub: its answers may well be a model's.
    expect(endpoint.stubbed).toBe(false);
  });

  it("recognizes the stub port as stubbed even when set explicitly", () => {
    envValues.ANTHROPIC_BASE_URL = "http://127.0.0.1:4010";

    expect(resolveAiEndpoint().stubbed).toBe(true);
  });

  it("follows a changed stub port", () => {
    envValues.AI_STUB_PORT = 4999;

    expect(resolveAiEndpoint().baseURL).toBe("http://127.0.0.1:4999");
  });

  it("supplies a placeholder key for the stub that is not key-shaped", () => {
    // If it ever reached the real API the failure should be an obvious 401.
    expect(resolveAiEndpoint().apiKey).toBe(STUB_API_KEY);
    expect(STUB_API_KEY).not.toMatch(/^sk-ant/);
  });

  it("refuses to guess in production with nothing configured", () => {
    envValues.NODE_ENV = "production";

    expect(() => resolveAiEndpoint()).toThrow(UpstreamError);
    expect(() => resolveAiEndpoint()).toThrow(/AI is not configured/);
  });

  it("allows a real key in production", () => {
    envValues.NODE_ENV = "production";
    envValues.ANTHROPIC_API_KEY = "sk-ant-real";

    expect(resolveAiEndpoint().stubbed).toBe(false);
  });

  it("explains its choice, for the log line", () => {
    expect(resolveAiEndpoint().reason).toMatch(/no ANTHROPIC_API_KEY/);

    envValues.ANTHROPIC_API_KEY = "sk-ant-real";
    expect(resolveAiEndpoint().reason).toMatch(/ANTHROPIC_API_KEY is set/);

    envValues.ANTHROPIC_BASE_URL = "https://gw.internal";
    expect(resolveAiEndpoint().reason).toMatch(/ANTHROPIC_BASE_URL is set/);
  });
});
