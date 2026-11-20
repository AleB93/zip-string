import { test } from "node:test";
import assert from "node:assert/strict";
import { toBase64url, fromBase64url, toBase77, fromBase77 } from "../src/text.js";

// Browsers without Uint8Array.toBase64 (Safari < 18.2, Firefox < 133, Chrome < 140)
// use the JS fallback; force it here so it is covered on every run.
test("base64url JS fallback matches native, all lengths 0–300", () => {
  for (let n = 0; n <= 300; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 13) & 255);
    const s = toBase64url(b, false);
    assert.equal(s, Buffer.from(b).toString("base64url"));
    assert.deepEqual(fromBase64url(s, false), b);
    assert.deepEqual(fromBase64url(s, true), b);
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
