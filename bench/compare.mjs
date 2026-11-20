// node bench/compare.mjs — size + speed vs existing libraries, on several datasets
import { isDeepStrictEqual } from "node:util";
import LZString from "lz-string";
import JSONCrush from "jsoncrush";
import { deflateSync, inflateSync, strToU8, strFromU8 } from "fflate";
import lzma from "lzma";
import { encode, decode } from "../src/index.js";

// ── deterministic data ──
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
  return Array.from({ length: n }, (_, i) => {
    t += (rnd() * 3000) | 0;
    const e = { t, level: pick(lv), req: { method: pick(["GET", "POST"]), path: pick(paths), ms: (rnd() * 900) | 0 } };
    if (rnd() < 0.2) e.user = "u" + ((rnd() * 300) | 0);
    if (e.level === "error") e.err = { code: pick([500, 502, 504]), msg: "upstream timeout" };
    return e;
  });
}
const state = {
  view: "dashboard", theme: "dark", range: { from: "2026-01-01", to: "2026-03-31" },
  filters: [{ field: "city", op: "in", value: ["Rome", "Paris"] }, { field: "price", op: ">", value: 50 }],
  columns: ["id", "ts", "city", "price", "qty"], sort: { by: "price", dir: "desc" }, page: 3,
};

const datasets = {
  "app state (small)": state,
  "table 5k rows": table(5_000),
  "logs 2k (nested, irregular)": logs(2_000),
  "table 100k rows": table(100_000),
};

// ── contenders: each returns a string that goes in a URL with no further escaping ──
const b64u = (u8) => Buffer.from(u8).toString("base64url");
const contenders = {
  "lz-string": {
    enc: (d) => LZString.compressToEncodedURIComponent(JSON.stringify(d)),
    dec: (s) => JSON.parse(LZString.decompressFromEncodedURIComponent(s)),
  },
  "JSONCrush": {
    maxBytes: 60_000, // very slow on big data (171 s on 194 KB)
    enc: (d) => encodeURIComponent(JSONCrush.crush(JSON.stringify(d))),
    dec: (s) => JSON.parse(JSONCrush.uncrush(decodeURIComponent(s))),
  },
  "lzma9+b64url (json-url's codec)": {
    maxBytes: 2_000_000, // pure-JS LZMA is slow
    enc: (d) => b64u(Uint8Array.from(lzma.compress(JSON.stringify(d), 9), (b) => b & 255)),
    dec: (s) => JSON.parse(lzma.decompress(Buffer.from(s, "base64url"))),
  },
  "fflate deflate9+b64url": {
    enc: (d) => b64u(deflateSync(strToU8(JSON.stringify(d)), { level: 9 })),
    dec: (s) => JSON.parse(strFromU8(inflateSync(Buffer.from(s, "base64url")))),
  },
  "zip-string query": { enc: (d) => encode(d, { target: "query" }), dec: decode },
  "zip-string hash": { enc: (d) => encode(d, { target: "hash" }), dec: decode },
};

async function time(fn, minRuns = 3, budgetMs = 1500) {
  const times = [];
  let out;
  const start = performance.now();
  while (times.length < minRuns || (performance.now() - start < budgetMs && times.length < 50)) {
    const t0 = performance.now();
    out = await fn();
    times.push(performance.now() - t0);
    if (times[0] > budgetMs) break;
  }
  times.sort((a, b) => a - b);
  return { out, ms: times[times.length >> 1] };
}

const fmt = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");
const ms = (n) => (n < 1 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)) + " ms";

for (const [name, data] of Object.entries(datasets)) {
  const raw = JSON.stringify(data).length;
  console.log(`\n## ${name} — JSON ${fmt(raw)}`);
  console.log("| library | URL chars | vs JSON | encode | decode |\n|---|---:|---:|---:|---:|");
  const rows = [];
  for (const [lib, c] of Object.entries(contenders)) {
    if (c.maxBytes && raw > c.maxBytes) { rows.push([lib, "skipped (too slow)"]); continue; }
    const e = await time(() => c.enc(data));
    const d = await time(() => c.dec(e.out));
    const ok = isDeepStrictEqual(d.out, data);
    rows.push([lib, e.out.length, raw, e.ms, d.ms, ok]);
  }
  const best = Math.min(...rows.filter((r) => typeof r[1] === "number").map((r) => r[1]));
  for (const [lib, len, rawLen, em, dm, ok] of rows) {
    if (typeof len !== "number") { console.log(`| ${lib} | ${len} | | | |`); continue; }
    const tag = len === best ? " **best**" : "";
    console.log(`| ${lib} | ${fmt(len)}${tag} | ${(rawLen / len).toFixed(1)}× | ${ms(em)} | ${ms(dm)} |${ok ? "" : " ❌ ROUND-TRIP FAILED"}`);
  }
}
