// node bench/crypto.mjs — cost of encryption vs plain encoding, in Node and (if available) Chrome.
// Chrome part needs the demo server on :8765 (python3 -m http.server 8765).
import { encode, decode, encrypt, decrypt, generateKey } from "../src/index.js";
import { makeDatasets } from "./data.js";

const PW = "correct horse battery staple";

// Runs in Node, and is sent verbatim to the browser (uses only the passed-in API).
async function measure(Z, D, PW) {
  const key = Z.generateKey();
  const sets = [["state", D.state], ["logs2k", D.logs2k], ["table5k", D.table5k], ["table100k", D.table100k]];
  const time = async (fn) => {
    let reps = 1;
    for (;;) { const a = performance.now(); for (let i = 0; i < reps; i++) await fn(); if (performance.now() - a > 30 || reps > 2e4) break; reps *= 4; }
    const s = [];
    for (let k = 0; k < 7; k++) { const a = performance.now(); for (let i = 0; i < reps; i++) await fn(); s.push((performance.now() - a) / reps); }
    return s.sort((x, y) => x - y)[3];
  };
  const out = [];
  for (const [name, data] of sets) {
    const plain = Z.encode(data, { target: "hash" });
    const withKey = await Z.encrypt(data, { key });
    const withPw = await Z.encrypt(data, { password: PW });
    out.push({
      name, plainLen: plain.length, keyLen: withKey.length, pwLen: withPw.length,
      encPlain: await time(() => Z.encode(data)), decPlain: await time(() => Z.decode(plain)),
      encKey: await time(() => Z.encrypt(data, { key })), decKey: await time(() => Z.decrypt(withKey, { key })),
      encPw: name === "state" ? await time(() => Z.encrypt(data, { password: PW })) : null,
      decPw: name === "state" ? await time(() => Z.decrypt(withPw, { password: PW })) : null,
    });
  }
  return out;
}

const f = (n) => (n == null ? "" : n < 1 ? n.toFixed(3) : n.toFixed(1));
const pct = (a, b) => "+" + (((b - a) / a) * 100).toFixed(0) + "%";
function print(title, rows) {
  console.log(`\n### ${title}\n`);
  console.log("| data | plain | + key | + password | encode plain → key | decode plain → key |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(`| ${r.name} | ${r.plainLen} | +${r.keyLen - r.plainLen} chars | +${r.pwLen - r.plainLen} chars | ${f(r.encPlain)} → ${f(r.encKey)} ms (${pct(r.encPlain, r.encKey)}) | ${f(r.decPlain)} → ${f(r.decKey)} ms (${pct(r.decPlain, r.decKey)}) |`);
  }
  const s = rows.find((r) => r.name === "state");
  console.log(`\npassword mode (PBKDF2, 600k iterations): encrypt ${f(s.encPw)} ms · decrypt ${f(s.decPw)} ms — fixed cost, independent of data size`);
}

const Z = { encode, decode, encrypt, decrypt, generateKey };
print(`Node ${process.version}`, await measure(Z, makeDatasets(), PW));

try {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.goto("http://localhost:8765/test/browser.html");
  await page.waitForFunction(() => window.ready === true);
  const rows = await page.evaluate(async ({ src, PW }) => {
    const measure = new Function("return " + src)();
    return measure(window.zipString, window.zipString.makeDatasets(), PW);
  }, { src: measure.toString(), PW });
  print(`Chrome ${browser.version()}`, rows);
  await browser.close();
} catch (e) {
  console.log("\n(Chrome part skipped: " + e.message.split("\n")[0] + ")");
}
