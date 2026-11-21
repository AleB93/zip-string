import { test as nodeTest } from "node:test";

// Web Crypto is global from Node 19/20; on Node 18 encryption isn't available (documented).
const hasWebCrypto = !!globalThis.crypto?.subtle;
const test = (name, fn) => nodeTest(name, { skip: hasWebCrypto ? false : "no Web Crypto in this Node version" }, fn);
import assert from "node:assert/strict";
import { encode, decode, encrypt, decrypt, generateKey, isEncrypted, createDictionary } from "../src/index.js";
import { B64, fromBase64url, toBase64url, fromBase77, toBase77 } from "../src/text.js";

const FAST = { iterations: 100_000 }; // minimum allowed; keeps tests quick
const PW = "correct horse battery";
const data = {
  title: "Q3 numbers — confidential",
  rows: Array.from({ length: 200 }, (_, i) => ({ id: i, ts: 1767225600000 + i * 60000, city: ["Rome", "Oslo"][i % 2], v: i / 4 })),
};
const json = JSON.stringify(data);

test("round-trip with a random key, both targets", async () => {
  const key = generateKey();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  for (const target of ["hash", "query"]) {
    const s = await encrypt(data, { key, target });
    assert.ok(isEncrypted(s));
    assert.match(s, target === "hash" ? /^[A-Za-z0-9\-._~!$*+,;=:@/?]*$/ : /^[A-Za-z0-9\-_]*$/);
    assert.equal(JSON.stringify(await decrypt(s, { key })), json);
  }
});

test("round-trip with a password, and with raw key bytes", async () => {
  const s = await encrypt(data, { password: PW, ...FAST });
  assert.equal(JSON.stringify(await decrypt(s, { password: PW })), json);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const k = await encrypt(data, { key: raw });
  assert.equal(JSON.stringify(await decrypt(k, { key: raw })), json);
  assert.equal(JSON.stringify(await decrypt(k, { key: toBase64url(raw) })), json); // same key as a string
});

test("wrong password or wrong key is rejected", async () => {
  const s = await encrypt(data, { password: PW, ...FAST });
  await assert.rejects(decrypt(s, { password: PW + "!" }), /cannot decrypt/);
  await assert.rejects(decrypt(s, { password: "Correct horse battery" }), /cannot decrypt/);
  const k = await encrypt(data, { key: generateKey() });
  await assert.rejects(decrypt(k, { key: generateKey() }), /cannot decrypt/);
});

test("missing credentials are reported clearly", async () => {
  const s = await encrypt(data, { password: PW, ...FAST });
  await assert.rejects(decrypt(s, {}), /needs a password/);
  await assert.rejects(decrypt(s, { key: generateKey() }), /needs a password/);
  const k = await encrypt(data, { key: generateKey() });
  await assert.rejects(decrypt(k, { password: PW }), /needs a key/);
});

test("any single-character change is detected (tampering)", async () => {
  for (const target of ["hash", "query"]) {
    const s = await encrypt(data, { password: PW, ...FAST, target });
    const alphabet = target === "hash" ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$*+,;=:@/?" : B64;
    // header, mode, iterations, salt, iv, ciphertext and tag positions
    for (const i of [0, 1, 2, 4, 8, 20, 30, 40, Math.floor(s.length / 2), s.length - 3, s.length - 1]) {
      const c = s[i];
      const swapped = alphabet[(alphabet.indexOf(c) + 1) % alphabet.length];
      const t = s.slice(0, i) + swapped + s.slice(i + 1);
      await assert.rejects(decrypt(t, { password: PW }), Error, `target ${target}, position ${i}`);
    }
    await assert.rejects(decrypt(s.slice(0, -1), { password: PW }), Error, "truncated");
    await assert.rejects(decrypt(s + "A", { password: PW }), Error, "extended");
  }
});

test("bytes before the ciphertext are authenticated", async () => {
  // Rewrite the stored iteration count (a byte-level change, not just a char swap):
  // must fail authentication, not silently decrypt.
  const s = await encrypt(data, { password: PW, ...FAST, target: "query" });
  const b = fromBase64url(s.slice(1));
  new DataView(b.buffer, b.byteOffset).setUint32(1, 100_001);
  await assert.rejects(decrypt(s[0] + toBase64url(b), { password: PW }), /cannot decrypt/);
});

test("a crafted link cannot request absurd key-derivation work", async () => {
  const s = await encrypt(data, { password: PW, ...FAST });
  const b = fromBase77(s.slice(1));
  new DataView(b.buffer, b.byteOffset).setUint32(1, 0xffffffff);
  await assert.rejects(decrypt(s[0] + toBase77(b), { password: PW }), /refusing this link/);
  new DataView(b.buffer, b.byteOffset).setUint32(1, 10);
  await assert.rejects(decrypt(s[0] + toBase77(b), { password: PW }), /unsafe key-derivation/);
});

test("a key-only decrypt refuses password links without any key-derivation work", async () => {
  const s = await encrypt(data, { password: PW }); // 600k iterations: tens of ms if derived
  const t = performance.now();
  await assert.rejects(decrypt(s, { key: generateKey() }), /needs a password/);
  assert.ok(performance.now() - t < 15, "rejected before PBKDF2");
});

test("maxIterations refuses links asking for more work, before doing it", async () => {
  const s = await encrypt(data, { password: PW, iterations: 1_000_000 });
  const t = performance.now();
  await assert.rejects(decrypt(s, { password: PW, maxIterations: 600_000 }), /refusing this link: it requires 1000000/);
  assert.ok(performance.now() - t < 15, "rejected before PBKDF2");
  assert.deepEqual(await decrypt(s, { password: PW, maxIterations: 1_000_000 }), data);
  for (const bad of [0, 999, 2_000_001, 1.5, "600000"]) {
    await assert.rejects(decrypt(s, { password: PW, maxIterations: bad }), RangeError);
  }
  await assert.rejects(encrypt(data, { password: PW, iterations: 2_000_001 }), /iterations/);
});

test("same input encrypts differently every time (random salt and IV)", async () => {
  const key = generateKey();
  const a = await encrypt(data, { key }), b = await encrypt(data, { key });
  assert.notEqual(a, b);
  const p1 = await encrypt(data, { password: PW, ...FAST }), p2 = await encrypt(data, { password: PW, ...FAST });
  assert.notEqual(p1, p2);
});

test("ciphertext does not reveal the content", async () => {
  const secret = { note: "launch codes 0000", list: Array(50).fill("launch codes 0000") };
  const key = generateKey();
  const s = await encrypt(secret, { key, target: "query" });
  const bytes = new TextDecoder("latin1").decode(fromBase64url(s.slice(1)));
  assert.ok(!bytes.includes("launch"));
  // the plain (unencrypted) encoding does contain it once decompressed — sanity check of the test itself
  assert.equal(decode(encode(secret)).note, "launch codes 0000");
});

test("dictionary works inside encryption, and is required", async () => {
  const dict = createDictionary({ view: "dashboard", sort: { by: "price", dir: "desc" } });
  const state = { view: "dashboard", sort: { by: "qty", dir: "asc" } };
  const key = generateKey();
  const s = await encrypt(state, { key, dictionary: dict });
  assert.deepEqual(await decrypt(s, { key, dictionary: dict }), state);
  await assert.rejects(decrypt(s, { key }), /needs a dictionary/);
  await assert.rejects(decrypt(s, { key, dictionary: createDictionary({ other: 1 }) }), /wrong dictionary/);
});

test("input validation", async () => {
  await assert.rejects(encrypt(data, {}), /exactly one/);
  await assert.rejects(encrypt(data, { password: PW, key: generateKey() }), /exactly one/);
  await assert.rejects(encrypt(data, { password: "short" }), /at least 8/);
  await assert.rejects(encrypt(data, { password: PW, iterations: 1000 }), /iterations/);
  await assert.rejects(encrypt(data, { key: "not-a-key" }), /43-character/);
  await assert.rejects(encrypt(data, { key: new Uint8Array(16) }), /32 bytes/);
  assert.throws(() => decode(encode(1).replace(/^./, B64[32 | 8])), /encrypted|decrypt/);
  await assert.rejects(decrypt(encode(data), { key: generateKey() }), /not encrypted/);
  assert.equal(isEncrypted(encode(data)), false);
  assert.equal(isEncrypted("nonsense%%"), false);
});

test("password text is normalized (é typed two ways)", async () => {
  const composed = "café-password", decomposed = "café-password";
  const s = await encrypt(data, { password: composed, ...FAST });
  assert.equal(JSON.stringify(await decrypt(s, { password: decomposed })), json);
});
