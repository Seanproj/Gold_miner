// node --test site/js/oil.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./engine.js");
const O = require("./oil.js");

function makeSeries(n = 1500, seed = 11, start = 11000, v0 = 60) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const t = [], p = []; let d = start, v = v0;
  for (let i = 0; i < n; i++) { t.push(d); p.push(v); d += (i % 5 === 4) ? 3 : 1; v *= 1 + (rnd() - 0.5) * 0.04; }
  return { t, p };
}
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("spearman: perfect, reversed and too-small samples", () => {
  const a = Array.from({ length: 50 }, (_, i) => i);
  close(O.spearman(a, a.map((x) => x * 3 + 1)), 1);
  close(O.spearman(a, a.map((x) => -x)), -1);
  assert.ok(Number.isNaN(O.spearman([1, 2, 3], [1, 2, 3])));
});

test("factor validation: a factor equal to the future return scores IC ≈ 1, a lagged copy does not", () => {
  const g = makeSeries(1500);
  const n = g.p.length, h = 63;
  const peek = g.p.map((_, i) => (i + h < n ? Math.log(g.p[i + h] / g.p[i]) : NaN)); // look-ahead on purpose
  const [v] = O.factorValidation(g, [{ id: "peek", n: "peek", desc: "", v: peek }], [h]);
  assert.ok(v.ic[h] > 0.99, `IC ${v.ic[h]}`);
  assert.equal(v.bins.length, 5);
  assert.ok(v.bins[4].mean > v.bins[0].mean);
  // the same information known only h days later carries no edge on random-walk data
  const lagged = peek.map((_, i) => (i >= h ? peek[i - h] : NaN));
  const [w] = O.factorValidation(g, [{ id: "lag", n: "lag", desc: "", v: lagged }], [h]);
  assert.ok(Math.abs(w.ic[h]) < 0.2, `lagged IC ${w.ic[h]}`);
});

test("inventory factor respects the publication lag", () => {
  const g = { t: [100, 101, 102, 103, 104, 105, 106, 107], p: [1, 1, 1, 1, 1, 1, 1, 1] };
  const D = { inventory: { crude: { devhist: [[100, -5]] } } };
  const f = O.factorHistory(g, D).find((x) => x.id === "inv");
  assert.ok(Number.isNaN(f.v[4]), "not known before week-end + 5 days");
  assert.equal(f.v[5], -5);
});

test("leverage: 1× without fee equals the underlying; 2× in a choppy flat market loses", () => {
  const s = { t: [0, 1, 2, 3, 4], p: [100, 110, 100, 110, 100] };
  const one = O.leverage(s, 0, 4, 1, 0);
  close(one.actual, 0, 1e-12);
  const two = O.leverage(s, 0, 4, 2, 0);
  assert.equal(two.under, 0);
  assert.ok(two.actual < 0, "volatility drag");
  close(two.actual, (1.2 * (1 - 2 / 11)) ** 2 - 1, 1e-12);
});

test("product comparison: decomposition identities", () => {
  const days = Array.from({ length: 800 }, (_, i) => 17000 + i);
  const line = (f) => days.map((d, i) => [d, f(i)]);
  const D = {
    wti: { hist: line((i) => 50 + i * 0.02) },
    fx: { hist: line((i) => 1100 + i * 0.1) },
    etf: { USO: { hist: line((i) => 10 + i * 0.001) }, KODEX_WTI: { hist: line((i) => 10000 + i) } },
    etf_names: { KODEX_WTI: "KODEX", TIGER_OIL: "TIGER" },
  };
  const C = O.compareProducts(D, days[100]);
  const r = Object.fromEntries(C.rows.map((x) => [x.id, x.ret]));
  close(C.parts.roll, r.uso - r.spot);
  close(C.parts.hedge, r.kodex - r.uso);
  close(C.parts.fx, r.spotKrw - r.spot);
  close(1 + r.usoKrw, (1 + r.uso) * (D.fx.hist.at(-1)[1] / D.fx.hist[100][1]), 1e-9);
});

test("curve and inventory states", () => {
  assert.equal(O.curveState(16).key, "back");
  assert.equal(O.curveState(-8).key, "contango");
  assert.equal(O.curveState(1).key, "flat");
  assert.equal(O.inventoryState(-6).label.startsWith("재고 부족"), true);
  assert.equal(O.inventoryState(6).label.startsWith("재고 과잉"), true);
});

test("verdict combines price zones and supply", () => {
  assert.match(O.verdict(95, 90, -6, 10).title, /과열.*수급 빡빡/);
  assert.match(O.verdict(10, 10, 6, -10).title, /싼 구간.*수급 느슨/);
  assert.equal(O.verdict(50, 50, NaN, NaN).plan, "balanced");
});

test("real prices: latest month is unchanged, older prices scale with CPI", () => {
  const t = [Date.UTC(2000, 0, 10) / 864e5, Date.UTC(2026, 10, 10) / 864e5];
  const r = O.realPrices({ t, p: [20, 80] }, [["2000-01", 170], ["2026-10", 340]]);
  close(r[0], 40);
  close(r[1], 80);
});

test("alerts on a synthetic spike", () => {
  const g = makeSeries(400);
  g.p[g.p.length - 1] = g.p[g.p.length - 2] * 1.2;
  const D = { wti: { hist: g.t.map((d, i) => [d, g.p[i]]) } };
  const a = O.alerts(g, D, {});
  assert.ok(a.some((x) => x.id === "move" && x.level === "critical"));
  assert.ok(a.some((x) => x.id === "high"));
});

test("engine temperature works on oil-length windows without look-ahead", () => {
  const g = makeSeries(1800);
  const full = E.temperature(g, 1250).temp;
  const cut = E.temperature({ t: g.t.slice(0, 1700), p: g.p.slice(0, 1700) }, 1250).temp;
  for (let i = 0; i < 1700; i++) if (isFinite(cut[i])) close(full[i], cut[i]);
});
