// packurl.js — squeeze JSON into the shortest possible URL-safe string.
// Zero dependencies. Works in modern browsers and Node 18+.
//
// Pipeline:  JSON value
//   → columnar transform  (array of same-shape objects → columns; delta-encoded
//                          numbers; dictionary-encoded repetitive strings)
//   → JSON text → deflate-raw (level 9 in Node, browser default otherwise)
//   → text alphabet: "hash" (77 chars, ~4% shorter, for #fragment)
//                    "query" (base64url, safe inside ?a=b&c=d)
//
// Every column transform is verified by decoding it back; if it would not
// round-trip exactly, that column is stored raw. So decode(encode(x)) deep-equals x
// (for plain JSON data: no undefined, NaN, Infinity, Dates, Maps…).

const VERSION = 1;
const TAG = "\u0001"; // marker prefix for transformed arrays
const T_COLS = TAG + "c";
const T_ESC = TAG + "e"; // escapes a real array whose first item starts with TAG

// ───────────────────────── 1. structural transform ─────────────────────────

function sameKeys(arr) {
  if (arr.length < 2) return null;
  const first = arr[0];
  if (!isPlainObject(first)) return null;
  const keys = Object.keys(first);
  if (keys.length === 0) return null;
  for (let i = 1; i < arr.length; i++) {
    const o = arr[i];
    if (!isPlainObject(o)) return null;
    const k = Object.keys(o);
    if (k.length !== keys.length) return null;
    for (const key of keys) if (!Object.hasOwn(o, key)) return null;
  }
  return keys;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];

// Smallest number of decimals d so every value is an exact multiple of 10^-d.
function decimalsOf(values) {
  let d = 0;
  for (const v of values) {
    while (d < POW10.length && Math.round(v * POW10[d]) / POW10[d] !== v) d++;
    if (d >= POW10.length) return -1;
  }
  return d;
}

function encodeColumn(values) {
  const n = values.length;
  const candidates = [["r", values.map(pack)]];

  // numbers: scale to integers, then delta-encode (great for timestamps, sorted ids, series)
  if (values.every((v) => typeof v === "number" && Number.isFinite(v))) {
    const d = decimalsOf(values);
    if (d >= 0) {
      const s = POW10[d];
      const ints = values.map((v) => Math.round(v * s));
      if (ints.every(Number.isSafeInteger)) {
        const deltas = ints.map((v, i) => (i ? v - ints[i - 1] : v));
        candidates.push(["d", d, deltas]);
        if (d > 0) candidates.push(["s", d, ints]);
      }
    }
  }

  // booleans → 0/1
  if (values.every((v) => typeof v === "boolean")) {
    candidates.push(["b", values.map((v) => (v ? 1 : 0))]);
  }

  // repetitive primitives → dictionary + indices
  if (values.every((v) => v === null || typeof v !== "object")) {
    const dict = [];
    const index = new Map();
    const idx = values.map((v) => {
      const key = typeof v + ":" + v;
      let i = index.get(key);
      if (i === undefined) index.set(key, (i = dict.push(v) - 1));
      return i;
    });
    if (dict.length <= n / 2) candidates.push(["k", dict, idx]);
  }

  // pick the shortest JSON that round-trips exactly
  let best = candidates[0];
  let bestLen = JSON.stringify(best).length;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const len = JSON.stringify(c).length;
    if (len < bestLen && sameArray(decodeColumn(c, n), values)) {
      best = c;
      bestLen = len;
    }
  }
  return best;
}

function decodeColumn(col, n) {
  switch (col[0]) {
    case "r": return col[1].map(unpack);
    case "b": return col[1].map((v) => v === 1);
    case "k": return col[2].map((i) => col[1][i]);
    case "s": { const s = POW10[col[1]]; return col[2].map((v) => v / s); }
    case "d": {
      const s = POW10[col[1]], out = new Array(n);
      let acc = 0;
      for (let i = 0; i < n; i++) { acc += col[2][i]; out[i] = acc / s; }
      return out;
    }
    default: throw new Error("packurl: unknown column type " + col[0]);
  }
}

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && a[i] !== b[i]) return false;
  return true;
}

export function pack(v) {
  if (Array.isArray(v)) {
    const keys = sameKeys(v);
    if (keys) {
      return [T_COLS, keys, v.length, keys.map((k) => encodeColumn(v.map((o) => o[k])))];
    }
    const out = v.map(pack);
    if (typeof out[0] === "string" && out[0].startsWith(TAG)) out.unshift(T_ESC);
    return out;
  }
  if (isPlainObject(v)) {
    const out = {};
    for (const k in v) out[k] = pack(v[k]);
    return out;
  }
  return v;
}

export function unpack(v) {
  if (Array.isArray(v)) {
    if (v[0] === T_COLS) {
      const [, keys, n, cols] = v;
      const data = cols.map((c) => decodeColumn(c, n));
      const rows = new Array(n);
      for (let i = 0; i < n; i++) {
        const o = {};
        for (let j = 0; j < keys.length; j++) o[keys[j]] = data[j][i];
        rows[i] = o;
      }
      return rows;
    }
    if (v[0] === T_ESC) return v.slice(1).map(unpack);
    return v.map(unpack);
  }
  if (isPlainObject(v)) {
    const out = {};
    for (const k in v) out[k] = unpack(v[k]);
    return out;
  }
  return v;
}

// ───────────────────────── 2. deflate ─────────────────────────

const isNode = typeof process !== "undefined" && !!process.versions?.node;

async function deflate(bytes) {
  if (isNode) {
    const zlib = await import("node:zlib");
    return new Uint8Array(zlib.deflateRawSync(bytes, { level: 9, memLevel: 9 }));
  }
  return streamBytes(bytes, new CompressionStream("deflate-raw"));
}

async function inflate(bytes) {
  return streamBytes(bytes, new DecompressionStream("deflate-raw"));
}

async function streamBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ───────────────────────── 3. text alphabets ─────────────────────────

// base64url — safe anywhere, including inside ?query=strings
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) s += B64[(n >> (18 - 6 * j)) & 63];
  }
  return s;
}

function fromBase64url(s) {
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let buf = 0, bits = 0, o = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("packurl: bad base64url char " + ch);
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
  }
  return out;
}

// base77 — every char that a #fragment allows unescaped, minus ones that
// chat apps / linkifiers commonly mangle ( ' ( ) & ). ~4% shorter than base64.
// NOT safe in ?query (+ becomes space, = and & split params).
const B77 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$*+,;=:@/?";
const BASE = BigInt(B77.length);
const BLOCK = 32; // bytes per block
const charsFor = (n) => Math.ceil((n * 8) / Math.log2(B77.length));

function toBase77(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += BLOCK) {
    const chunk = bytes.subarray(i, i + BLOCK);
    let n = 0n;
    for (const b of chunk) n = (n << 8n) | BigInt(b);
    let part = "";
    for (let k = charsFor(chunk.length); k > 0; k--) { part = B77[Number(n % BASE)] + part; n /= BASE; }
    s += part;
  }
  return s;
}

function fromBase77(s) {
  const full = charsFor(BLOCK);
  const out = [];
  for (let i = 0; i < s.length; i += full) {
    const part = s.slice(i, i + full);
    let len = BLOCK;
    while (len > 0 && charsFor(len) !== part.length) len--;
    if (!len) throw new Error("packurl: bad base77 length");
    let n = 0n;
    for (const ch of part) {
      const v = B77.indexOf(ch);
      if (v < 0) throw new Error("packurl: bad base77 char " + ch);
      n = n * BASE + BigInt(v);
    }
    const bytes = new Array(len);
    for (let j = len - 1; j >= 0; j--) { bytes[j] = Number(n & 255n); n >>= 8n; }
    out.push(...bytes);
  }
  return new Uint8Array(out);
}

// ───────────────────────── public API ─────────────────────────

/**
 * @param {any} data  JSON-compatible value
 * @param {{target?: "hash"|"query", transform?: boolean}} [opts]
 * @returns {Promise<string>} URL-safe string. First char = format version/alphabet.
 */
export async function encode(data, { target = "hash", transform = true } = {}) {
  const json = JSON.stringify(transform ? pack(data) : data);
  const z = await deflate(new TextEncoder().encode(json));
  // header char: version + alphabet + whether transform was used
  const flags = (target === "hash" ? 1 : 0) | (transform ? 2 : 0);
  const header = B64[VERSION * 4 + flags];
  return header + (target === "hash" ? toBase77(z) : toBase64url(z));
}

/** @param {string} str  output of encode() (URL-decoded if it came from URLSearchParams) */
export async function decode(str) {
  const h = B64.indexOf(str[0]);
  if (h >> 2 !== VERSION) throw new Error("packurl: unsupported version");
  const body = str.slice(1);
  const z = h & 1 ? fromBase77(body) : fromBase64url(body);
  const value = JSON.parse(new TextDecoder().decode(await inflate(z)));
  return h & 2 ? unpack(value) : value;
}

/** Read data from the current page's #fragment (browser only). */
export function decodeFromLocation(loc = globalThis.location) {
  const s = decodeURIComponent(loc.hash.slice(1)); // some browsers/apps re-escape chars
  return s ? decode(s) : Promise.resolve(null);
}
