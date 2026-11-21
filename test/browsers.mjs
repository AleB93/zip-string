// node test/browsers.mjs — correctness + benchmark in real browsers via playwright-core.
// Uses browsers already on this machine (no downloads). Needs the demo server on :8765
// (python3 -m http.server 8765) or BASE_URL.
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { encode, decode, createDictionary, encrypt, decrypt, generateKey } from "../src/index.js";
import { gen, reseed } from "./gen.js";
import { makeDatasets } from "../bench/data.js";

const BASE = process.env.BASE_URL ?? "http://localhost:8765";
const CASES = 1500;

// ── which browsers exist here ──
const targets = [];
if (existsSync("/Applications/Google Chrome.app")) targets.push({ name: "Google Chrome", launch: () => chromium.launch({ channel: "chrome" }) });
const pwCache = `${homedir()}/Library/Caches/ms-playwright`;
for (const dir of existsSync(pwCache) ? readdirSync(pwCache).filter((d) => /^chromium-\d+$/.test(d)) : []) {
  const exe = `${pwCache}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  if (existsSync(exe)) targets.push({ name: `Chrome for Testing (${dir})`, launch: () => chromium.launch({ executablePath: exe }) });
}
const only = process.argv[2];

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); return ok; };
const fmt = (n) => (n < 1 ? n.toFixed(3) : n.toFixed(2));

for (const t of targets.filter((t) => !only || t.name.includes(only))) {
  let browser;
  try { browser = await t.launch(); } catch (e) { console.log(`\n## ${t.name}\nSKIPPED — could not launch: ${e.message.split("\n")[0]}`); continue; }
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/test/browser.html`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
  const f = await page.evaluate(() => window.features);
  const version = browser.version();
  console.log(`\n## ${t.name} ${version}`);
  console.log(`features: native base64=${f.nativeBase64} isWellFormed=${f.isWellFormed} new Function=${f.newFunction} timer=${f.timerResolutionMs} ms`);
  const before = fails.length;

  // 1. random JSON: encoded+decoded in the browser, then cross-decoded both ways with Node
  reseed(7);
  const values = Array.from({ length: CASES }, () => JSON.parse(JSON.stringify(gen())));
  const fromBrowser = await page.evaluate((n) => {
    const P = window.zipString;
    P.reseed(7);
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = JSON.parse(JSON.stringify(P.gen()));
      const h = P.encode(v), q = P.encode(v, { target: "query" });
      out.push({ h, q, dh: P.decode(h), dq: P.decode(q) });
    }
    return out;
  }, CASES);
  let selfOk = 0, nodeReadsBrowser = 0;
  fromBrowser.forEach((r, i) => {
    if (check(isDeepStrictEqual(r.dh, values[i]) && isDeepStrictEqual(r.dq, values[i]), `${t.name}: browser round-trip case ${i}`)) selfOk++;
    if (check(isDeepStrictEqual(decode(r.h), values[i]) && isDeepStrictEqual(decode(r.q), values[i]), `${t.name}: Node decode of browser string, case ${i}`)) nodeReadsBrowser++;
  });
  const nodeStrings = values.map((v) => [encode(v), encode(v, { target: "query" })]);
  const browserReadsNode = await page.evaluate((list) => list.map(([h, q]) => [window.zipString.decode(h), window.zipString.decode(q)]), nodeStrings);
  let crossOk = 0;
  browserReadsNode.forEach(([h, q], i) => { if (check(isDeepStrictEqual(h, values[i]) && isDeepStrictEqual(q, values[i]), `${t.name}: browser decode of Node string, case ${i}`)) crossOk++; });
  console.log(`round-trip in browser: ${selfOk}/${CASES} · Node reads browser strings: ${nodeReadsBrowser}/${CASES} · browser reads Node strings: ${crossOk}/${CASES}`);

  // 2. special cases inside the browser
  const special = await page.evaluate(() => {
    const P = window.zipString, r = {};
    const proto = JSON.parse('{"__proto__":{"polluted":true},"a":[{"__proto__":{"x":1}},{"__proto__":{"x":2}}]}');
    const o = P.decode(P.encode(proto));
    r.proto = Object.getPrototypeOf(o) === Object.prototype && o.polluted === undefined && ({}).polluted === undefined && Object.getPrototypeOf(o.a[0]) === Object.prototype && JSON.stringify(o) === JSON.stringify(proto);
    const odd = ["\ud83d", "a\udc00b", "😀", "\u0000", "中文"];
    r.loneSurrogates = JSON.stringify(P.decode(P.encode(odd))) === JSON.stringify(odd);
    const nums = [NaN, Infinity, -Infinity, -0, 5e-324, 2 ** 53];
    const back = P.decode(P.encode(nums));
    r.numbers = Number.isNaN(back[0]) && back[1] === Infinity && back[2] === -Infinity && Object.is(back[3], 0) && back[4] === 5e-324 && back[5] === 2 ** 53;
    const dict = P.createDictionary({ view: "dashboard", sort: { by: "price", dir: "desc" } });
    const st = { view: "dashboard", sort: { by: "qty", dir: "asc" } };
    r.dictionary = JSON.stringify(P.decode(P.encode(st, { dictionary: dict }), { dictionary: dict })) === JSON.stringify(st);
    const rows = Array.from({ length: 300 }, (_, i) => ({ a: i, b: i % 3 ? "x" : undefined, c: { d: i } }));
    const s = P.encode(rows);
    const withGen = JSON.stringify(P.decode(s));
    P.setCodegen(false);
    const without = JSON.stringify(P.decode(s));
    P.setCodegen(true);
    r.codegenFallback = withGen === without;
    return r;
  });
  for (const [k, ok] of Object.entries(special)) check(ok, `${t.name}: ${k}`);
  console.log("special cases: " + Object.entries(special).map(([k, ok]) => `${k} ${ok ? "✓" : "✗"}`).join(" · "));

  // 2b. encryption: browser ⇄ Node in both directions, wrong credentials rejected
  const secret = { note: "confidential", rows: values.slice(0, 50) };
  const key = generateKey(), pw = "browser-test-password";
  const nodeKey = await encrypt(secret, { key }), nodePw = await encrypt(secret, { password: pw, iterations: 100_000 });
  const enc = await page.evaluate(async ({ secret, key, pw, nodeKey, nodePw }) => {
    const P = window.zipString, r = {};
    // compare with the plain (unencrypted) pipeline: encryption must add no difference
    const expected = JSON.stringify(P.decode(P.encode(secret)));
    const same = (a) => JSON.stringify(a) === expected;
    r.webCrypto = !!globalThis.crypto?.subtle;
    r.readsNodeKey = same(await P.decrypt(nodeKey, { key }));
    r.readsNodePassword = same(await P.decrypt(nodePw, { password: pw }));
    r.rejectsWrongPassword = await P.decrypt(nodePw, { password: pw + "x" }).then(() => false, () => true);
    r.rejectsWrongKey = await P.decrypt(nodeKey, { key: P.generateKey() }).then(() => false, () => true);
    const t0 = performance.now();
    r.browserPw = await P.encrypt(secret, { password: pw });
    r.pbkdfMs = Math.round(performance.now() - t0);
    r.browserKey = await P.encrypt(secret, { key, target: "query" });
    return r;
  }, { secret, key, pw, nodeKey, nodePw });
  enc.nodeReadsBrowserPassword = isDeepStrictEqual(await decrypt(enc.browserPw, { password: pw }), secret);
  enc.nodeReadsBrowserKey = isDeepStrictEqual(await decrypt(enc.browserKey, { key }), secret);
  const encChecks = ["webCrypto", "readsNodeKey", "readsNodePassword", "rejectsWrongPassword", "rejectsWrongKey", "nodeReadsBrowserPassword", "nodeReadsBrowserKey"];
  for (const k of encChecks) check(enc[k] === true, `${t.name}: encryption ${k}`);
  console.log("encryption: " + encChecks.map((k) => `${k} ${enc[k] ? "✓" : "✗"}`).join(" · ") + ` · password key derivation ${enc.pbkdfMs} ms`);

  // 3. benchmark (batched so coarse browser timers still give real numbers)
  const bench = await page.evaluate(() => {
    const P = window.zipString, D = P.makeDatasets();
    const dict = P.createDictionary(D.stateSample);
    const sets = [["state", D.state, dict], ["logs2k", D.logs2k], ["sensors10k", D.sensors10k], ["table5k", D.table5k], ["table100k", D.table100k]];
    const time = (fn) => {
      let reps = 1;
      for (;;) { const a = performance.now(); for (let i = 0; i < reps; i++) fn(); if (performance.now() - a > 20 || reps > 1e5) break; reps *= 4; }
      const samples = [];
      for (let s = 0; s < 9; s++) { const a = performance.now(); for (let i = 0; i < reps; i++) fn(); samples.push((performance.now() - a) / reps); }
      samples.sort((x, y) => x - y);
      return samples[4];
    };
    const out = [];
    for (const [name, data, d] of sets) for (const target of ["hash", "query"]) {
      const o = { target, dictionary: d };
      const s = P.encode(data, o);
      out.push({ k: `${name}/${target}`, size: s.length, enc: time(() => P.encode(data, o)), dec: time(() => P.decode(s, o)) });
    }
    return out;
  });
  console.log("| case | URL chars | encode ms | decode ms |\n|---|---:|---:|---:|");
  for (const b of bench) console.log(`| ${b.k} | ${b.size} | ${fmt(b.enc)} | ${fmt(b.dec)} |`);

  if (errors.length) { fails.push(...errors.map((e) => `${t.name}: page error ${e}`)); console.log("page errors:", errors); }
  console.log(fails.length === before ? "RESULT: all checks passed" : `RESULT: ${fails.length - before} FAILED`);
  await browser.close();
}

if (!targets.length) console.log("No browsers found.");
if (fails.length) { console.log("\nFailures (first 20):\n" + fails.slice(0, 20).join("\n")); process.exit(1); }
