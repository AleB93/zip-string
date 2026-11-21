// zip-string — pack JSON data into the shortest URL-safe string.
// encode/decode are synchronous; encrypt/decrypt are async (Web Crypto).
import { deflateSync, inflateSync } from "fflate";
import { serialize, deserialize, dictionaryStrings } from "./binary.js";
export { setCodegen } from "./binary.js";
import { B64, toBase64url, fromBase64url, toBase77, fromBase77 } from "./text.js";
import {
  MODE_KEY, MODE_PASSWORD, SALT_BYTES, IV_BYTES, TAG_BYTES, DEFAULT_ITERATIONS, MIN_ITERATIONS, MAX_ITERATIONS,
  MIN_PASSWORD_LENGTH, randomBytes, importKey, passwordKey, seal, open, generateKey,
} from "./crypto.js";
export { generateKey };

// Header: 1 char = B64[0b1xxxx | flags]. Version 2 owns indexes 32..63.
const V2 = 32;
const F_B77 = 1, F_DICT = 2, F_DEFLATE = 4, F_ENC = 8;

// Node's native zlib (Node ≥ 22.3), used by default in Node: faster than fflate. Browsers use fflate.
const zlib = globalThis.process?.getBuiltinModule?.("node:zlib") ?? null;

const dictCache = new WeakMap();
function prepDict(dict) {
  let d = dictCache.get(dict);
  if (!d) {
    if (!(dict instanceof Uint8Array)) throw new TypeError("zip-string: dictionary must be a Uint8Array from createDictionary()");
    let h = 0;
    for (let i = 0; i < dict.length; i++) h = (Math.imul(h, 31) + dict[i]) | 0;
    d = {
      strings: dictionaryStrings(dict),
      zdict: dict.length > 32768 ? dict.subarray(dict.length - 32768) : dict,
      check: B64[(h >>> 0) % 64],
    };
    dictCache.set(dict, d);
  }
  return d;
}

/**
 * Build a dictionary from sample data shaped like what you will encode.
 * Pass the same dictionary to encode() and decode(). Store/ship it with
 * your app (e.g. as base64) — it is NOT included in the URL.
 */
export function createDictionary(...samples) {
  return serialize(samples).slice();
}

// data → { flags: F_DICT|F_DEFLATE, d, bytes }
function compress(data, dictionary, level = 6, native = true) {
  const useZlib = native && zlib !== null;
  const d = dictionary ? prepDict(dictionary) : null;
  const raw = serialize(data, d?.strings);
  let flags = d ? F_DICT : 0;
  let bytes = raw;
  if (level > 0) {
    const opts = d ? { level, dictionary: d.zdict } : { level };
    let z = useZlib ? zlib.deflateRawSync(raw, opts) : deflateSync(raw, opts);
    // tiny inputs: the two deflaters pick different block types; keep the smaller (costs µs)
    if (useZlib && raw.length < 2048) {
      const f = deflateSync(raw, opts);
      if (f.length < z.length) z = f;
    }
    if (z.length < raw.length) { bytes = z; flags |= F_DEFLATE; }
  }
  return { flags, d, bytes };
}

function expand(flags, bytes, d, native = true) {
  if (flags & F_DEFLATE) {
    bytes = native && zlib !== null
      ? new Uint8Array(zlib.inflateRawSync(bytes, d ? { dictionary: d.zdict } : {}))
      : inflateSync(bytes, d ? { dictionary: d.zdict } : undefined);
  }
  return deserialize(bytes, d?.strings);
}

function needDict(dictionary, check) {
  if (!dictionary) throw new Error("zip-string: this string needs a dictionary");
  const d = prepDict(dictionary);
  if (check !== d.check) throw new Error("zip-string: wrong dictionary");
  return d;
}

const toText = (flags, bytes) => (flags & F_B77 ? toBase77(bytes) : toBase64url(bytes));
const fromText = (flags, s) => (flags & F_B77 ? fromBase77(s) : fromBase64url(s));

function header(str) {
  const h = typeof str === "string" && str.length ? B64.indexOf(str[0]) : -1;
  if (h < V2) throw new Error("zip-string: not a zip-string string (or an unsupported version)");
  return h & 31;
}

/**
 * @param {any} data JSON-compatible value
 * @param {object} [o]
 * @param {"hash"|"query"} [o.target="hash"] "hash": ~4% shorter, only for #fragments. "query": base64url, safe anywhere.
 * @param {Uint8Array} [o.dictionary] from createDictionary(); big wins on small payloads
 * @param {number} [o.level=6] deflate level 0–9
 * @param {boolean} [o.native=true] use Node's zlib when available
 * @returns {string}
 */
export function encode(data, { target = "hash", dictionary, level, native = true } = {}) {
  const { flags: inner, d, bytes } = compress(data, dictionary, level, native);
  const flags = inner | (target === "hash" ? F_B77 : 0);
  return B64[V2 | flags] + (d ? d.check : "") + toText(flags, bytes);
}

/**
 * @param {string} str output of encode()
 * @param {object} [o]
 * @param {Uint8Array} [o.dictionary] required if the string was encoded with one
 * @param {boolean} [o.native=true] use Node's zlib when available
 */
export function decode(str, { dictionary, native = true } = {}) {
  const flags = header(str);
  if (flags & F_ENC) throw new Error("zip-string: this string is encrypted — use decrypt()");
  let body = str.slice(1);
  let d = null;
  if (flags & F_DICT) { d = needDict(dictionary, body[0]); body = body.slice(1); }
  return expand(flags, fromText(flags, body), d, native);
}

/** True if the string was made by encrypt(). */
export function isEncrypted(str) {
  try { return (header(str) & F_ENC) !== 0; } catch { return false; }
}

/*
 * Encrypted string layout (after the header char, in the chosen alphabet):
 *   mode (1 byte: 1 = key, 2 = password)
 *   [password only] iterations (uint32 BE) · salt (16 bytes)
 *   iv (12 bytes) · AES-256-GCM ciphertext + 16-byte tag
 * Plaintext: inner flags (dictionary / deflate) · [dictionary check] · payload.
 * The header char and every byte before the ciphertext are authenticated
 * (GCM additional data), so none of them can be altered without detection.
 */

/**
 * Encrypt data into a URL-safe string. Exactly one of `password` or `key` is required.
 * @param {any} data
 * @param {object} o
 * @param {string} [o.password] at least 8 characters; key derived with PBKDF2-SHA256
 * @param {string|Uint8Array|CryptoKey} [o.key] from generateKey() (32 random bytes)
 * @param {number} [o.iterations=600000] PBKDF2 iterations (password only)
 * @returns {Promise<string>}
 */
export async function encrypt(data, { password, key, iterations = DEFAULT_ITERATIONS, target = "hash", dictionary, level, native = true } = {}) {
  if ((password == null) === (key == null)) throw new TypeError("zip-string: encrypt() needs exactly one of `password` or `key`");
  const { flags: inner, d, bytes } = compress(data, dictionary, level, native);
  const plaintext = new Uint8Array(2 + bytes.length);
  plaintext[0] = inner;
  let p = 1;
  if (d) plaintext[p++] = B64.indexOf(d.check);
  plaintext.set(bytes, p);
  const body = plaintext.subarray(0, p + bytes.length);

  const flags = F_ENC | (target === "hash" ? F_B77 : 0);
  const head = B64[V2 | flags];
  let prefix, cryptoKey;
  const iv = randomBytes(IV_BYTES);
  if (password != null) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new TypeError(`zip-string: password must be a string of at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
      throw new RangeError(`zip-string: iterations must be between ${MIN_ITERATIONS} and ${MAX_ITERATIONS}`);
    }
    const salt = randomBytes(SALT_BYTES);
    prefix = new Uint8Array(1 + 4 + SALT_BYTES + IV_BYTES);
    prefix[0] = MODE_PASSWORD;
    new DataView(prefix.buffer).setUint32(1, iterations);
    prefix.set(salt, 5);
    prefix.set(iv, 5 + SALT_BYTES);
    cryptoKey = await passwordKey(password, salt, iterations);
  } else {
    prefix = new Uint8Array(1 + IV_BYTES);
    prefix[0] = MODE_KEY;
    prefix.set(iv, 1);
    cryptoKey = await importKey(key);
  }
  const ct = await seal(cryptoKey, iv, body, aad(head, prefix));
  const out = new Uint8Array(prefix.length + ct.length);
  out.set(prefix);
  out.set(ct, prefix.length);
  return head + toText(flags, out);
}

/**
 * Decrypt a string made by encrypt(). Rejects if the key/password is wrong or the
 * string was modified in any way.
 * @param {string} str
 * @param {object} o
 * @param {string} [o.password]
 * @param {string|Uint8Array|CryptoKey} [o.key]
 * @param {Uint8Array} [o.dictionary] required if one was used to encrypt
 * @returns {Promise<any>}
 */
export async function decrypt(str, { password, key, dictionary, native = true } = {}) {
  const flags = header(str);
  if (!(flags & F_ENC)) throw new Error("zip-string: this string is not encrypted — use decode()");
  const head = str[0];
  const bytes = fromText(flags, str.slice(1));
  const mode = bytes[0];
  let prefixLen, cryptoKey;
  if (mode === MODE_PASSWORD) {
    if (password == null) throw new Error("zip-string: this string needs a password");
    prefixLen = 1 + 4 + SALT_BYTES + IV_BYTES;
    if (bytes.length < prefixLen + TAG_BYTES) throw new Error("zip-string: truncated data");
    const iterations = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
    if (iterations < 1000 || iterations > MAX_ITERATIONS) throw new Error("zip-string: refusing unsafe key-derivation settings in this link");
    cryptoKey = await passwordKey(String(password), bytes.slice(5, 5 + SALT_BYTES), iterations);
  } else if (mode === MODE_KEY) {
    if (key == null) throw new Error("zip-string: this string needs a key");
    prefixLen = 1 + IV_BYTES;
    if (bytes.length < prefixLen + TAG_BYTES) throw new Error("zip-string: truncated data");
    cryptoKey = await importKey(key);
  } else {
    throw new Error("zip-string: unknown encryption mode");
  }
  const prefix = bytes.subarray(0, prefixLen);
  const iv = bytes.slice(prefixLen - IV_BYTES, prefixLen);
  const body = await open(cryptoKey, iv, bytes.subarray(prefixLen), aad(head, prefix));

  const inner = body[0];
  let p = 1, d = null;
  if (inner & F_DICT) d = needDict(dictionary, B64[body[p++]]);
  return expand(inner, body.subarray(p), d, native);
}

function aad(head, prefix) {
  const a = new Uint8Array(1 + prefix.length);
  a[0] = head.charCodeAt(0);
  a.set(prefix, 1);
  return a;
}

/** Decode the current page's #fragment, or null if empty. */
export function decodeHash(options, loc = globalThis.location) {
  const s = decodeURIComponent(loc.hash.slice(1));
  return s ? decode(s, options) : null;
}
