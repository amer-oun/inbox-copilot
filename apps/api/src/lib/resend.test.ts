import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The application-email transport (§9).
 *
 * Deliberately dull, and the tests are mostly about what it does when it cannot work.
 * The digest is a convenience: reminders are created, resolved and displayed with no
 * email provider involved at all, so an unconfigured or failing transport must degrade
 * to silence rather than break the job that called it.
 */

const originalKey = process.env["RESEND_API_KEY"];
const originalFrom = process.env["DIGEST_FROM_ADDRESS"];

process.env["RESEND_API_KEY"] = "re_test_key";
process.env["DIGEST_FROM_ADDRESS"] = "copilot@example.com";

const { sendAppEmail } = await import("./resend.js");

const EMAIL = {
  to: "owner@example.com",
  subject: "2 messages are still waiting for a reply",
  html: "<p>hi</p>",
  text: "hi",
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: "re_1" }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendAppEmail", () => {
  it("posts the message and reports the provider id", async () => {
    const result = await sendAppEmail(EMAIL);

    expect(result).toEqual({ sent: true, id: "re_1" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body)).toEqual({
      from: "copilot@example.com",
      to: ["owner@example.com"],
      subject: EMAIL.subject,
      html: EMAIL.html,
      text: EMAIL.text,
    });
  });

  it("sends both an HTML and a text part", async () => {
    // A digest with no text alternative is a digest some clients render as nothing.
    await sendAppEmail(EMAIL);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body);
    expect(body.html).not.toBe("");
    expect(body.text).not.toBe("");
  });

  it("times out rather than holding a socket open", async () => {
    // A digest is not worth blocking a scheduled job on.
    await sendAppEmail(EMAIL);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("reports an upstream refusal without throwing", async () => {
    /*
     * Never throws, because the caller is a scheduled job whose real work — resolving
     * and triggering reminders — has already been committed. A failed digest must not
     * roll that back or fail the tick.
     */
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    const result = await sendAppEmail(EMAIL);
    expect(result).toEqual({ sent: false, reason: "http-429" });
  });

  it("reports a transport failure without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("network is down"));

    const result = await sendAppEmail(EMAIL);
    expect(result).toEqual({ sent: false, reason: "transport-error" });
  });

  it("survives a response body that is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    });

    const result = await sendAppEmail(EMAIL);
    expect(result.sent).toBe(true);
  });

  it("never puts the API key anywhere but the authorization header", async () => {
    // Rule 3's spirit: this is the one place the value is read, and it must not reach a
    // log line or a request body.
    await sendAppEmail(EMAIL);

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init.headers.authorization).toBe("Bearer re_test_key");
    expect(init.body).not.toContain("re_test_key");
  });
});

describe("when it is not configured", () => {
  it("reports not-configured rather than attempting a call", async () => {
    /*
     * The supported state. Without a key the reminders themselves still work, still
     * resolve, and are still visible at /follow-ups — which is where they belong anyway.
     * Nothing about follow-ups depends on an email provider.
     */
    vi.resetModules();
    process.env["RESEND_API_KEY"] = "";
    const fresh = await import("./resend.js");

    const result = await fresh.sendAppEmail(EMAIL);

    expect(result).toEqual({ sent: false, reason: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();

    process.env["RESEND_API_KEY"] = "re_test_key";
  });

  it("also declines with a key but no From address", async () => {
    // An unverified or missing sender would be a bounce, not a digest.
    vi.resetModules();
    process.env["DIGEST_FROM_ADDRESS"] = "";
    const fresh = await import("./resend.js");

    const result = await fresh.sendAppEmail(EMAIL);
    expect(result.reason).toBe("not-configured");

    process.env["DIGEST_FROM_ADDRESS"] = "copilot@example.com";
  });
});

afterEach(() => {
  if (originalKey === undefined) delete process.env["RESEND_API_KEY"];
  else process.env["RESEND_API_KEY"] = originalKey;
  if (originalFrom === undefined) delete process.env["DIGEST_FROM_ADDRESS"];
  else process.env["DIGEST_FROM_ADDRESS"] = originalFrom;
});
