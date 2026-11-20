// Seeded random JSON generator, shared by Node tests and the browser runner.
let seed = 7;
export const reseed = (n) => { seed = n; };
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

// random JSON generator, biased toward arrays of similar objects
export function gen(depth = 0) {
  const r = rnd();
  if (depth > 3 || r < 0.35) {
    const p = rnd();
    if (p < 0.1) return null;
    if (p < 0.2) return rnd() < 0.5;
    if (p < 0.35) return Math.floor((rnd() - 0.5) * 2 ** (rnd() * 60));
    if (p < 0.5) return Math.round((rnd() - 0.5) * 1e6) / 100;
    if (p < 0.6) return (rnd() - 0.5) * 1e10 * rnd();
    if (p < 0.65) return [0, -1, 2 ** 53, -(2 ** 53), 1e300, 5e-324, 0.1 + 0.2, 191, 192, 255, 256][(rnd() * 11) | 0];
    const chars = "abcXYZ ü😀\u0000\"\\é中";
    return Array.from({ length: (rnd() * 8) | 0 }, () => chars[(rnd() * chars.length) | 0]).join("");
  }
  if (r < 0.55) return Array.from({ length: (rnd() * 6) | 0 }, () => gen(depth + 1));
  if (r < 0.75) {
    const o = {};
    for (let i = (rnd() * 5) | 0; i > 0; i--) o["k" + ((rnd() * 8) | 0)] = gen(depth + 1);
    return o;
  }
  // table-like
  const keys = ["a", "b", "c", "d"].slice(0, 1 + ((rnd() * 4) | 0));
  const tmpl = keys.map(() => (rnd() * 5) | 0);
  return Array.from({ length: 2 + ((rnd() * 30) | 0) }, () => {
    const o = {};
    keys.forEach((k, j) => {
      if (rnd() < 0.15) return; // missing key
      const t = tmpl[j];
      o[k] = t === 0 ? (rnd() * 100) | 0 : t === 1 ? ["x", "y", "z"][(rnd() * 3) | 0] : t === 2 ? rnd() < 0.5 : t === 3 ? { n: (rnd() * 9) | 0, s: "q" } : gen(depth + 1);
    });
    return o;
  });
}

