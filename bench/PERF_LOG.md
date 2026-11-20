# Performance loop — 10 tries

Harness: `node bench/perf.mjs <label>` measures 6 datasets × 2 targets (median of up to 300 runs).
Each try is compared with the previous **kept** state; repeated runs vary by about ±2%, and the
100k-row decode figure by up to ±25% (garbage-collection timing).
Dataset sizes below are URL characters; times are Node 26 on this machine.

| # | Try | Result | Size | Encode | Decode |
|---|---|---|---:|---:|---:|
| 1 | Skip repeated work in encoder (keys found once, one pass per column, `Object.keys`) | ✅ kept | 0% | **−11%** | −1% |
| 2 | Generated row builders on decode (one object literal per row) | ✅ kept | 0% | 0% | **−14%** (tables −23…−34%) |
| 3 | Hand-inline varint loops | ❌ reverted | 0% | −1% | noise / worse |
| 4 | base77: 24-bit limbs, 3 digits per division, byte-buffer output | ✅ kept | 0% (identical output) | **−9%** (hash 100k −31%) | **−9%** |
| 5 | Delta-of-delta integer codec (picked per column) | ✅ kept | **−1.7%** (table5k −7%) | −2% | −1% |
| 6 | Integers as byte planes instead of varints | ✅ kept (trade-off) | **−2.5%** (tables −5…−7%) | +5% | +2% |
| 7 | fflate `mem` level / level 9 | ❌ rejected | 0% | only slower | — |
| 8 | Node: native zlib by default (level 6); tiny inputs keep the smaller of zlib/fflate | ✅ kept | −1.2% | −1% (big data −15…−24%) | **−50%** |
| 9 | Floats: XOR-with-previous layout, chosen per column by byte entropy | ✅ kept | smooth series −1…−3% | +5% (float columns) | −19% on floats |
| 10 | Dictionary detection keyed by raw values (no string concat per cell) | ✅ kept | 0% | **−9%** (logs −18%) | −1% |

Found along the way (try 10 cleanup): `"__proto__"` keys were dropped by the decoder's plain-object and fallback paths
(and could set a decoded object's prototype). Fixed with `Object.defineProperty`; covered by tests.

## Before → after (start of loop vs. end)

| case | size | encode | decode |
|---|---:|---:|---:|
| state (dictionary) | 0% | +36…53% (+15 µs: tries both deflaters) | **−70…−76%** |
| lockfile | 0% | +34% (+20 µs) | **−64…−75%** |
| logs 2k | **−3.8%** | **−32…−36%** | **−50…−51%** |
| sensors 10k (noisy floats) | −0.5% | **−23…−35%** | **−59…−75%** |
| table 5k | **−14.8%** | **−39…−44%** | **−46…−50%** |
| table 100k | **−11.4%** | **−39…−50%** | **−31…−33%** |
| **geomean** | **−5.3%** | **−18.6%** | **−59.4%** |

Ideas not tried yet: per-column choice between byte planes and varints (would undo try 6's encode cost),
a faster string-column decoder, a WASM deflate for browsers.
