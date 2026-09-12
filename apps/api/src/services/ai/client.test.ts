import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { aiClassificationSchema } from "@inbox-copilot/shared";
import invoiceResponse from "./__fixtures__/classify-invoice.json" with { type: "json" };
import invalidResponse from "./__fixtures__/classify-invalid.json" with { type: "json" };
import proseResponse from "./__fixtures__/classify-prose.json" with { type: "json" };
import truncatedResponse from "./__fixtures__/classify-truncated.json" with { type: "json" };

/**
 * The single path to the model, against recorded responses — no live calls.
 *
 * What is asserted here is the *request*: which prompt sits in the system position,
 * where email content is allowed to appear, how many tools are offered, and that the
 * response is turned into data by schema validation rather than by reading prose.
 * Those are the §7 guarantees, and they are properties of the request we build.
 */

const create = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create };
    constructor(public options: unknown) {}
  },
}));

const usageCreate = vi.hoisted(() => vi.fn());
const usageCount = vi.hoisted(() => vi.fn());
const settingsFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@inbox-copilot/db", () => ({
  dbForUser: () => ({
    aiUsage: { create: usageCreate, count: usageCount },
    userSettings: { findFirst: settingsFindFirst },
  }),
}));

const { callStructured, resetAnthropicClient } = await import("./client.js");
const { CLASSIFY_SYSTEM_PROMPT, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } = await import(
  "./prompts.js"
);
const { MODELS } = await import("./models.js");

const USER_ID = "user_1";
const USER_CONTENT = `${UNTRUSTED_OPEN}\nHello there\n</untrusted_email>`;

function call(overrides: Record<string, unknown> = {}) {
  return callStructured({
    userId: USER_ID,
    feature: "classify",
    toolName: "record_classification",
    toolDescription: "Record the classification.",
    schema: aiClassificationSchema,
    userContent: USER_CONTENT,
    ...overrides,
  });
}

/** The single `messages.create` argument object, for request-shape assertions. */
function request(): {
  model: string;
  system: string;
  max_tokens: number;
  temperature: number;
  messages: { role: string; content: string }[];
  tools: { name: string; input_schema: Record<string, unknown> }[];
  tool_choice: { type: string; name: string };
} {
  return create.mock.calls[0]?.[0];
}

beforeEach(() => {
  resetAnthropicClient();
  create.mockReset().mockResolvedValue(invoiceResponse);
  usageCreate.mockReset().mockResolvedValue({});
  usageCount.mockReset().mockResolvedValue(0);
  settingsFindFirst.mockReset().mockResolvedValue({
    aiEnabled: true,
    autoSummarize: true,
    autoCategorize: true,
    dailyAiCallCap: 500,
  });
});

describe("callStructured request shape", () => {
  it("sends the registered system prompt, unmodified", async () => {
    await call();
    expect(request().system).toBe(CLASSIFY_SYSTEM_PROMPT);
  });

  it("puts email content only in the user turn, never the system prompt", async () => {
    await call();

    // The prompt names the tag (it has to, to explain it) but never wraps
    // anything in it: no closing delimiter, and no body text.
    expect(request().system).not.toContain(UNTRUSTED_CLOSE);
    expect(request().system).not.toContain("Hello there");
    expect(request().messages).toHaveLength(1);
    expect(request().messages[0]?.role).toBe("user");
    expect(request().messages[0]?.content).toBe(USER_CONTENT);
  });

  it("offers exactly one tool and pins it", async () => {
    await call();

    // §7 rule 3: one tool, and it returns data. There is nothing here that acts.
    expect(request().tools).toHaveLength(1);
    expect(request().tools[0]?.name).toBe("record_classification");
    expect(request().tool_choice).toEqual({
      type: "tool",
      name: "record_classification",
    });
  });

  it("compiles the Zod schema into the tool's JSON Schema", async () => {
    await call();
    const schema = request().tools[0]?.input_schema;

    expect(schema).toMatchObject({
      type: "object",
      properties: {
        priorityScore: { type: "integer", minimum: 0, maximum: 100 },
        needsReply: { type: "boolean" },
      },
    });
    // Field descriptions are what the model reads about each field.
    expect(JSON.stringify(schema)).toContain("BCP-47");
  });

  it("routes classification to Haiku with a bounded output and temperature 0", async () => {
    await call();

    expect(request().model).toBe(MODELS.fast);
    expect(request().max_tokens).toBe(512);
    expect(request().temperature).toBe(0);
  });

  it("passes an abort signal through to the SDK", async () => {
    const controller = new AbortController();
    await call({ signal: controller.signal });

    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });
});

describe("callStructured response handling", () => {
  it("returns the validated tool input", async () => {
    const result = await call();

    expect(result.data).toEqual({
      category: "FINANCE",
      priority: "HIGH",
      priorityScore: 72,
      needsReply: true,
      language: "en",
      confidence: 0.88,
    });
    expect(result.model).toBe(MODELS.fast);
  });

  it("rejects prose instead of falling back to parsing it", async () => {
    // Rule 6: there is no regex path, so a prose answer is an error, not input.
    create.mockResolvedValue(proseResponse);

    await expect(call()).rejects.toThrow(/no record_classification tool call/);
  });

  it("rejects tool input that fails the schema", async () => {
    // priorityScore 150. Clamping it would invent a value the model did not return.
    create.mockResolvedValue(invalidResponse);

    await expect(call()).rejects.toThrow(/failed validation/);
  });

  it("rejects a truncated response", async () => {
    create.mockResolvedValue(truncatedResponse);

    await expect(call()).rejects.toThrow(/output ceiling/);
  });
});

describe("callStructured ledger and cap", () => {
  it("writes one usage row per call, with cost", async () => {
    await call();

    expect(usageCreate).toHaveBeenCalledTimes(1);
    expect(usageCreate.mock.calls[0]?.[0].data).toMatchObject({
      userId: USER_ID,
      feature: "classify",
      model: MODELS.fast,
      inputTokens: 1240,
      outputTokens: 92,
      cachedTokens: 0,
      // 1240/1e6 * $1 + 92/1e6 * $5 = 0.0017
      costUsd: "0.001700",
    });
  });

  it("bills a call whose response was unusable", async () => {
    // The tokens were spent. A ledger that only records successes under-reports.
    create.mockResolvedValue(invalidResponse);

    await expect(call()).rejects.toThrow();
    expect(usageCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses before calling when the daily cap is spent", async () => {
    usageCount.mockResolvedValue(500);

    await expect(call()).rejects.toThrow(/Daily AI call cap/);
    // The point of a cap: the request is never made.
    expect(create).not.toHaveBeenCalled();
  });

  it("allows the call that reaches the cap exactly", async () => {
    usageCount.mockResolvedValue(499);

    await expect(call()).resolves.toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("honours a lowered cap from user settings", async () => {
    settingsFindFirst.mockResolvedValue({
      aiEnabled: true,
      autoSummarize: true,
      autoCategorize: true,
      dailyAiCallCap: 10,
    });
    usageCount.mockResolvedValue(10);

    await expect(call()).rejects.toThrow(/Daily AI call cap/);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses when the user has AI disabled", async () => {
    settingsFindFirst.mockResolvedValue({
      aiEnabled: false,
      autoSummarize: true,
      autoCategorize: true,
      dailyAiCallCap: 500,
    });

    await expect(call()).rejects.toThrow(/disabled/);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not re-read settings when the caller already has them", async () => {
    await call({
      settings: {
        aiEnabled: true,
        autoSummarize: true,
        autoCategorize: true,
        dailyAiCallCap: 500,
      },
    });

    expect(settingsFindFirst).not.toHaveBeenCalled();
  });
});

describe("callStructured retries", () => {
  it("retries a 529 overloaded response and succeeds", async () => {
    const overloaded = Object.assign(new Error("Overloaded"), { status: 529 });
    create.mockRejectedValueOnce(overloaded).mockResolvedValue(invoiceResponse);

    const result = await callStructured({
      userId: USER_ID,
      feature: "classify",
      toolName: "record_classification",
      toolDescription: "Record the classification.",
      schema: aiClassificationSchema,
      userContent: USER_CONTENT,
      // Zod's own schema is fine here; the retry is what is under test.
    });

    expect(result.data.category).toBe("FINANCE");
    expect(create).toHaveBeenCalledTimes(2);
    // Only the successful call is billed: the 529 returned no usage.
    expect(usageCreate).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("does not retry a 400", async () => {
    const badRequest = Object.assign(new Error("invalid_request_error"), { status: 400 });
    create.mockRejectedValue(badRequest);

    await expect(call()).rejects.toThrow(/invalid_request_error/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("schema compilation", () => {
  it("refuses a schema the SDK cannot describe", async () => {
    // A guard against a future schema that cannot be expressed as JSON Schema:
    // better a thrown error than a tool the model cannot see the shape of.
    const impossible = z.custom<unknown>(() => true);

    await expect(call({ schema: impossible })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
