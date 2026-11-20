// Seeded benchmark datasets — identical in Node and in browsers.
export function makeDatasets() {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = (a) => a[(rnd() * a.length) | 0];

  function table(rows) {
    const cities = ["Rome", "Milan", "Paris", "Berlin", "Madrid", "London", "Lisbon", "Vienna"];
    let t = Date.UTC(2026, 0, 1), price = 100;
    return Array.from({ length: rows }, (_, i) => {
      t += 60_000 + ((rnd() * 5000) | 0);
      price = Math.round((price + (rnd() - 0.5) * 2) * 100) / 100;
      return { id: i + 1, ts: t, city: pick(cities), price, qty: (rnd() * 50) | 0, ok: rnd() > 0.3 };
    });
  }
  function logs(n) {
    const lv = ["info", "warn", "error", "debug"], paths = ["/api/users", "/api/orders", "/login", "/health", "/api/cart"];
    let t = 1767225600000;
    return Array.from({ length: n }, () => {
      t += (rnd() * 3000) | 0;
      const e = { t, level: pick(lv), req: { method: pick(["GET", "POST"]), path: pick(paths), ms: (rnd() * 900) | 0 } };
      if (rnd() < 0.2) e.user = "u" + ((rnd() * 300) | 0);
      if (e.level === "error") e.err = { code: pick([500, 502, 504]), msg: "upstream timeout" };
      return e;
    });
  }
  function sensors(n) { // float-heavy: lat/lon/temps, not decimal-friendly
    return Array.from({ length: n }, (_, i) => ({ sensor: "s" + (i % 20), lat: 41.9 + rnd() / 100, lon: 12.5 + rnd() / 100, temp: 20 + Math.sin(i / 50) * 5 + rnd() }));
  }
  const state = (v) => ({
    view: "dashboard", theme: v ? "dark" : "light", range: { from: "2026-01-01", to: "2026-03-31" },
    filters: [{ field: "city", op: "in", value: v ? ["Rome", "Paris"] : ["Oslo"] }, { field: "price", op: ">", value: v ? 50 : 10 }],
    columns: ["id", "ts", "city", "price", "qty"], sort: { by: v ? "price" : "qty", dir: "desc" }, page: v ? 3 : 1,
  });

  // order matters: generators share one random stream
  return {
    state: state(1),
    stateSample: state(0),
    logs2k: logs(2_000),
    sensors10k: sensors(10_000),
    table5k: table(5_000),
    table100k: table(100_000),
  };
}
