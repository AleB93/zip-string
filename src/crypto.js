// AES-256-GCM via Web Crypto (browsers in secure contexts, Node ≥ 20).
// No custom cryptography: key derivation, encryption and authentication are
// all done by the platform.
import { toBase64url, fromBase64url } from "./text.js";

export const MODE_KEY = 1, MODE_PASSWORD = 2;
export const KEY_BYTES = 32, SALT_BYTES = 16, IV_BYTES = 12, TAG_BYTES = 16;
export const DEFAULT_ITERATIONS = 600_000; // OWASP 2023 recommendation for PBKDF2-HMAC-SHA256
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 2_000_000; // hard cap (3× the default): a crafted link can't hang a page or a server
export const MIN_PASSWORD_LENGTH = 8;

function webcrypto() {
  const c = globalThis.crypto;
  if (c?.subtle && typeof c.getRandomValues === "function") return c;
  const node = globalThis.process?.getBuiltinModule?.("node:crypto")?.webcrypto;
  if (node?.subtle) return node;
  throw new Error("zip-string: encryption needs Web Crypto (a secure context — https or localhost — or Node ≥ 20)");
}

export function randomBytes(n) {
  return webcrypto().getRandomValues(new Uint8Array(n));
}

/** A new random 256-bit key as a 43-character base64url string. */
export function generateKey() {
  return toBase64url(randomBytes(KEY_BYTES));
}

/** Accepts a generateKey() string, 32 raw bytes, or an AES-GCM CryptoKey. */
export async function importKey(key) {
  const c = webcrypto();
  if (typeof CryptoKey !== "undefined" && key instanceof CryptoKey) {
    if (key.algorithm?.name !== "AES-GCM") throw new TypeError("zip-string: CryptoKey must be an AES-GCM key");
    return key;
  }
  let raw;
  if (typeof key === "string") {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new TypeError("zip-string: key must be a 43-character string from generateKey()");
    raw = fromBase64url(key);
  } else if (key instanceof Uint8Array) {
    raw = key;
  } else {
    throw new TypeError("zip-string: key must be a string from generateKey(), a Uint8Array or a CryptoKey");
  }
  if (raw.length !== KEY_BYTES) throw new TypeError(`zip-string: key must be ${KEY_BYTES} bytes`);
  return c.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function passwordKey(password, salt, iterations) {
  const c = webcrypto();
  const base = await c.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return c.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(key, iv, plaintext, aad) {
  const out = await webcrypto().subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  return new Uint8Array(out);
}

export async function open(key, iv, ciphertext, aad) {
  try {
    const out = await webcrypto().subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, ciphertext);
    return new Uint8Array(out);
  } catch {
    throw new Error("zip-string: cannot decrypt — wrong key or password, or the link was modified");
  }
}
