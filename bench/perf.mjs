// node bench/perf.mjs <label> [--save]  — fixed harness for the optimization loop
// Prints size + median encode/decode per dataset and target, and the diff vs bench/results/baseline.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { encode, decode, createDictionary } from "../src/index.js";
import { makeDatasets } from "./data.js";

const D = makeDatasets();
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
const datasets = [
  ["state", D.state, createDictionary(D.stateSample)],
  ["lockfile", lock],
  ["logs2k", D.logs2k],
  ["sensors10k", D.sensors10k],
  ["table5k", D.table5k],
  ["table100k", D.table100k],
];

function time(fn, budget) {
  const times = [];
  let out;
  const start = performance.now();
  while (times.length < 5 || (performance.now() - start < budget && times.length < 300)) {
    const t0 = performance.now();
    out = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { out, ms: times[times.length >> 1] };
}

const label = process.argv[2] ?? "run";
const results = {};
for (const [name, data, dict] of datasets) {
  const want = JSON.parse(JSON.stringify(data));
  for (const target of ["hash", "query"]) {
    const opts = { target, dictionary: dict };
    for (let i = 0; i < 3; i++) decode(encode(data, opts), opts); // warm-up
    const e = time(() => encode(data, opts), 700);
    const d = time(() => decode(e.out, opts), 700);
    if (!isDeepStrictEqual(d.out, want)) throw new Error(`ROUND-TRIP FAILED: ${name} ${target}`);
    results[`${name}/${target}`] = { size: e.out.length, enc: e.ms, dec: d.ms };
  }
}

const dir = new URL("./results/", import.meta.url);
mkdirSync(dir, { recursive: true });
const basePath = new URL("baseline.json", dir);
const base = existsSync(basePath) ? JSON.parse(readFileSync(basePath)) : null;
const pct = (a, b) => { const p = ((a - b) / b) * 100; return (p > 0 ? "+" : "") + p.toFixed(1) + "%"; };
const f = (n) => (n < 1 ? n.toFixed(3) : n.toFixed(2));

console.log(`\n${label}\n| case | size | enc ms | dec ms |${base ? " Δsize | Δenc | Δdec |" : ""}`);
let tot = { size: 0, enc: 0, dec: 0 }, btot = { size: 0, enc: 0, dec: 0 };
for (const [k, r] of Object.entries(results)) {
  const b = base?.[k];
  // totals use per-case ratios so tiny and huge datasets weigh the same
  if (b) for (const m of ["size", "enc", "dec"]) { tot[m] += Math.log(r[m] / b[m]); }
  console.log(`| ${k} | ${r.size} | ${f(r.enc)} | ${f(r.dec)} |${b ? ` ${pct(r.size, b.size)} | ${pct(r.enc, b.enc)} | ${pct(r.dec, b.dec)} |` : ""}`);
}
if (base) {
  const n = Object.keys(results).length;
  const g = (x) => pct(Math.exp(x / n), 1);
  console.log(`\nGEOMEAN vs baseline: size ${g(tot.size)}  encode ${g(tot.enc)}  decode ${g(tot.dec)}`);
}
writeFileSync(new URL(`${label}.json`, dir), JSON.stringify(results, null, 1));
if (!base || process.argv.includes("--save")) writeFileSync(basePath, JSON.stringify(results, null, 1));
