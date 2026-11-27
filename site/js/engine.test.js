// node --test site/js/engine.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./engine.js");

// deterministic pseudo-random price path (business days)
function makeGold(n = 1500, seed = 7) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const t = [], p = []; let d = 11000, v = 1000;
  for (let i = 0; i < n; i++) { t.push(d); p.push(v); d += (i % 5 === 4) ? 3 : 1; v *= 1 + (rnd() - 0.49) * 0.03; }
  return { t, p };
}
const macro = (g) => ({
  DFII10: g.t.filter((_, i) => i % 5 === 0).map((d, k) => [d, 1 + Math.sin(k / 9)]),
  DTWEXBGS: g.t.filter((_, i) => i % 5 === 0).map((d, k) => [d, 100 + 5 * Math.cos(k / 13)]),
  T10YIE: g.t.filter((_, i) => i % 5 === 0).map((d, k) => [d, 2 + 0.3 * Math.sin(k / 7)]),
});
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("sma and rsi basics", () => {
  assert.deepEqual(E.sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
  const r = E.rsi(makeGold().p);
  assert.ok(r.filter(isFinite).every((x) => x >= 0 && x <= 100));
  assert.equal(E.rsi([1, 2, 3, 4, 5, 6], 3)[5], 100);
});

test("buy & hold with no cost equals price ratio (lag 0)", () => {
  const g = makeGold();
  const res = E.backtest(g, E.targets("buyhold", g), { lag: 0 });
  close(res.eq.at(-1), g.p.at(-1) / g.p[0], 1e-9);
});

test("entry cost is charged once on the traded weight", () => {
  const g = makeGold();
  const a = E.backtest(g, E.targets("buyhold", g), { lag: 0, cost: 0 });
  const b = E.backtest(g, E.targets("buyhold", g), { lag: 0, cost: 0.01 });
  close(b.eq.at(-1), a.eq.at(-1) * 0.99, 1e-9);
});

test("all-cash target compounds at the cash rate", () => {
  const g = makeGold(300);
  const res = E.backtest(g, new Array(300).fill(0), { cash: 0.05 });
  close(res.eq.at(-1), Math.pow(1.05, (g.t.at(-1) - g.t[0]) / 365), 1e-9);
});

for (const kind of Object.keys(E.STRATEGIES)) {
  test(`no look-ahead: ${kind}`, () => {
    const g = makeGold(), k = 900;
    const m = macro(g);
    const base = E.targets(kind, g, {}, { macro: m, start: 100 });
    const g2 = { t: g.t, p: g.p.map((v, i) => (i > k ? v * (i % 2 ? 3 : 0.2) : v)) };
    const m2 = Object.fromEntries(Object.entries(m).map(([key, s]) => [key, s.map(([d, v]) => [d, d > g.t[k] ? v * 9 : v])]));
    const alt = E.targets(kind, g2, {}, { macro: m2, start: 100 });
    assert.deepEqual(alt.slice(0, k + 1), base.slice(0, k + 1));
    // equity up to k uses only prices up to k
    const r1 = E.backtest(g, base, { start: 100, end: 1400, cost: 0.002, cash: 0.02 });
    const r2 = E.backtest(g2, alt, { start: 100, end: 1400, cost: 0.002, cash: 0.02 });
    assert.deepEqual(r2.eq.slice(0, k - 100 + 1), r1.eq.slice(0, k - 100 + 1));
  });
}

test("macro data is used only after its publication lag", () => {
  const out = E.alignSeries([10, 11, 12], [[10, 1], [11, 2]], 1);
  assert.ok(Number.isNaN(out[0]));
  assert.deepEqual(out.slice(1), [1, 2]);
});

test("walk-forward choices depend only on the training window", () => {
  const g = makeGold(2600);
  const o = { start: 0, cost: 0.001, cash: 0.02 };
  const a = E.walkForward(g, o, 5);
  const firstTestEnd = g.t.indexOf(a.choices[0].to);
  const g2 = { t: g.t, p: g.p.map((v, i) => (i > 1260 ? v * (1 + (i % 7) / 10) : v)) };
  const b = E.walkForward(g2, o, 5);
  assert.equal(b.choices[0].fast, a.choices[0].fast);
  assert.equal(b.choices[0].slow, a.choices[0].slow);
  assert.ok(firstTestEnd > 1260);
});

test("metrics: drawdown and calendar stats", () => {
  const res = { eq: [1, 1.2, 0.9, 1.0, 1.3], t: [0, 31, 62, 93, 124], trades: 1, exposure: 1 };
  const m = E.metrics(res, 0);
  close(m.mdd, 0.9 / 1.2 - 1);
  assert.equal(m.uwDays, 93); // peak at day 31, recovered at day 124
});

test("seasonality table and yearly returns are consistent", () => {
  const g = makeGold(800);
  const s = E.seasonality(g);
  assert.equal(s.months.length, 12);
  const res = E.backtest(g, E.targets("buyhold", g), { lag: 0 });
  const y = E.yearly(res);
  const total = Object.values(y).reduce((a, r) => a * (1 + r), 1);
  close(total, res.eq.at(-1), 1e-9);
});

test("temperature ranks only against the past", () => {
  const g = makeGold(1400), k = 1000;
  const a = E.temperature(g, 200, 300);
  const g2 = { t: g.t, p: g.p.map((v, i) => (i > k ? v * 5 : v)) };
  const b = E.temperature(g2, 200, 300);
  assert.deepEqual(b.temp.slice(0, k + 1), a.temp.slice(0, k + 1));
  assert.ok(a.temp.filter(isFinite).every((x) => x >= 0 && x <= 100));
});

test("priceAtTemp is monotonic and brackets today's price", () => {
  const g = makeGold(1600), T = E.temperature(g, 200, 300);
  const lo = E.priceAtTemp(T, 5), mid = E.priceAtTemp(T, 50), hi = E.priceAtTemp(T, 95);
  assert.ok(lo < mid && mid < hi);
});

test("plan costs: lump-sum plan costs exactly the day's price", () => {
  const g = makeGold(600);
  close(E.planCost(g, { now: 1, tranches: 1 }, 10), 0);
  const w = E.planWeights("balanced");
  close(w.reduce((a, b) => a + b, 0), 1);
  assert.ok(Number.isNaN(E.planCost(g, "defensive", 590)));
});

test("analog forecast only uses outcomes known at forecast time", () => {
  const g = makeGold(2200), F = E.features(g), i = 1800, h = 63;
  const a = E.analogForecast(g, F, i, h, 60);
  const g2 = { t: g.t, p: g.p.map((v, j) => (j > i ? v * 4 : v)) };
  const b = E.analogForecast(g2, E.features(g2), i, h, 60);
  assert.ok(a && b);
  assert.deepEqual(b.q, a.q);
  for (let k = 1; k < a.q.length; k++) assert.ok(a.q[k] >= a.q[k - 1]);
});

test("forecast evaluation returns coverage between 0 and 1", () => {
  const g = makeGold(2600), ev = E.evaluateForecast(g, E.features(g), 63, { start: 1500, step: 42, k: 60 });
  assert.ok(ev.n > 5);
  for (const key of ["model", "base"]) assert.ok(ev[key].c80 >= 0 && ev[key].c80 <= 1);
});

test("HMM recovers two clearly separated regimes", () => {
  let s = 3; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const x = []; for (let b = 0; b < 8; b++) for (let k = 0; k < 60; k++) x.push((b % 2 ? 0.02 : -0.02) + 0.005 * gauss());
  const m = E.hmmFit(x, 2, 80);
  assert.ok(Math.abs(m.mu[0] + 0.02) < 0.004 && Math.abs(m.mu[1] - 0.02) < 0.004, JSON.stringify(m.mu));
  assert.ok(m.filtered.every((r) => Math.abs(r[0] + r[1] - 1) < 1e-6));
});

test("signal validation buckets cover the sample", () => {
  const g = makeGold(1800), sc = g.p.map((_, i) => (i % 100) - 50);
  const v = E.signalValidation(g, sc, [21]);
  assert.equal(v.bins.length, 5);
  assert.ok(isFinite(v.ic[21]));
});

test("range model: ordered quantiles, λ ≥ 1, today's range ignores nothing but the past", () => {
  const g = makeGold(2600), rm = E.rangeModel(g, [63], { start: 1500, step: 42 });
  const r = rm[63];
  assert.ok(r.eval.n > 5 && r.now && r.now.lam >= 1);
  for (let k = 1; k < r.now.q.length; k++) assert.ok(r.now.q[k] >= r.now.q[k - 1]);
  assert.ok(r.eval.model.c80 >= 0 && r.eval.model.c80 <= 1);
});
