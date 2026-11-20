// Binary, columnar serialization of JSON values.
//
// Value tags (1 byte):
//   0 null · 1 false · 2 true · 3 int (zigzag varint) · 4 decimal (varint d, zigzag int → int/10^d)
//   5 float64 (8 bytes LE) · 6 string (strBody) · 7 array (varint n, values)
//   8 object (varint n, n × (strBody key, value)) · 9 table (tableBody)
//   64..255 → small non-negative int (tag - 64)
//
// strBody: varint h; h odd → reference to string #(h>>1) in the string table,
//          h even → new string of (h>>1) UTF-8 bytes, appended to the table.
//
// tableBody (array of objects, stored column by column):
//   varint rows, varint cols, cols × strBody key, then per column:
//   presence byte (0 = every row has it, 1 = bitmap of ceil(rows/8) bytes follows),
//   then the column's present values with one of the column codecs below.

const NULL = 0, FALSE = 1, TRUE = 2, INT = 3, DEC = 4, F64 = 5, STR = 6, ARR = 7, OBJ = 8, TABLE = 9;
const SMALL = 64, SMALL_MAX = 255 - SMALL;

// column codecs
const C_ANY = 0, C_INT = 1, C_DELTA = 2, C_BOOL = 3, C_DICT = 4, C_STR = 5, C_TABLE = 6, C_F64 = 7, C_CONST = 8, C_DELTA2 = 9, C_F64X = 10;

const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
const MAX_INT = 2 ** 52; // keeps zigzag(x) within Number.MAX_SAFE_INTEGER
const MAX_INTERN = 128; // longer strings are not added to the string table

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

// Strings with lone surrogates aren't valid UTF-16; JSON keeps them, so we do too
// by writing them as WTF-8 (UTF-8 that also allows encoded surrogates).
// Older runtimes lack isWellFormed: any surrogate takes the WTF-8 path, which
// encodes valid pairs exactly like UTF-8, so the output is the same.
const isWellFormed = typeof String.prototype.isWellFormed === "function"
  ? (s) => s.isWellFormed()
  : (s) => !/[\uD800-\uDFFF]/.test(s);

function wtf8Encode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes) {
  try {
    return textDecoder.decode(bytes);
  } catch {
    let s = "";
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i];
      let c;
      if (b < 0x80) { c = b; i += 1; }
      else if (b < 0xe0) { c = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; }
      else if (b < 0xf0) { c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
      else { c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4; }
      s += String.fromCodePoint(c);
    }
    return s;
  }
}
const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);
const f64w = new Uint32Array(f64.buffer); // [lo, hi] on little-endian hosts

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.toJSON !== "function";
const isInt = (v) => Number.isInteger(v) && v >= -MAX_INT && v <= MAX_INT; // -0 becomes 0, as in JSON

// ───────────────────────────── writer ─────────────────────────────

export class Writer {
  constructor(strings) {
    this.buf = new Uint8Array(1024);
    this.pos = 0;
    this.table = new Map();
    if (strings) for (const s of strings) this.table.set(s, this.table.size);
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }

  byte(b) {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  uint(n) {
    this.ensure(8);
    const buf = this.buf;
    if (n < 0x80000000) {
      while (n > 127) { buf[this.pos++] = (n & 127) | 128; n >>>= 7; }
    } else {
      while (n > 127) { buf[this.pos++] = (n % 128) | 128; n = Math.floor(n / 128); }
    }
    buf[this.pos++] = n;
  }

  sint(n) { this.uint(n >= 0 ? n * 2 : -n * 2 - 1); }

  float(v) {
    this.ensure(8);
    f64[0] = v;
    this.buf.set(f64b, this.pos);
    this.pos += 8;
  }

  str(s) {
    const table = this.table;
    const ref = table.get(s);
    if (ref !== undefined) return this.uint(ref * 2 + 1);
    if (s.length <= MAX_INTERN) table.set(s, table.size);
    const len = s.length;
    // ASCII fast path
    let ascii = true;
    for (let i = 0; i < len; i++) if (s.charCodeAt(i) > 127) { ascii = false; break; }
    if (ascii) {
      this.uint(len * 2);
      this.ensure(len);
      const buf = this.buf;
      for (let i = 0; i < len; i++) buf[this.pos + i] = s.charCodeAt(i);
      this.pos += len;
    } else {
      const bytes = isWellFormed(s) ? textEncoder.encode(s) : wtf8Encode(s);
      this.uint(bytes.length * 2);
      this.ensure(bytes.length);
      this.buf.set(bytes, this.pos);
      this.pos += bytes.length;
    }
  }

  number(v) {
    if (isInt(v)) {
      if (v >= 0 && v <= SMALL_MAX) return this.byte(SMALL + v);
      this.byte(INT);
      return this.sint(v);
    }
    if (Number.isFinite(v)) {
      for (let d = 1; d < POW10.length; d++) {
        const s = Math.round(v * POW10[d]);
        if (s / POW10[d] === v) {
          if (Math.abs(s) > MAX_INT) break;
          this.byte(DEC); this.uint(d); return this.sint(s);
        }
      }
    }
    this.byte(F64);
    this.float(v);
  }

  value(v) {
    switch (typeof v) {
      case "string": this.byte(STR); return this.str(v);
      case "number": return this.number(v);
      case "boolean": return this.byte(v ? TRUE : FALSE);
      case "object":
        if (v === null) return this.byte(NULL);
        if (Array.isArray(v)) return this.array(v);
        if (typeof v.toJSON === "function") return this.value(v.toJSON());
        return this.object(v);
      case "bigint": throw new TypeError("zip-string: BigInt is not supported");
      default: return this.byte(NULL); // undefined / function / symbol in arrays → null, like JSON
    }
  }

  object(o) {
    const keys = [];
    for (const k in o) {
      if (!Object.hasOwn(o, k)) continue;
      const t = typeof o[k];
      if (t !== "undefined" && t !== "function" && t !== "symbol") keys.push(k);
    }
    this.byte(OBJ);
    this.uint(keys.length);
    for (const k of keys) { this.str(k); this.value(o[k]); }
  }

  array(a) {
    const keys = a.length >= 2 && tableKeys(a);
    if (keys) { this.byte(TABLE); return this.table_(a, keys); }
    this.byte(ARR);
    this.uint(a.length);
    for (let i = 0; i < a.length; i++) this.value(a[i]);
  }

  table_(rows, keys) {
    const n = rows.length;
    this.uint(n);
    this.uint(keys.length);
    for (const k of keys) this.str(k);
    const bits = new Uint8Array((n + 7) >> 3);
    for (const k of keys) {
      // plain objects only inherit functions (skipped anyway) and __proto__
      const check = !keys.plain || k === "__proto__";
      const present = new Array(n);
      let m = 0;
      bits.fill(0);
      for (let i = 0; i < n; i++) {
        const row = rows[i];
        const v = row[k];
        const t = typeof v;
        if (t === "undefined" || t === "function" || t === "symbol" || (check && !Object.hasOwn(row, k))) continue;
        present[m++] = v;
        bits[i >> 3] |= 1 << (i & 7);
      }
      present.length = m;
      if (m === n) this.byte(0);
      else {
        this.byte(1);
        this.ensure(bits.length);
        this.buf.set(bits, this.pos);
        this.pos += bits.length;
      }
      this.column(present);
    }
  }

  column(vals) {
    const m = vals.length;
    if (m === 0) return this.byte(C_ANY);
    let nums = 0, strs = 0, bools = 0, objs = 0, nulls = 0;
    for (let i = 0; i < m; i++) {
      const v = vals[i];
      const t = typeof v;
      if (t === "number") nums++;
      else if (t === "string") strs++;
      else if (t === "boolean") bools++;
      else if (v === null) nulls++;
      else if (isObj(v)) objs++;
    }
    const prims = nums + strs + bools + nulls;

    if (nums === m) return this.numColumn(vals);
    if (bools === m) {
      this.byte(C_BOOL);
      const bits = new Uint8Array((m + 7) >> 3);
      for (let i = 0; i < m; i++) if (vals[i]) bits[i >> 3] |= 1 << (i & 7);
      this.ensure(bits.length);
      this.buf.set(bits, this.pos);
      this.pos += bits.length;
      return;
    }
    if (objs === m) {
      const keys = tableKeys(vals);
      if (keys) { this.byte(C_TABLE); return this.table_(vals, keys); }
    }
    if (prims === m) {
      // primitives: try a dictionary
      const dict = new Map();
      const idx = new Uint32Array(m);
      for (let i = 0; i < m; i++) {
        const v = vals[i];
        // Map keys compare by SameValueZero: "1", 1, true and null stay distinct
        let j = dict.get(v);
        if (j === undefined) {
          j = dict.size;
          dict.set(v, j);
          if (j > m >> 1) break;
        }
        idx[i] = j;
      }
      if (dict.size === 1) { this.byte(C_CONST); return this.value(vals[0]); }
      if (dict.size <= m >> 1) {
        this.byte(C_DICT);
        this.uint(dict.size);
        const seen = new Uint8Array(dict.size);
        for (let i = 0; i < m; i++) if (!seen[idx[i]]) { seen[idx[i]] = 1; this.value(vals[i]); }
        if (dict.size <= 256) {
          this.ensure(m);
          for (let i = 0; i < m; i++) this.buf[this.pos++] = idx[i];
        } else for (let i = 0; i < m; i++) this.uint(idx[i]);
        return;
      }
      if (strs === m) {
        this.byte(C_STR);
        for (let i = 0; i < m; i++) this.str(vals[i]);
        return;
      }
    }
    this.byte(C_ANY);
    for (let i = 0; i < m; i++) this.value(vals[i]);
  }

  numColumn(vals) {
    const m = vals.length;
    // smallest decimal scale that makes every value an exact integer
    let d = 0;
    for (let i = 0; i < m && d < POW10.length; i++) {
      const v = vals[i];
      if (!Number.isFinite(v)) { d = POW10.length; break; }
      while (d < POW10.length && Math.round(v * POW10[d]) / POW10[d] !== v) d++;
    }
    if (d < POW10.length) {
      const s = POW10[d];
      const ints = new Float64Array(m);
      let ok = true, plainCost = 0, deltaCost = 0, delta2Cost = 0, prev = 0, prevD = 0;
      for (let i = 0; i < m; i++) {
        const x = Math.round(vals[i] * s);
        const dx = x - prev;
        const ddx = dx - prevD;
        if (Math.abs(x) > MAX_INT || Math.abs(dx) > MAX_INT || Math.abs(ddx) > MAX_INT) { ok = false; break; }
        ints[i] = x;
        plainCost += varLen(x);
        deltaCost += varLen(dx);
        delta2Cost += varLen(ddx);
        prev = x;
        prevD = dx;
      }
      if (ok) {
        const best = Math.min(plainCost, deltaCost, delta2Cost);
        const type = best === plainCost ? C_INT : best === deltaCost ? C_DELTA : C_DELTA2;
        this.byte(type);
        this.uint(d);
        let p = 0, pd = 0;
        // zigzag values of the chosen transform
        const zz = new Float64Array(m);
        let max = 0;
        for (let i = 0; i < m; i++) {
          const x = ints[i];
          const y = type === C_INT ? x : type === C_DELTA ? x - p : x - p - pd;
          if (type === C_DELTA2) pd = x - p;
          p = x;
          const z = y >= 0 ? y * 2 : -y * 2 - 1;
          zz[i] = z;
          if (z > max) max = z;
        }
        let w = 1;
        while (w < 7 && max >= 2 ** (8 * w)) w++;
        if (m >= 16) {
          // byte planes: low bytes of every value, then next bytes, ...
          this.byte(w);
          this.ensure(m * w);
          const buf = this.buf, base = this.pos;
          if (w <= 4) {
            for (let b = 0; b < w; b++) {
              const off = base + b * m, sh = 8 * b;
              for (let i = 0; i < m; i++) buf[off + i] = zz[i] >>> sh; // Uint8Array store keeps the low 8 bits
            }
          } else {
            for (let i = 0; i < m; i++) {
              let z = zz[i];
              for (let b = 0; b < w; b++) { buf[base + b * m + i] = z % 256; z = Math.floor(z / 256); }
            }
          }
          this.pos += m * w;
        } else {
          this.byte(0);
          for (let i = 0; i < m; i++) this.uint(zz[i]);
        }
        return;
      }
    }
    // arbitrary doubles: byte-transposed so similar exponent bytes sit together
    // Two layouts, both byte-transposed (all top bytes, then next bytes…):
    //  raw — the doubles as they are
    //  XOR — each XORed with the previous one (Gorilla-style): smooth series
    //        turn into runs of zero bytes
    // Keep whichever has lower byte entropy, a good proxy for deflate size.
    const raw = new Uint8Array(m * 8), xor = new Uint8Array(m * 8);
    let ph = 0, pl = 0;
    for (let i = 0; i < m; i++) {
      f64[0] = vals[i];
      const hi = f64w[1], lo = f64w[0];
      const h = (hi ^ ph) >>> 0, l = (lo ^ pl) >>> 0;
      ph = hi; pl = lo;
      raw[i] = hi >>> 24; raw[m + i] = hi >>> 16; raw[2 * m + i] = hi >>> 8; raw[3 * m + i] = hi;
      raw[4 * m + i] = lo >>> 24; raw[5 * m + i] = lo >>> 16; raw[6 * m + i] = lo >>> 8; raw[7 * m + i] = lo;
      xor[i] = h >>> 24; xor[m + i] = h >>> 16; xor[2 * m + i] = h >>> 8; xor[3 * m + i] = h;
      xor[4 * m + i] = l >>> 24; xor[5 * m + i] = l >>> 16; xor[6 * m + i] = l >>> 8; xor[7 * m + i] = l;
    }
    const useXor = planeEntropy(xor, m) < planeEntropy(raw, m);
    this.byte(useXor ? C_F64X : C_F64);
    this.ensure(m * 8);
    this.buf.set(useXor ? xor : raw, this.pos);
    this.pos += m * 8;
  }

  finish() { return this.buf.subarray(0, this.pos); }
}

// Sum of order-0 entropy (bits) of each byte plane.
const hist = new Uint32Array(256);
function planeEntropy(bytes, m) {
  let bits = 0;
  for (let p = 0; p < 8; p++) {
    hist.fill(0);
    const off = p * m;
    for (let i = 0; i < m; i++) hist[bytes[off + i]]++;
    for (let k = 0; k < 256; k++) { const c = hist[k]; if (c) bits -= c * Math.log2(c / m); }
  }
  return bits;
}

const varLen = (x) => {
  const z = x >= 0 ? x * 2 : -x * 2 - 1;
  return z < 128 ? 1 : z < 16384 ? 2 : z < 2097152 ? 3 : z < 268435456 ? 4 : 5 + (z >= 34359738368 ? 2 : 0);
};

// Union of keys if the array is a good fit for column storage, else null.
function tableKeys(arr) {
  const n = arr.length;
  const seen = new Set();
  const order = []; // column order: a new key goes right after its predecessor in the row
  let filled = 0, plain = true;
  for (let i = 0; i < n; i++) {
    const o = arr[i];
    if (!isObj(o)) return null;
    if (plain) { const p = Object.getPrototypeOf(o); plain = p === Object.prototype || p === null; }
    const own = Object.keys(o);
    for (let j = 0; j < own.length; j++) {
      const k = own[j];
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > 64 && seen.size > n) return null; // looks like a map, not records
      const at = j === 0 ? 0 : order.indexOf(own[j - 1]) + 1;
      if (at === order.length) order.push(k);
      else order.splice(at, 0, k);
    }
    filled += own.length;
  }
  if (order.length === 0) return null;
  // need at least ~1/3 of the cells filled, otherwise rows don't share a shape
  if (filled * 3 < n * order.length) return null;
  order.plain = plain;
  return order;
}

// ───────────────────────────── reader ─────────────────────────────

// `o["__proto__"] = v` would set the prototype instead of creating a key
// (dropping the data, or letting a URL choose an object's prototype).
function setKey(o, k, v) {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else o[k] = v;
}

export class Reader {
  constructor(buf, strings) {
    this.buf = buf;
    this.pos = 0;
    this.table = strings ? strings.slice() : [];
  }

  uint() {
    const buf = this.buf;
    let b = buf[this.pos++];
    if (b < 128) return b;
    let n = b & 127, shift = 7;
    while (true) {
      b = buf[this.pos++];
      if (b === undefined) throw new Error("zip-string: truncated data");
      if (shift < 28) n |= (b & 127) << shift;
      else n += (b & 127) * 2 ** shift;
      if (b < 128) return n;
      shift += 7;
    }
  }

  sint() {
    const z = this.uint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  float() {
    for (let i = 0; i < 8; i++) f64b[i] = this.buf[this.pos + i];
    this.pos += 8;
    return f64[0];
  }

  str() {
    const h = this.uint();
    if (h & 1) {
      const s = this.table[(h - 1) / 2];
      if (s === undefined) throw new Error("zip-string: bad string reference (wrong dictionary?)");
      return s;
    }
    const len = h / 2;
    const buf = this.buf, start = this.pos, end = start + len;
    if (end > buf.length) throw new Error("zip-string: truncated data");
    let s;
    if (len < 48) {
      s = "";
      let i = start;
      for (; i < end; i++) {
        const c = buf[i];
        if (c > 127) break;
        s += String.fromCharCode(c);
      }
      if (i < end) s = utf8Decode(buf.subarray(start, end));
    } else s = utf8Decode(buf.subarray(start, end));
    this.pos = end;
    if (s.length <= MAX_INTERN) this.table.push(s);
    return s;
  }

  value() {
    const tag = this.buf[this.pos++];
    if (tag >= SMALL) return tag - SMALL;
    switch (tag) {
      case NULL: return null;
      case FALSE: return false;
      case TRUE: return true;
      case INT: return this.sint();
      case DEC: { const d = this.uint(); return this.sint() / POW10[d]; }
      case F64: return this.float();
      case STR: return this.str();
      case ARR: {
        const n = this.uint();
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = this.value();
        return a;
      }
      case OBJ: {
        const n = this.uint();
        const o = {};
        for (let i = 0; i < n; i++) { const k = this.str(); setKey(o, k, this.value()); }
        return o;
      }
      case TABLE: return this.table_();
      default: throw new Error("zip-string: corrupt data (tag " + tag + ")");
    }
  }

  table_() {
    const n = this.uint();
    const c = this.uint();
    const keys = new Array(c);
    for (let j = 0; j < c; j++) keys[j] = this.str();
    const cols = new Array(c);
    const masks = new Array(c);
    for (let j = 0; j < c; j++) {
      let m = n;
      if (this.buf[this.pos++] === 1) {
        const len = (n + 7) >> 3;
        const bits = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        masks[j] = bits;
        m = 0;
        for (let i = 0; i < n; i++) if (bits[i >> 3] & (1 << (i & 7))) m++;
      }
      cols[j] = this.column(m);
    }
    const build = rowBuilder(keys, masks);
    if (build) return build(cols, masks, n);
    const rows = new Array(n);
    const ptr = new Uint32Array(c);
    for (let i = 0; i < n; i++) {
      const o = {};
      for (let j = 0; j < c; j++) {
        const mask = masks[j];
        if (mask === undefined) setKey(o, keys[j], cols[j][i]);
        else if (mask[i >> 3] & (1 << (i & 7))) setKey(o, keys[j], cols[j][ptr[j]++]);
      }
      rows[i] = o;
    }
    return rows;
  }

  column(m) {
    const type = this.buf[this.pos++];
    const out = new Array(m);
    switch (type) {
      case C_ANY: for (let i = 0; i < m; i++) out[i] = this.value(); return out;
      case C_INT: case C_DELTA: case C_DELTA2: {
        const s = POW10[this.uint()];
        const w = this.buf[this.pos++];
        const zz = w ? new Float64Array(m) : null;
        if (w) {
          const buf = this.buf, base = this.pos;
          if (w <= 3) {
            for (let b = 0; b < w; b++) {
              const off = base + b * m, sh = 8 * b;
              for (let i = 0; i < m; i++) zz[i] += buf[off + i] << sh;
            }
          } else for (let b = w - 1; b >= 0; b--) for (let i = 0; i < m; i++) zz[i] = zz[i] * 256 + buf[base + b * m + i];
          this.pos += m * w;
        }
        let acc = 0, d = 0;
        for (let i = 0; i < m; i++) {
          let x;
          if (w) { const z = zz[i]; x = z % 2 === 0 ? z / 2 : -(z + 1) / 2; } else x = this.sint();
          if (type === C_INT) out[i] = x / s;
          else if (type === C_DELTA) { acc += x; out[i] = acc / s; }
          else { d += x; acc += d; out[i] = acc / s; }
        }
        return out;
      }
      case C_BOOL: {
        const buf = this.buf, p = this.pos;
        for (let i = 0; i < m; i++) out[i] = (buf[p + (i >> 3)] & (1 << (i & 7))) !== 0;
        this.pos += (m + 7) >> 3;
        return out;
      }
      case C_CONST: { const v = this.value(); return out.fill(v); }
      case C_DICT: {
        const k = this.uint();
        const dict = new Array(k);
        for (let i = 0; i < k; i++) dict[i] = this.value();
        if (k <= 256) {
          const buf = this.buf, p = this.pos;
          for (let i = 0; i < m; i++) out[i] = dict[buf[p + i]];
          this.pos += m;
        } else for (let i = 0; i < m; i++) out[i] = dict[this.uint()];
        return out;
      }
      case C_STR: for (let i = 0; i < m; i++) out[i] = this.str(); return out;
      case C_TABLE: return this.table_();
      case C_F64: case C_F64X: {
        const buf = this.buf, base = this.pos, x = type === C_F64X;
        let ph = 0, pl = 0;
        for (let i = 0; i < m; i++) {
          let h = ((buf[base + i] << 24) | (buf[base + m + i] << 16) | (buf[base + 2 * m + i] << 8) | buf[base + 3 * m + i]) >>> 0;
          let l = ((buf[base + 4 * m + i] << 24) | (buf[base + 5 * m + i] << 16) | (buf[base + 6 * m + i] << 8) | buf[base + 7 * m + i]) >>> 0;
          if (x) { h = (h ^ ph) >>> 0; l = (l ^ pl) >>> 0; ph = h; pl = l; }
          f64w[1] = h; f64w[0] = l;
          out[i] = f64[0];
        }
        this.pos += m * 8;
        return out;
      }
      default: throw new Error("zip-string: corrupt column (type " + type + ")");
    }
  }
}

// Row construction via a generated function: one object literal per row gives the
// engine a single fixed shape (much faster than adding keys one by one).
// Keys enter the source only as JSON.stringify()'d string literals, so data
// can never inject code. Falls back to the generic loop under a strict CSP.
let codegen = true;
/** Turn generated row builders on/off (tests, or pages that want no `new Function`). */
export function setCodegen(on) { codegen = on; builders.clear(); }
const builders = new Map();
function rowBuilder(keys, masks) {
  if (!codegen || keys.length > 200) return null;
  let sig = "";
  for (let j = 0; j < keys.length; j++) sig += (masks[j] ? "?" : "!") + keys[j] + "\u0000";
  let fn = builders.get(sig);
  if (fn !== undefined) return fn;
  const lit = (k) => JSON.stringify(k);
  // Keys up to the first optional one go in the object literal; the rest are
  // assigned in order, so key order matches the generic loop exactly.
  // "__proto__" is written with defineProperty (setKey) so it stays a plain key.
  let pre = "", fields = [], rest = "", inLiteral = true;
  keys.forEach((k, j) => {
    pre += `const c${j}=c[${j}];` + (masks[j] ? `const m${j}=M[${j}];let p${j}=0;` : "");
    if (masks[j]) inLiteral = false;
    if (inLiteral) { fields.push(`[${lit(k)}]:c${j}[i]`); return; }
    const value = masks[j] ? `c${j}[p${j}++]` : `c${j}[i]`;
    const assign = k === "__proto__" ? `S(o,${lit(k)},${value});` : `o[${lit(k)}]=${value};`;
    rest += masks[j] ? `if(m${j}[i>>3]&(1<<(i&7))){${assign}}` : assign;
  });
  const body = `${pre}const r=new Array(n);for(let i=0;i<n;i++){const o={${fields.join(",")}};${rest}r[i]=o;}return r;`;
  try {
    const make = new Function("c", "M", "n", "S", body);
    fn = (c, M, n) => make(c, M, n, setKey);
  } catch {
    codegen = false; // e.g. CSP without 'unsafe-eval'
    return null;
  }
  if (builders.size > 500) builders.clear();
  builders.set(sig, fn);
  return fn;
}

export function serialize(value, strings) {
  const w = new Writer(strings);
  w.value(value);
  return w.finish();
}

export function deserialize(bytes, strings) {
  const r = new Reader(bytes, strings);
  const v = r.value();
  if (r.pos !== bytes.length) throw new Error("zip-string: trailing bytes");
  return v;
}

/** Strings a dictionary contributes, in table order. */
export function dictionaryStrings(bytes) {
  const r = new Reader(bytes);
  r.value();
  return r.table;
}
