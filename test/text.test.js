import { test } from "node:test";
import assert from "node:assert/strict";
import { toBase64url, fromBase64url, toBase77, fromBase77, hasNativeBase64 } from "../src/text.js";

// Browsers without Uint8Array.toBase64 (Safari < 18.2, Firefox < 133, Chrome < 140)
// use the JS fallback; force it here so it is covered on every run.
test("base64url JS fallback matches native, all lengths 0–300", () => {
  for (let n = 0; n <= 300; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 13) & 255);
    const s = toBase64url(b, false);
    assert.equal(s, Buffer.from(b).toString("base64url"));
    assert.deepEqual(fromBase64url(s, false), b);
    assert.deepEqual(fromBase64url(s), b); // default path: native if this runtime has it
  }
});

test("base77 round-trips all lengths 0–300 (random, zeros, 0xFF)", () => {
  for (let n = 0; n <= 300; n++) {
    for (const fill of [null, 0, 255]) {
      const b = Uint8Array.from({ length: n }, (_, i) => fill ?? ((i * 131 + n * 7 + 3) & 255));
      const s = toBase77(b);
      assert.match(s, /^[A-Za-z0-9\-._~!$*+,;=:@/?]*$/);
      assert.deepEqual(fromBase77(s), b);
    }
  }
});

test("invalid input is rejected, not silently decoded", () => {
  assert.throws(() => fromBase64url("ab%c", false));
  assert.throws(() => fromBase77("ab#c"));
});

test("base77: out-of-range (non-canonical) strings are rejected", () => {
  // 41 chars of the highest digit encode a value larger than 2^256
  assert.throws(() => fromBase77("?".repeat(41)), /out of range/);
  // shortest partial block: 2 chars → 1 byte; "??" = 77² - 1 > 255
  assert.throws(() => fromBase77("??"), /out of range/);
  // every valid encoding still decodes (spot check)
  for (let n = 1; n <= 64; n++) {
    const b = new Uint8Array(n).fill(255);
    assert.deepEqual(fromBase77(toBase77(b)), b);
  }
});
