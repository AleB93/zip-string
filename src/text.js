// Bytes ⇄ URL-safe text.

// ── base64url: native Uint8Array.toBase64 / fromBase64 when available ──
export const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;

export const hasNativeBase64 =
  typeof Uint8Array.prototype.toBase64 === "function" && typeof Uint8Array.fromBase64 === "function";

export function toBase64url(bytes, native = hasNativeBase64) {
  if (native) return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
  let s = "";
  const n = bytes.length, full = n - (n % 3);
  for (let i = 0; i < full; i += 3) {
    const x = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[x >> 18] + B64[(x >> 12) & 63] + B64[(x >> 6) & 63] + B64[x & 63];
  }
  if (n - full === 1) {
    const x = bytes[full] << 16;
    s += B64[x >> 18] + B64[(x >> 12) & 63];
  } else if (n - full === 2) {
    const x = (bytes[full] << 16) | (bytes[full + 1] << 8);
    s += B64[x >> 18] + B64[(x >> 12) & 63] + B64[(x >> 6) & 63];
  }
  return s;
}

export function fromBase64url(s, native = hasNativeBase64) {
  // Strict: only the canonical encoding of some bytes is accepted. A length of
  // 4k+1 can't come from any byte string, and the unused low bits of the last
  // char must be zero — otherwise several strings would decode to the same bytes.
  const rem = s.length % 4;
  if (rem === 1) throw new Error("zip-string: invalid data length");
  if (rem) {
    const c = s.charCodeAt(s.length - 1);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) throw new Error("zip-string: invalid character in data");
    if (v & (rem === 2 ? 15 : 3)) throw new Error("zip-string: invalid data (non-canonical ending)");
  }
  if (native) {
    const out = Uint8Array.fromBase64(s, { alphabet: "base64url", lastChunkHandling: "loose" });
    // the native decoder skips ASCII whitespace; a strict decoder must not
    if (out.length !== (s.length * 3) >> 2) throw new Error("zip-string: invalid character in data");
    return out;
  }
  const out = new Uint8Array((s.length * 3) >> 2);
  let buf = 0, bits = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) throw new Error("zip-string: invalid character in data");
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
  }
  return out;
}

// ── base77: every character a #fragment allows unescaped, minus ' ( ) & ──
// 32-byte blocks → 41 chars (1.281 chars/byte vs base64's 1.333: ~4% shorter).
// Big-number base conversion done on 32-bit limbs with plain doubles (no BigInt).
export const B77 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$*+,;=:@/?";
const BASE = 77;
const BLOCK = 32;
const B77_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE; i++) B77_LOOKUP[B77.charCodeAt(i)] = i;
const CHARS = new Uint8Array(BLOCK + 1); // bytes → chars
const BYTES = new Int8Array(64).fill(-1); // chars → bytes
for (let n = 1; n <= BLOCK; n++) {
  CHARS[n] = Math.ceil((n * 8) / Math.log2(BASE));
  BYTES[CHARS[n]] = n;
}
const FULL = CHARS[BLOCK];
// Work in 24-bit limbs and 3 digits at a time (77³ = 456533), so every
// intermediate stays below 2^53 and we do ~3× fewer divisions.
const L = 2 ** 24;
const D3 = BASE * BASE * BASE;
const POW = [1, BASE, BASE * BASE, D3];
const B77_CODES = Uint8Array.from(B77, (c) => c.charCodeAt(0));
const ascii = new TextDecoder();

export function toBase77(bytes) {
  const nFull = Math.floor(bytes.length / BLOCK);
  const rest = bytes.length - nFull * BLOCK;
  const out = new Uint8Array(nFull * FULL + (rest ? CHARS[rest] : 0));
  const limbs = new Float64Array(11);
  const digits = new Uint8Array(FULL + 2);
  let o = 0;
  for (let off = 0; off < bytes.length; off += BLOCK) {
    const len = Math.min(BLOCK, bytes.length - off);
    // big-endian bytes → 24-bit limbs (first limb may be partial)
    let nl = 0, acc = 0, take = len % 3 || 3;
    for (let i = 0; i < len; i++) {
      acc = acc * 256 + bytes[off + i];
      if (--take === 0) { limbs[nl++] = acc; acc = 0; take = 3; }
    }
    const k = CHARS[len];
    const groups = Math.ceil(k / 3);
    let first = 0;
    for (let g = 0; g < groups; g++) {
      let rem = 0;
      for (let j = first; j < nl; j++) {
        const cur = rem * L + limbs[j];
        const q = Math.floor(cur / D3);
        limbs[j] = q;
        rem = cur - q * D3;
      }
      while (first < nl && limbs[first] === 0) first++;
      // rem holds 3 base-77 digits, least significant first
      const p = groups * 3 - 1 - g * 3;
      const r1 = Math.floor(rem / BASE), r2 = Math.floor(r1 / BASE);
      digits[p] = rem - r1 * BASE;
      digits[p - 1] = r1 - r2 * BASE;
      digits[p - 2] = r2;
    }
    // the top (groups*3 - k) digits are always 0
    for (let d = groups * 3 - k; d < groups * 3; d++) out[o++] = B77_CODES[digits[d]];
  }
  return ascii.decode(out);
}

export function fromBase77(s) {
  const nBlocks = Math.ceil(s.length / FULL);
  const lastChars = s.length - (nBlocks - 1) * FULL;
  const lastBytes = BYTES[lastChars];
  if (s.length && !(lastBytes > 0)) throw new Error("zip-string: invalid data length");
  const out = new Uint8Array(s.length ? (nBlocks - 1) * BLOCK + lastBytes : 0);
  const limbs = new Float64Array(11);
  let o = 0;
  for (let off = 0; off < s.length; off += FULL) {
    const k = Math.min(FULL, s.length - off);
    const len = BYTES[k];
    const nl = Math.ceil(len / 3);
    limbs.fill(0);
    // consume digits in groups of up to 3 (first group takes the remainder)
    for (let i = 0, g = k % 3 || 3; i < k; i += g, g = 3) {
      let carry = 0;
      for (let t = 0; t < g; t++) {
        const c = s.charCodeAt(off + i + t);
        const v = c < 128 ? B77_LOOKUP[c] : -1;
        if (v < 0) throw new Error("zip-string: invalid character in data");
        carry = carry * BASE + v;
      }
      const mul = POW[g];
      for (let j = nl - 1; j >= 0; j--) {
        const cur = limbs[j] * mul + carry;
        carry = Math.floor(cur / L);
        limbs[j] = cur - carry * L;
      }
      if (carry !== 0) throw new Error("zip-string: invalid data (value out of range)");
    }
    // reject non-canonical input: the top limb must fit in its partial width
    if (limbs[0] >= 2 ** (8 * (len % 3 || 3))) throw new Error("zip-string: invalid data (value out of range)");
    // 24-bit limbs → big-endian bytes
    let take = len % 3 || 3;
    for (let j = 0; j < nl; j++) {
      const v = limbs[j];
      if (take === 3) out[o++] = v >>> 16;
      if (take >= 2) out[o++] = (v >>> 8) & 255;
      out[o++] = v & 255;
      take = 3;
    }
  }
  return out;
}
