import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  currentKeyVersion,
  decrypt,
  encrypt,
  safeEqual,
  type EncryptedValue,
} from "./crypto.js";

/** Flip one bit in a base64 payload without changing its length. */
function tamper(base64: string): string {
  const raw = Buffer.from(base64, "base64");
  raw[0] = (raw[0] ?? 0) ^ 0x01;
  return raw.toString("base64");
}

const REFRESH_TOKEN = "1//0eXaMpLe-refresh-token_value.with-punctuation";

describe("crypto", () => {
  describe("round trip", () => {
    it("decrypts back to the original plaintext", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      expect(decrypt(sealed)).toBe(REFRESH_TOKEN);
    });

    it("never stores the plaintext in the envelope", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      expect(sealed.ciphertext).not.toContain(REFRESH_TOKEN);
      expect(JSON.stringify(sealed)).not.toContain("refresh-token_value");
    });

    it("stamps the current key version", () => {
      expect(encrypt(REFRESH_TOKEN).keyVersion).toBe(currentKeyVersion);
    });

    it("uses a fresh iv for every call, so identical inputs differ", () => {
      const a = encrypt(REFRESH_TOKEN);
      const b = encrypt(REFRESH_TOKEN);
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
      expect(decrypt(a)).toBe(decrypt(b));
    });

    it("survives multi-byte characters", () => {
      const value = "مرحبا — token ✉️";
      expect(decrypt(encrypt(value))).toBe(value);
    });

    it("refuses to encrypt an empty value", () => {
      expect(() => encrypt("")).toThrow(/empty/);
    });
  });

  describe("tamper rejection", () => {
    it("rejects a modified authTag", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      const forged: EncryptedValue = { ...sealed, authTag: tamper(sealed.authTag) };
      expect(() => decrypt(forged)).toThrow(DecryptionError);
    });

    it("rejects a modified ciphertext", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      const forged: EncryptedValue = {
        ...sealed,
        ciphertext: tamper(sealed.ciphertext),
      };
      expect(() => decrypt(forged)).toThrow(DecryptionError);
    });

    it("rejects a modified iv", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      const forged: EncryptedValue = { ...sealed, iv: tamper(sealed.iv) };
      expect(() => decrypt(forged)).toThrow(DecryptionError);
    });

    it("rejects an authTag of the wrong length", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      expect(() => decrypt({ ...sealed, authTag: "AAAA" })).toThrow(
        /authTag must be 16 bytes/,
      );
    });

    it("rejects an iv of the wrong length", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      expect(() => decrypt({ ...sealed, iv: "AAAA" })).toThrow(/iv must be 12 bytes/);
    });

    it("rejects an unknown key version", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      expect(() => decrypt({ ...sealed, keyVersion: 99 })).toThrow(
        /no key available for keyVersion 99/,
      );
    });

    it("does not leak plaintext in the failure message", () => {
      const sealed = encrypt(REFRESH_TOKEN);
      try {
        decrypt({ ...sealed, ciphertext: tamper(sealed.ciphertext) });
        expect.unreachable("decrypt should have thrown");
      } catch (error) {
        expect(String(error)).not.toContain("refresh-token_value");
      }
    });
  });

  describe("safeEqual", () => {
    it("is true for identical strings and false otherwise", () => {
      expect(safeEqual("abc123", "abc123")).toBe(true);
      expect(safeEqual("abc123", "abc124")).toBe(false);
      expect(safeEqual("abc", "abcd")).toBe(false);
      expect(safeEqual("", "")).toBe(true);
    });
  });
});
