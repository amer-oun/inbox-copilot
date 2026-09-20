import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "./env.js";

/**
 * AES-256-GCM envelope encryption for the OAuth token vault (rule 3, §8).
 *
 * Every ciphertext carries its own random 96-bit iv and its 128-bit auth tag.
 * `keyVersion` is stamped on the row so keys can be rotated without a
 * big-bang re-encryption: old rows decrypt with the old key until touched.
 *
 * Nothing in this module logs. Callers must not log the return value either —
 * `encrypt()` output is ciphertext, but `decrypt()` output is a live token.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the value GCM is specified for
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface EncryptedValue {
  /** base64 ciphertext. */
  ciphertext: string;
  /** base64 initialization vector — unique per encryption, never reused. */
  iv: string;
  /** base64 GCM authentication tag. */
  authTag: string;
  /** Which key encrypted this. */
  keyVersion: number;
}

/** Thrown when a ciphertext fails authentication or is malformed. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

interface KeyEntry {
  version: number;
  key: Buffer;
}

function loadKeys(): { current: KeyEntry; byVersion: Map<number, KeyEntry> } {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");
  if (key.length !== KEY_BYTES) {
    // env.ts already checks this; belt and braces, because getting it wrong
    // here means either a crash or a weak key.
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes`);
  }
  const current: KeyEntry = { version: env.TOKEN_ENCRYPTION_KEY_VERSION, key };
  return { current, byVersion: new Map([[current.version, current]]) };
}

const keys = loadKeys();

function keyFor(version: number): Buffer {
  const entry = keys.byVersion.get(version);
  if (!entry) {
    throw new DecryptionError(`no key available for keyVersion ${version}`);
  }
  return entry.key;
}

/** Current key version — stamp it on rows written now. */
export const currentKeyVersion: number = keys.current.version;

export function encrypt(plaintext: string): EncryptedValue {
  if (plaintext.length === 0) {
    throw new Error("refusing to encrypt an empty value");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keys.current.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: keys.current.version,
  };
}

export function decrypt(value: EncryptedValue): string {
  const iv = Buffer.from(value.iv, "base64");
  const authTag = Buffer.from(value.authTag, "base64");
  const ciphertext = Buffer.from(value.ciphertext, "base64");

  if (iv.length !== IV_BYTES) {
    throw new DecryptionError(`iv must be ${IV_BYTES} bytes`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new DecryptionError(`authTag must be ${AUTH_TAG_BYTES} bytes`);
  }

  const decipher = createDecipheriv(ALGORITHM, keyFor(value.keyVersion), iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // GCM tag mismatch: the ciphertext, iv, tag, or key is wrong. The original
    // message is deliberately dropped — it tells an attacker nothing useful and
    // could end up in a log line.
    throw new DecryptionError("authentication failed: ciphertext was tampered with");
  }
}

/**
 * Constant-time compare for secrets that arrive from outside (state HMACs,
 * webhook clientState). `===` on secrets leaks length and prefix by timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
