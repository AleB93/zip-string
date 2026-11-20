import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode, createDictionary } from "../src/index.js";
import { setCodegen } from "../src/binary.js";
import { gen } from "./gen.js";

const jsonEq = (v) => JSON.parse(JSON.stringify(v));

test("random JSON round-trips (2000 cases × 2 targets)", () => {
  for (let i = 0; i < 2000; i++) {
    const v = jsonEq(gen()); // normalize to real JSON
    for (const target of ["hash", "query"]) {
      const s = encode(v, { target });
      assert.match(s, target === "hash" ? /^[A-Za-z0-9\-._~!$*+,;=:@/?]*$/ : /^[A-Za-z0-9\-_]*$/);
      assert.deepEqual(decode(s), v, `case ${i}`);
    }
  }
});

test("edge values", () => {
  const cases = [null, 0, -0, 1, -1, 191, 192, 2 ** 52, 2 ** 53, -(2 ** 60), 1e300, 5e-324, NaN, Infinity, -Infinity,
    0.1, 0.30000000000000004, "", "a", "😀", [], {}, [[]], [{}], [{}, {}], [{ a: 1 }, { b: 2 }], [{ a: -0 }, { a: 0 }],
    [{ a: [1] }, { a: [2] }], [{ a: null }, { a: null }], [{ a: 1 }, 5], { "": 1, "__proto__x": 2 }];
  // -0 becomes 0 (as in JSON); NaN/±Infinity are kept (JSON would turn them into null)
  const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (Object.is(x, -0) ? 0 : x)), (k, x) => x);
  for (const v of cases) {
    const want = typeof v === "number" && !Number.isFinite(v) ? v : norm(v);
    for (const target of ["hash", "query"]) assert.deepEqual(decode(encode(v, { target })), want, String(v));
  }
});

test("JSON semantics for non-JSON values", () => {
  const d = new Date(0);
  assert.deepEqual(decode(encode({ d, u: undefined, f() {} })), { d: d.toJSON() });
  assert.deepEqual(decode(encode([undefined, 1])), [null, 1]);
  assert.deepEqual(decode(encode([{ a: 1, u: undefined }, { a: 2 }])), [{ a: 1 }, { a: 2 }]);
  assert.throws(() => encode(1n));
});

test("big tables, every column codec", () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({
    id: i, ts: 1767225600000 + i * 61000, price: Math.round(Math.sin(i) * 10000) / 100, f: Math.sin(i),
    city: ["Rome", "Paris", "Oslo"][i % 3], name: "user" + i, ok: i % 3 === 0, k: "const",
    nested: { x: i % 7, y: i % 2 ? "a" : "b" }, opt: i % 5 ? undefined : i, many: i % 1000,
  }));
  const expected = jsonEq(rows);
  assert.deepEqual(decode(encode(rows)), expected);
  assert.deepEqual(decode(encode(rows, { target: "query", level: 9 })), expected);
  assert.deepEqual(decode(encode(rows, { native: true }), { native: true }), expected);
  assert.deepEqual(decode(encode(rows, { level: 0 })), expected);
});

test("dictionary", () => {
  const sample = { view: "dashboard", filters: [{ field: "city", op: "in", value: ["Rome"] }], sort: { by: "price", dir: "desc" } };
  const dict = createDictionary(sample);
  const state = { view: "dashboard", filters: [{ field: "price", op: ">", value: [50] }], sort: { by: "city", dir: "asc" } };
  const s = encode(state, { dictionary: dict });
  assert.deepEqual(decode(s, { dictionary: dict }), state);
  assert.ok(s.length < encode(state).length, `dict ${s.length} vs ${encode(state).length}`);
  assert.throws(() => decode(s), /needs a dictionary/);
  assert.throws(() => decode(s, { dictionary: createDictionary({ other: 1 }) }), /wrong dictionary/);
});

test("row builder fallback (no new Function) gives identical results", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ a: i, b: i % 3 ? "x" : undefined, ["__proto__"]: i % 2, c: { d: i } }));
  const v = JSON.parse(JSON.stringify(rows));
  const s = encode(v);
  const withGen = decode(s);
  setCodegen(false);
  let without;
  try { without = decode(s); } finally { setCodegen(true); }
  // same values AND same key order (JSON.stringify output) on both paths
  assert.equal(JSON.stringify(withGen), JSON.stringify(without));
  assert.equal(JSON.stringify(withGen), JSON.stringify(v));
  assert.deepEqual(withGen, v);
  for (const r of [...withGen, ...without]) assert.equal(Object.getPrototypeOf(r), Object.prototype);

  // optional "__proto__" column (goes through the assignment path)
  const opt = JSON.parse(JSON.stringify(Array.from({ length: 40 }, (_, i) => (i % 2 ? { a: i, ["__proto__"]: { x: i } } : { a: i }))));
  const o2 = decode(encode(opt));
  assert.equal(JSON.stringify(o2), JSON.stringify(opt));
  for (const r of o2) assert.equal(Object.getPrototypeOf(r), Object.prototype);
});

test("fflate path (browser) and zlib path (Node) are interchangeable", () => {
  const v = JSON.parse(JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ t: 1e12 + i * 1000, f: Math.sin(i), s: "k" + (i % 4) }))));
  assert.deepEqual(decode(encode(v, { native: false }), { native: true }), v);
  assert.deepEqual(decode(encode(v, { native: true }), { native: false }), v);
});

test("__proto__ keys stay plain data and never change prototypes", () => {
  const v = JSON.parse('{"__proto__":{"polluted":true},"a":[{"__proto__":{"x":1}},{"__proto__":{"x":2}}]}');
  const out = decode(encode(v));
  assert.deepEqual(out, v);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out.a[0]), Object.prototype);
  assert.equal({}.polluted, undefined);
});
