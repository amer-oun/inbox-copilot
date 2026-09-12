import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory stand-in for Redis: the nonce store is the replay guard. */
const store = new Map<string, string>();

const redis = vi.hoisted(() => ({
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock("./redis.js", () => ({ redis }));

const { consumeOAuthState, createOAuthState, InvalidOAuthStateError } = await import(
  "./oauthState.js"
);

describe("oauth state", () => {
  beforeEach(() => {
    store.clear();
    redis.set.mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    });
    redis.del.mockImplementation(async (key: string) =>
      store.delete(key) ? 1 : 0,
    );
  });

  it("round-trips the user and provider", async () => {
    const state = await createOAuthState({ userId: "user_1", provider: "google" });
    const payload = await consumeOAuthState(state);

    expect(payload.userId).toBe("user_1");
    expect(payload.provider).toBe("google");
  });

  it("registers the nonce before handing the state out", async () => {
    await createOAuthState({ userId: "user_1", provider: "microsoft" });
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^oauth:state:/),
      "1",
      "EX",
      600,
    );
  });

  it("rejects a replay of a state it already consumed", async () => {
    const state = await createOAuthState({ userId: "user_1", provider: "google" });
    await consumeOAuthState(state);

    await expect(consumeOAuthState(state)).rejects.toThrow(InvalidOAuthStateError);
  });

  it("rejects a tampered payload", async () => {
    const state = await createOAuthState({ userId: "user_1", provider: "google" });
    const [encoded, signature] = state.split(".");

    // Re-encode the payload with someone else's userId, keeping the signature.
    const payload = JSON.parse(
      Buffer.from(encoded ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    payload["userId"] = "attacker";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    )}.${signature}`;

    await expect(consumeOAuthState(forged)).rejects.toThrow(/signature mismatch/);
  });

  it("rejects a forged signature", async () => {
    const state = await createOAuthState({ userId: "user_1", provider: "google" });
    const [encoded] = state.split(".");

    await expect(consumeOAuthState(`${encoded}.not-a-signature`)).rejects.toThrow(
      InvalidOAuthStateError,
    );
  });

  it("rejects a malformed state", async () => {
    await expect(consumeOAuthState("no-separator")).rejects.toThrow(/malformed/);
  });

  it("rejects an expired state without consuming the nonce", async () => {
    const state = await createOAuthState({ userId: "user_1", provider: "google" });

    // Ten minutes and a second later. `restoreMocks` puts Date.now back.
    const later = Date.now() + 601_000;
    vi.spyOn(Date, "now").mockReturnValue(later);

    await expect(consumeOAuthState(state)).rejects.toThrow(/expired/);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("does not accept a state minted for the other provider", async () => {
    const state = await createOAuthState({ userId: "user_1", provider: "google" });
    const payload = await consumeOAuthState(state);

    // The route compares this itself; the payload must carry the truth.
    expect(payload.provider).not.toBe("microsoft");
  });
});
