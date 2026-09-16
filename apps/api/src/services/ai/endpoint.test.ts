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
  AI_PROVIDER: undefined as string | undefined,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_BASE_URL: "",
  GEMINI_API_KEY: "",
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

describe("AI_PROVIDER", () => {
  /*
   * The variable exists so that "why is this mailbox full of stubbed classifications" is
   * answerable from one setting rather than deduced from which keys happen to be set. The
   * first test is the one that protects every existing deployment.
   */

  it("infers exactly what it used to when unset", () => {
    // Back-compatibility, asserted rather than assumed: an existing `.env` that has never
    // heard of AI_PROVIDER must behave identically.
    envValues.AI_PROVIDER = undefined;
    envValues.ANTHROPIC_API_KEY = "sk-ant-real";

    expect(resolveAiEndpoint()).toMatchObject({
      provider: "anthropic",
      stubbed: false,
      reason: "ANTHROPIC_API_KEY is set",
    });
  });

  it("uses the Gemini key when asked for Gemini", () => {
    envValues.AI_PROVIDER = "gemini";
    envValues.GEMINI_API_KEY = "gemini-real";

    expect(resolveAiEndpoint()).toMatchObject({
      provider: "gemini",
      apiKey: "gemini-real",
      // The SDK's own endpoint; there is no base-URL override on this path.
      baseURL: undefined,
      stubbed: false,
      reason: "AI_PROVIDER=gemini",
    });
  });

  it("refuses Gemini with no key, rather than falling back to something else", () => {
    // A silent fallback to the stub would fill the database with canned answers; a
    // fallback to Anthropic would spend money the user said they do not have.
    envValues.AI_PROVIDER = "gemini";
    envValues.GEMINI_API_KEY = "";

    expect(() => resolveAiEndpoint()).toThrow(UpstreamError);
    expect(() => resolveAiEndpoint()).toThrow(/GEMINI_API_KEY is empty/);
  });

  it("never picks Gemini just because a key is lying around", () => {
    /*
     * The important negative. A `GEMINI_API_KEY` left over from an experiment must not
     * silently redirect a deployment's mail classification to a different model —
     * switching provider is a decision, so it has to be written down.
     */
    envValues.AI_PROVIDER = undefined;
    envValues.GEMINI_API_KEY = "gemini-real";
    envValues.ANTHROPIC_API_KEY = "sk-ant-real";

    expect(resolveAiEndpoint().provider).toBe("anthropic");
  });

  it("prefers Gemini over an Anthropic key when asked for it", () => {
    envValues.AI_PROVIDER = "gemini";
    envValues.GEMINI_API_KEY = "gemini-real";
    envValues.ANTHROPIC_API_KEY = "sk-ant-real";

    expect(resolveAiEndpoint().provider).toBe("gemini");
  });

  it("selects the stub explicitly, on the Anthropic transport", () => {
    // The stub speaks the Messages API, so "which provider" and "is it stubbed" are
    // separate questions: the stub is reached *through* the Anthropic transport.
    envValues.AI_PROVIDER = "stub";

    expect(resolveAiEndpoint()).toMatchObject({
      provider: "anthropic",
      baseURL: "http://127.0.0.1:4010",
      stubbed: true,
      reason: "AI_PROVIDER=stub",
    });
  });

  it("refuses the explicit stub in production too", () => {
    /*
     * Choosing it on purpose does not make it safe. The reason a production deploy must
     * not run on canned answers has nothing to do with whether somebody meant it.
     */
    envValues.AI_PROVIDER = "stub";
    envValues.NODE_ENV = "production";

    expect(() => resolveAiEndpoint()).toThrow(/refused in production/);
  });

  it("allows Gemini in production", () => {
    // Unlike the stub: a free-tier model is a real model.
    envValues.AI_PROVIDER = "gemini";
    envValues.GEMINI_API_KEY = "gemini-real";
    envValues.NODE_ENV = "production";

    expect(resolveAiEndpoint().provider).toBe("gemini");
  });

  it("names Gemini in the not-configured error, so the cheap option is discoverable", () => {
    envValues.NODE_ENV = "production";

    expect(() => resolveAiEndpoint()).toThrow(/GEMINI_API_KEY with AI_PROVIDER=gemini/);
  });

  it("tags every Anthropic branch with the provider", () => {
    envValues.ANTHROPIC_BASE_URL = "https://ai-gateway.internal";
    expect(resolveAiEndpoint().provider).toBe("anthropic");

    envValues.ANTHROPIC_BASE_URL = "";
    expect(resolveAiEndpoint().provider).toBe("anthropic");
  });
});
