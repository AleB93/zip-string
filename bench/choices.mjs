// node bench/choices.mjs — measures each design choice on its own
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { deflateSync, inflateSync, strToU8, strFromU8 } from "fflate";
import LZString from "lz-string";
import * as v1 from "./v1.js";
import { encode, decode, createDictionary } from "../src/index.js";
import { serialize } from "../src/binary.js";
import { toBase64url, fromBase64url, toBase77, fromBase77 } from "../src/text.js";

// ── data ──
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[(rnd() * a.length) | 0];
function table(rows) {
  const cities = ["Rome", "Milan", "Paris", "Berlin", "Madrid", "London", "Lisbon", "Vienna"];
  let t = Date.UTC(2026, 0, 1), price = 100;
  return Array.from({ length: rows }, (_, i) => {
    t += 60_000 + ((rnd() * 5000) | 0);
    price = Math.round((price + (rnd() - 0.5) * 2) * 100) / 100;
    return { id: i + 1, ts: t, city: pick(cities), price, qty: (rnd() * 50) | 0, ok: rnd() > 0.3 };
  });
}
function logs(n) {
  const lv = ["info", "warn", "error", "debug"], paths = ["/api/users", "/api/orders", "/login", "/health", "/api/cart"];
  let t = 1767225600000;
  return Array.from({ length: n }, () => {
    t += (rnd() * 3000) | 0;
    const e = { t, level: pick(lv), req: { method: pick(["GET", "POST"]), path: pick(paths), ms: (rnd() * 900) | 0 } };
    if (rnd() < 0.2) e.user = "u" + ((rnd() * 300) | 0);
    if (e.level === "error") e.err = { code: pick([500, 502, 504]), msg: "upstream timeout" };
    return e;
  });
}
const state = (v) => ({
  view: "dashboard", theme: v ? "dark" : "light", range: { from: "2026-01-01", to: "2026-03-31" },
  filters: [{ field: "city", op: "in", value: v ? ["Rome", "Paris"] : ["Oslo"] }, { field: "price", op: ">", value: v ? 50 : 10 }],
  columns: ["id", "ts", "city", "price", "qty"], sort: { by: v ? "price" : "qty", dir: "desc" }, page: v ? 3 : 1,
});

// dictionaries are built from a *different* sample of the same shape, as in real use
const datasets = [
  ["app state (small)", state(1), createDictionary(state(0))],
  ["table 5k rows", table(5_000), createDictionary(table(50))],
  ["logs 2k (nested, irregular)", logs(2_000), createDictionary(logs(50))],
  ["package-lock.json (real file)", JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url))), null],
  ["table 100k rows", table(100_000), createDictionary(table(50))],
];

// ── the choices ──
const b64u = (u8) => toBase64url(u8);
const configs = [
  ["ref: lz-string", (d) => LZString.compressToEncodedURIComponent(JSON.stringify(d)), (s) => JSON.parse(LZString.decompressFromEncodedURIComponent(s))],
  ["ref: JSON + deflate + base64", (d) => b64u(deflateSync(strToU8(JSON.stringify(d)), { level: 6 })), (s) => JSON.parse(strFromU8(inflateSync(fromBase64url(s))))],
  ["v1 (JSON columns, zlib 9, base77 BigInt)", (d) => v1.encode(d), (s) => v1.decode(s), true],
  ["binary only (no deflate) + base64", (d) => encode(d, { target: "query", level: 0 }), (s) => decode(s)],
  ["binary + deflate 6 + base64 native ★query", (d) => encode(d, { target: "query" }), (s) => decode(s)],
  ["binary + deflate 6 + base64 JS loop", (d) => "x" + toBase64url(serialize(d), false), null],
  ["binary + deflate 6 + base77 ★hash", (d) => encode(d), (s) => decode(s)],
  ["binary + deflate 9 + base64", (d) => encode(d, { target: "query", level: 9 }), (s) => decode(s)],
  ["binary + Node zlib 6 + base64", (d) => encode(d, { target: "query", native: true }), (s) => decode(s, { native: true })],
  ["binary + dictionary + base77", (d, dict) => (dict ? encode(d, { dictionary: dict }) : null), (s, dict) => decode(s, { dictionary: dict })],
];

async function time(fn, budget = 1000) {
  const times = [];
  let out;
  const start = performance.now();
  while (times.length < 3 || (performance.now() - start < budget && times.length < 100)) {
    const t0 = performance.now();
    out = await fn();
    times.push(performance.now() - t0);
    if (times[0] > budget) break;
  }
  times.sort((a, b) => a - b);
  return { out, ms: times[times.length >> 1] };
}
const size = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");
const ms = (n) => (n < 1 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)) + " ms";

for (const [name, data, dict] of datasets) {
  const raw = JSON.stringify(data).length;
  console.log(`\n### ${name} — JSON ${size(raw)}\n`);
  console.log("| choice | URL chars | vs JSON | encode | decode |\n|---|---:|---:|---:|---:|");
  for (const [label, enc, dec, async] of configs) {
    if (label.startsWith("binary + deflate 6 + base64 JS")) {
      // isolate the text step: same bytes, JS loop vs native
      const bytes = (() => { const s = encode(data, { target: "query" }); return fromBase64url(s.slice(1)); })();
      const a = await time(() => toBase64url(bytes, false)), b = await time(() => fromBase64url(a.out, false));
      const c = await time(() => toBase64url(bytes, true)), e = await time(() => fromBase64url(c.out, true));
      console.log(`| ↳ text step only: base64 JS loop vs native | | | ${ms(a.ms)} vs ${ms(c.ms)} | ${ms(b.ms)} vs ${ms(e.ms)} |`);
      const f = await time(() => toBase77(bytes)), g = await time(() => fromBase77(f.out));
      const h = await time(() => v1Base77(bytes));
      console.log(`| ↳ text step only: base77 (v1 BigInt → new) | | | ${ms(h.ms)} → ${ms(f.ms)} | ${ms(g.ms)} |`);
      continue;
    }
    const e = await time(() => enc(data, dict));
    if (e.out == null) { console.log(`| ${label} | n/a (no dictionary) | | | |`); continue; }
    const d = await time(() => dec(e.out, dict));
    const ok = isDeepStrictEqual(d.out, JSON.parse(JSON.stringify(data)));
    console.log(`| ${label} | ${size(e.out.length)} | ${(raw / e.out.length).toFixed(1)}× | ${ms(e.ms)} | ${ms(d.ms)} |${ok ? "" : " ❌"}`);
  }
}

// v1's BigInt base77 encoder, for the text-step comparison
function v1Base77(bytes) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$*+,;=:@/?";
  const B = 77n, charsFor = (n) => Math.ceil((n * 8) / Math.log2(77));
  let s = "";
  for (let i = 0; i < bytes.length; i += 32) {
    const chunk = bytes.subarray(i, i + 32);
    let n = 0n;
    for (const b of chunk) n = (n << 8n) | BigInt(b);
    let part = "";
    for (let k = charsFor(chunk.length); k > 0; k--) { part = A[Number(n % B)] + part; n /= B; }
    s += part;
  }
  return s;
}
