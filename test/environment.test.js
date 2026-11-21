// Paths that depend on the environment: CSP-blocked code generation, missing
// Web Crypto, and every accepted and rejected kind of key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode, setCodegen, encrypt, decrypt, generateKey } from "../src/index.js";

const webcrypto = globalThis.crypto?.subtle ? globalThis.crypto : globalThis.process?.getBuiltinModule?.("node:crypto")?.webcrypto;
const cryptoTest = (name, fn) => test(name, { skip: webcrypto?.subtle ? false : "no Web Crypto in this Node version" }, fn);
const rows = Array.from({ length: 50 }, (_, i) => ({ a: i, b: i % 3 ? "x" : undefined, c: { d: i } }));
const expected = JSON.parse(JSON.stringify(rows));

test("decoding still works when a Content Security Policy blocks new Function", () => {
  const s = encode(rows);
  const RealFunction = globalThis.Function;
  setCodegen(true); // clears cached builders, so the next decode tries to generate one
  globalThis.Function = function () { throw new EvalError("Refused to evaluate a string as JavaScript (CSP)"); };
  let out;
  try { out = decode(s); } finally { globalThis.Function = RealFunction; }
  assert.equal(JSON.stringify(out), JSON.stringify(expected));
  assert.deepEqual(decode(s), expected); // codegen stays off, still correct
  setCodegen(true);
});

test("encrypt and decrypt explain clearly when Web Crypto is missing", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const getBuiltin = process.getBuiltinModule;
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  process.getBuiltinModule = (id) => (id === "node:crypto" ? undefined : getBuiltin?.(id));
  try {
    await assert.rejects(encrypt({ a: 1 }, { key: "A".repeat(43) }), /needs Web Crypto/);
    assert.throws(() => generateKey(), /needs Web Crypto/);
  } finally {
    if (desc) Object.defineProperty(globalThis, "crypto", desc); else delete globalThis.crypto;
    process.getBuiltinModule = getBuiltin;
  }
  assert.deepEqual(decode(encode({ a: 1 })), { a: 1 }); // plain encoding never needs it
});

cryptoTest("an AES-GCM CryptoKey is accepted; other CryptoKeys are refused", async () => {
  const aes = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const s = await encrypt(expected, { key: aes });
  assert.deepEqual(await decrypt(s, { key: aes }), expected);
  const hmac = await webcrypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  await assert.rejects(encrypt(expected, { key: hmac }), /must be an AES-GCM key/);
});

cryptoTest("malformed keys are refused with a clear message", async () => {
  const bad = [
    [42, /must be a string from generateKey\(\), a Uint8Array or a CryptoKey/],
    [{}, /must be a string from generateKey\(\), a Uint8Array or a CryptoKey/],
    [new ArrayBuffer(32), /must be a string from generateKey\(\), a Uint8Array or a CryptoKey/],
    ["too-short", /43-character string/],
    ["A".repeat(42) + "=", /43-character string/],
    [new Uint8Array(16), /must be 32 bytes/],
    [new Uint8Array(33), /must be 32 bytes/],
  ];
  for (const [key, msg] of bad) {
    await assert.rejects(encrypt({ a: 1 }, { key }), msg, String(key));
  }
  const good = await encrypt({ a: 1 }, { key: generateKey() });
  for (const [key, msg] of bad) await assert.rejects(decrypt(good, { key }), msg);
});
