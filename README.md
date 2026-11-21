# zip-string

**Pack JSON data into the shortest URL-safe string.** Share a 5,000-row table in a 28 KB link, or app state in under 100 characters, and render it straight from the URL with no server.

```js
import { encode, decode } from "zip-string";

const url = `https://example.com/view#${encode(rows)}`;   // 392 KB of JSON → 28 KB link
const rows = decode(location.hash.slice(1));               // back, exactly
```

- **Small**: 3–4× shorter URLs than lz-string or plain deflate on tabular data, and smallest on every dataset tested (see [Benchmarks](#benchmarks)).
- **Fast**: synchronous; encodes 5,000 rows in about 2 ms and decodes them in under 1 ms.
- **Exact**: lossless round trips, verified on thousands of random documents in Node and Chrome.
- **Optional encryption**: AES-256-GCM with a password or a random key. Without the secret, a leaked link reveals nothing, and any modification is detected.
- **Tiny footprint**: one dependency ([fflate](https://github.com/101arrowz/fflate)); ESM + CommonJS + TypeScript types.

> "zip" is figurative: the format is deflate inside a custom binary encoding, not a `.zip` file.

## Install

```sh
npm install zip-string
```

## Usage

### Data in the `#fragment` (recommended)

The fragment never reaches the server, so it isn't limited by server or proxy URL limits (often 8 KB) and isn't logged. Browsers accept fragments in the megabyte range.

```js
import { encode, decodeHash } from "zip-string";

// create a link
const link = `${location.origin}/report#${encode(data)}`;

// on the page that renders it
const data = decodeHash(); // null if the fragment is empty
```

### Data in a `?query` string

Use `target: "query"` when a server must read the value. It uses base64url, which is safe inside `?a=b&c=d` with no escaping.

```js
const url = `/api/render?d=${encode(data, { target: "query" })}`;
const data = decode(new URL(url, location.href).searchParams.get("d"));
```

### Small, repeated shapes: use a dictionary

For app state, filters and settings, a dictionary built from a sample shrinks URLs by about half. Ship the dictionary with your code; it is never put in the URL.

```js
import { encode, decode, createDictionary } from "zip-string";

const dict = createDictionary({ view: "dashboard", filters: [{ field: "city", op: "in", value: ["Rome"] }], sort: { by: "price", dir: "desc" } });

const s = encode(state, { dictionary: dict });   // 206 → 92 characters in our test
decode(s, { dictionary: dict });
```

The dictionary is a `Uint8Array`. To store it as text, use for example `Buffer.from(dict).toString("base64")`. A string encoded with a dictionary fails loudly if it's decoded without one or with a different one.

### Encrypt a link so only the right people can read it

```js
import { encrypt, decrypt } from "zip-string";

// with a password
const link = await encrypt(data, { password: "correct horse battery staple" });
const back = await decrypt(link, { password: "correct horse battery staple" });

// or with a random key (stronger than any password people can remember)
import { generateKey } from "zip-string";
const key = generateKey();                 // 43 characters, e.g. "q3J…Zk"
const link2 = await encrypt(data, { key });
const back2 = await decrypt(link2, { key });
```

Send the link and the password or key through **different channels** (for example, the link by email and the password by chat or in person). Anyone who gets both can read the data; anyone with only the link learns nothing but its approximate size. See [Security](#security).

## API

### `encode(data, options?) → string`

| option | default | |
|---|---|---|
| `target` | `"hash"` | `"hash"`: 77-character alphabet, about 4% shorter, for `#fragment` only. `"query"`: base64url, safe anywhere. |
| `dictionary` | — | A dictionary from `createDictionary()`. |
| `level` | `6` | Deflate level `0`–`9`. `0` skips compression (fastest, about 8× smaller than JSON on tables). |
| `native` | `true` | In Node, use the built-in zlib (faster). Browsers always use fflate. Output is compatible either way. |

### `decode(str, options?) → value`

Options: `dictionary` (required if one was used to encode), `native`. Throws on corrupt input or a missing or wrong dictionary.

### `decodeHash(options?) → value | null`

Decodes `location.hash` (browser), handling any percent-escaping added by browsers or chat apps.

### `createDictionary(...samples) → Uint8Array`

Builds a dictionary from sample values shaped like your data.

### `encrypt(data, options) → Promise<string>`

Compresses, then encrypts with AES-256-GCM. Pass exactly one of:

| option | |
|---|---|
| `password` | At least 8 characters. The key is derived with PBKDF2-SHA256 (600,000 iterations by default) and a random salt. |
| `key` | 32 bytes: a string from `generateKey()`, a `Uint8Array`, or an AES-GCM `CryptoKey`. |

Also accepts `iterations` (password only, 100,000 to 10,000,000) and every `encode` option. Adds about 40 characters with a key and 60 with a password.

### `decrypt(str, options) → Promise<value>`

Options: `password` or `key`, plus `dictionary` if one was used. Rejects with "cannot decrypt" if the secret is wrong or the string was modified in any way.

### `generateKey() → string`

A new random 256-bit key (43 URL-safe characters).

### `isEncrypted(str) → boolean`

Tells an encrypted string from a plain one, for example to decide whether to show a password prompt.

### `setCodegen(on)`

Decoding tables uses small generated functions (`new Function`) for speed. This is switched off automatically when a Content Security Policy blocks it; call `setCodegen(false)` to opt out yourself. Results are identical either way.

## How it works

1. **Columnar binary encoding.** Arrays of similar objects are stored column by column, the way Parquet stores them. Rows may have missing keys and nested objects. Each column picks the cheapest encoding:
   - **Integers and fixed decimals:** stored as values, deltas or deltas-of-deltas, laid out in byte planes (great for IDs, timestamps and prices).
   - **Repeated values:** a dictionary plus small indexes.
   - **Booleans:** bitmaps.
   - **Arbitrary floating-point numbers:** byte-shuffled, optionally XORed with the previous value (as in the Gorilla time-series format).
   - **Strings:** each one is written once; repeats become back-references.
2. **Deflate** (Node's zlib or fflate), with an optional preset dictionary.
3. **URL-safe text.** The `#` target uses a 77-character alphabet of characters that are legal unescaped in a fragment; it's about 4% denser than base64. The `?` target uses base64url (native `Uint8Array.toBase64` where available).

The first character of every string identifies the format version and options, so future versions can keep decoding old links.

## Benchmarks

Node 26, Apple Silicon; median times. "URL chars" is the final string length.

| dataset (JSON size) | lz-string | JSON + deflate + base64url | **zip-string** `#` |
|---|---:|---:|---:|
| app state (272 B) | 273 chars | 235 chars | **206 chars** (92 with a dictionary) |
| logs, 2k nested rows (195 KB) | 36.8 KB · 15 ms | 28.6 KB · 3.4 ms | **13.4 KB · 1.4 ms** |
| table, 5k rows (392 KB) | 98.6 KB · 33 ms | 96.0 KB · 12 ms | **27.7 KB · 2.1 ms** |
| table, 100k rows (7.9 MB) | 1.88 MB · 1.27 s | 1.92 MB · 242 ms | **494 KB · 45 ms** |

Times are for encoding. Decoding the 100k-row table takes 22 ms (lz-string: 218 ms). In Chrome 157, the 5k-row table encodes in 2.7 ms and decodes in 1.0 ms.

How much smaller your URLs get depends on your data: tables with numbers, timestamps and repeated values compress best, and short documents full of unique random strings gain little. Run `npm run bench` and `node bench/compare.mjs` to reproduce these numbers.

## Security

Encryption uses the platform's Web Crypto (browsers, and Node ≥ 20). There's no custom cryptography and no extra dependency.

- **Confidentiality and integrity:** AES-256-GCM. Changing, removing or adding a single character makes decryption fail instead of returning altered data. The format flags and key-derivation settings are authenticated too.
- **Passwords:** PBKDF2-SHA256 with a random 16-byte salt for every link and 600,000 iterations (the OWASP recommendation). That takes about 50–80 ms on a laptop, which makes guessing millions of passwords slow. A weak password is still guessable, so use a long passphrase or `generateKey()`.
- **Fresh randomness:** every call uses a new random IV (and salt), so encrypting the same data twice gives two different strings.
- **Malicious links:** `decrypt` refuses links that request more than 10 million iterations, so a crafted link can't freeze the page.
- **What is not hidden:** the link's length, which reveals the approximate size of the data. Data is compressed before it's encrypted, so if an attacker can mix their own text into data alongside a secret and watch the resulting length many times, they could learn something about the secret (the CRIME/BREACH technique). That doesn't apply to links you create from your own data.
- **Where secrets live:** zip-string never stores or sends a key or password. If you put the key in the same link (for example `#data.key`), anyone with the link can read it. That only protects against servers and logs that never see the fragment, which is the model Excalidraw and Firefox Send use.
- **Browser requirement:** Web Crypto only exists in secure contexts (`https://` or `localhost`). Elsewhere, `encrypt` and `decrypt` throw a clear error.

## Compatibility

- **Runtimes:** Node ≥ 18 and modern browsers (ES2022: `Object.hasOwn`, `TextDecoder`). Uses native base64 and `String.prototype.isWellFormed` when present, with fallbacks otherwise. Encryption needs Web Crypto: Node ≥ 20, and browsers on `https://` or `localhost`.
- **Tested in:** Node 18–26 (CI) and Google Chrome 157 and 143 (`npm run test:browsers`), including encryption in both directions between Node and the browser. Firefox and Safari aren't covered by the automated tests yet.
- **Data:** follows `JSON.stringify` semantics (`toJSON()` is called; `undefined` and functions are dropped), with two differences: `NaN` and `±Infinity` are preserved, and `-0` becomes `0`. Strings containing unpaired surrogates (invalid UTF-16) are preserved exactly. `BigInt` throws.
- **Safety:** keys named `__proto__` stay plain data and never change an object's prototype.

## Limits

- **URL length is the real limit.** Browsers handle megabyte fragments, but chat apps, email clients and QR codes cut links far sooner; test where your links will be shared. Beyond about 50–100 KB, consider storing the data elsewhere and linking to it.
- **Key order:** rows with missing keys come back in the order the keys first appear; this matches the input whenever rows list their keys consistently.

## Prior art

zip-string's code is original, but its techniques come from well-known formats:

| technique | from |
|---|---|
| column storage, presence bitmaps | Apache Parquet and Arrow, Dremel |
| delta and dictionary encoding | columnar databases (ClickHouse, DuckDB) |
| compact integers for small and negative numbers | Protocol Buffers |
| writing repeated strings once | MessagePack and CBOR extensions |
| byte shuffling | Blosc |
| XOR float compression | Facebook's Gorilla time-series format |
| preset dictionaries | zlib, Brotli and zstd |
| deflate in JavaScript | [fflate](https://github.com/101arrowz/fflate) (MIT), the one dependency |

## Development

```sh
npm test                 # Node tests
npm run test:browsers    # Chrome (needs: python3 -m http.server 8765)
npm run bench            # benchmark
npm run build            # CommonJS bundle → dist/
```

## License

[MIT](LICENSE)
