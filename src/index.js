// zip-string — pack JSON data into the shortest URL-safe string. Synchronous API.
import { deflateSync, inflateSync } from "fflate";
import { serialize, deserialize, dictionaryStrings } from "./binary.js";
export { setCodegen } from "./binary.js";
import { B64, toBase64url, fromBase64url, toBase77, fromBase77 } from "./text.js";

// Header: 1 char = B64[0b1xxxx | flags]. Version 2 owns indexes 32..63.
const V2 = 32;
const F_B77 = 1, F_DICT = 2, F_DEFLATE = 4;

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

/**
 * @param {any} data JSON-compatible value
 * @param {object} [o]
 * @param {"hash"|"query"} [o.target="hash"] "hash": ~4% shorter, only for #fragments. "query": base64url, safe anywhere.
 * @param {Uint8Array} [o.dictionary] from createDictionary(); big wins on small payloads
 * @param {number} [o.level] deflate level 0–9 (default: 9 with Node's zlib, 6 with fflate)
 * @param {boolean} [o.native] use Node's zlib (default: true when running in Node)
 * @returns {string}
 */
export function encode(data, { target = "hash", dictionary, level, native = true } = {}) {
  const useZlib = native && zlib !== null;
  level ??= 6;
  const d = dictionary ? prepDict(dictionary) : null;
  const raw = serialize(data, d?.strings);
  let flags = 0;
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
  if (target === "hash") flags |= F_B77;
  if (d) flags |= F_DICT;
  return B64[V2 | flags] + (d ? d.check : "") + (flags & F_B77 ? toBase77(bytes) : toBase64url(bytes));
}

/**
 * @param {string} str output of encode()
 * @param {object} [o]
 * @param {Uint8Array} [o.dictionary] required if the string was encoded with one
 * @param {boolean} [o.native] use Node's zlib (default: true when running in Node)
 */
export function decode(str, { dictionary, native = true } = {}) {
  const h = B64.indexOf(str[0]);
  if (h < V2) throw new Error("zip-string: not a zip-string string (or an unsupported version)");
  const flags = h & 31;
  let body = str.slice(1);
  let d = null;
  if (flags & F_DICT) {
    if (!dictionary) throw new Error("zip-string: this string needs a dictionary");
    d = prepDict(dictionary);
    if (body[0] !== d.check) throw new Error("zip-string: wrong dictionary");
    body = body.slice(1);
  }
  let bytes = flags & F_B77 ? fromBase77(body) : fromBase64url(body);
  if (flags & F_DEFLATE) {
    bytes = native && zlib !== null
      ? new Uint8Array(zlib.inflateRawSync(bytes, d ? { dictionary: d.zdict } : {}))
      : inflateSync(bytes, d ? { dictionary: d.zdict } : undefined);
  }
  return deserialize(bytes, d?.strings);
}

/** Decode the current page's #fragment, or null if empty. */
export function decodeHash(options, loc = globalThis.location) {
  const s = decodeURIComponent(loc.hash.slice(1));
  return s ? decode(s, options) : null;
}
