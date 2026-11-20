// node bench.mjs [file.json]  — compares sizes and verifies lossless round-trip
import { readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { encode, decode } from "./v1.js";

function sample(rows = 5000) {
  const cities = ["Rome", "Milan", "Paris", "Berlin", "Madrid", "London"];
  let t = Date.UTC(2026, 0, 1), price = 100;
  return Array.from({ length: rows }, (_, i) => {
    t += 60_000;
    price = Math.round((price + (Math.random() - 0.5) * 2) * 100) / 100;
    return { id: i + 1, ts: t, city: cities[i % 7 % 6], price, qty: (i * 37) % 50, ok: i % 3 !== 0 };
  });
}

const data = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : sample();
const json = JSON.stringify(data);
const kb = (n) => (n / 1024).toFixed(1).padStart(8) + " KB";

console.log("raw JSON           ", kb(json.length));
console.log("encodeURIComponent ", kb(encodeURIComponent(json).length));
for (const target of ["query", "hash"]) {
  for (const transform of [false, true]) {
    const s = await encode(data, { target, transform });
    deepStrictEqual(await decode(s), data);
    const ratio = ((json.length / s.length).toFixed(1) + "x").padStart(7);
    console.log(`${target.padEnd(5)} transform=${String(transform).padEnd(5)}`, kb(s.length), ratio, "✓ round-trip");
  }
}
