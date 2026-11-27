/* Gold Miner — analysis & backtest engine (Phase 2–3).
 * Pure functions, no DOM. Works in the browser (window.GMEngine) and in Node (require).
 *
 * Timing convention (no look-ahead):
 *   target[i]  = desired gold weight computed from information up to close i.
 *   With execution lag L, that target is traded at close i+L and is held over
 *   the return from close i+L to close i+L+1.
 *   Macro series are used only from the day after their observation date
 *   (publication lag), forward-filled.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const TD = 252;

  // ------------------------------------------------------------ indicators
  function sma(p, n) {
    const out = new Array(p.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      s += p[i];
      if (i >= n) s -= p[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  function rsi(p, n = 14) {
    const out = new Array(p.length).fill(NaN);
    let g = 0, l = 0;
    for (let i = 1; i < p.length; i++) {
      const d = p[i] - p[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); continue; }
      g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function rollVol(p, n = 60) {
    const out = new Array(p.length).fill(NaN);
    const r = p.map((v, i) => (i ? Math.log(v / p[i - 1]) : 0));
    let s = 0, s2 = 0;
    for (let i = 1; i < p.length; i++) {
      s += r[i]; s2 += r[i] * r[i];
      if (i > n) { s -= r[i - n]; s2 -= r[i - n] * r[i - n]; }
      if (i >= n) { const m = s / n; out[i] = Math.sqrt(Math.max(s2 / n - m * m, 0) * n / (n - 1)) * Math.sqrt(TD); }
    }
    return out;
  }

  /** Forward-fill a sparse series [[day, value]] onto `days`, using only observations
   *  dated at least `pubLag` days earlier. */
  function alignSeries(days, series, pubLag = 1) {
    const out = new Array(days.length).fill(NaN);
    if (!series || !series.length) return out;
    let j = 0, last = NaN;
    for (let i = 0; i < days.length; i++) {
      while (j < series.length && series[j][0] <= days[i] - pubLag) { last = series[j][1]; j++; }
      out[i] = last;
    }
    return out;
  }

  /** Value `back` calendar days earlier (latest index with day <= day[i]-back). */
  function lagByDays(days, vals, back) {
    const out = new Array(days.length).fill(NaN);
    let j = 0;
    for (let i = 0; i < days.length; i++) {
      while (j + 1 < days.length && days[j + 1] <= days[i] - back) j++;
      if (days[j] <= days[i] - back) out[i] = vals[j];
    }
    return out;
  }

  // ------------------------------------------------------------ signal (shared with dashboard)
  const clamp2 = (v) => Math.max(-2, Math.min(2, v));
  /** Rules for the automatic factors. Inputs may be NaN (factor then scores 0). */
  const FACTOR_RULES = [
    { id: "real", n: "실질금리 추세", w: 22, f: (x) => clamp2(-Math.round(x.realChg1m / 0.12)) },
    { id: "usd", n: "달러 추세", w: 15, f: (x) => clamp2(-Math.round(x.usdPct1m / 1.2)) },
    { id: "infl", n: "기대인플레이션", w: 8, f: (x) => clamp2(Math.round(x.inflChg1m / 0.1)) },
    { id: "trend", n: "가격 추세", w: 15, f: (x) => (isFinite(x.dev200) ? (x.dev200 >= 0 ? 1 : -1) : NaN) },
    { id: "ob", n: "과매도·과열", w: 15, f: (x) => (!isFinite(x.ret3m) ? NaN : x.ret3m < -15 ? 2 : x.ret3m < -7 ? 1 : x.ret3m > 20 ? -2 : x.ret3m > 10 ? -1 : 0) },
  ];
  const AUTO_MAX = FACTOR_RULES.reduce((a, r) => a + r.w, 0); // score range ±AUTO_MAX

  function factorValues(x) {
    return FACTOR_RULES.map((r) => { const v = r.f(x); return isFinite(v) ? v : 0; });
  }

  /** Daily history of the automatic signal score at gold dates. */
  function signalHistory(gold, macro) {
    const { t, p } = gold;
    const real = alignSeries(t, macro && macro.DFII10), usd = alignSeries(t, macro && macro.DTWEXBGS), infl = alignSeries(t, macro && macro.T10YIE);
    const real30 = lagByDays(t, real, 30), usd30 = lagByDays(t, usd, 30), infl30 = lagByDays(t, infl, 30), p91 = lagByDays(t, p, 91);
    const s200 = sma(p, 200);
    const score = new Array(t.length);
    let x, v;
    for (let i = 0; i < t.length; i++) {
      x = {
        realChg1m: real[i] - real30[i], usdPct1m: (usd[i] / usd30[i] - 1) * 100, inflChg1m: infl[i] - infl30[i],
        dev200: (p[i] / s200[i] - 1) * 100, ret3m: (p[i] / p91[i] - 1) * 100,
      };
      v = factorValues(x);
      score[i] = FACTOR_RULES.reduce((a, r, k) => a + (r.w * v[k]) / 2, 0);
    }
    score.last = { inputs: x, values: v }; // factor detail at the latest date
    return score;
  }

  // ------------------------------------------------------------ strategies → target weights
  const STRATEGIES = {
    buyhold: { n: "일시 매입·보유", params: {} },
    dca: { n: "분할 매입", params: { months: 12 } },
    ma: { n: "이동평균 교차", params: { fast: 50, slow: 200 } },
    rsi: { n: "RSI 역추세", params: { len: 14, lo: 30, hi: 70 } },
    vol: { n: "변동성 타깃", params: { target: 15, len: 60 } },
    signal: { n: "시그널 비중조절", params: {} },
  };

  function targets(kind, gold, prm = {}, ctx = {}) {
    const { p } = gold, n = p.length, out = new Array(n).fill(0);
    const P = Object.assign({}, STRATEGIES[kind] ? STRATEGIES[kind].params : {}, prm);
    if (kind === "buyhold") out.fill(1);
    else if (kind === "dca") {
      const s = ctx.start || 0, k = Math.max(1, P.months);
      for (let i = 0; i < n; i++) out[i] = i < s ? 0 : Math.min(1, (Math.floor((i - s) / 21) + 1) / k);
    } else if (kind === "ma") {
      const f = sma(p, P.fast), s = sma(p, P.slow);
      for (let i = 0; i < n; i++) out[i] = f[i] > s[i] ? 1 : 0;
    } else if (kind === "rsi") {
      const r = rsi(p, P.len); let inPos = false;
      for (let i = 0; i < n; i++) { if (r[i] < P.lo) inPos = true; else if (r[i] > P.hi) inPos = false; out[i] = inPos ? 1 : 0; }
    } else if (kind === "vol") {
      const v = rollVol(p, P.len);
      for (let i = 0; i < n; i++) out[i] = isFinite(v[i]) && v[i] > 0 ? Math.min(1, P.target / 100 / v[i]) : 0;
    } else if (kind === "signal") {
      const sc = ctx.score || signalHistory(gold, ctx.macro);
      for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(1, (sc[i] / AUTO_MAX + 1) / 2));
    } else throw new Error("unknown strategy " + kind);
    return out;
  }

  // ------------------------------------------------------------ backtest
  /**
   * @param gold {t:number[] epoch days, p:number[] closes}
   * @param target desired weight per index (0..1)
   * @param o {start, end, cost (one-way, fraction), cash (annual, fraction), lag (days), band}
   */
  function backtest(gold, target, o = {}) {
    const { t, p } = gold;
    const s = o.start || 0, e = o.end == null ? p.length - 1 : o.end;
    const cost = o.cost || 0, cash = o.cash || 0, lag = o.lag == null ? 1 : o.lag, band = o.band == null ? 0.02 : o.band;
    const eq = [1], w = [0], days = [t[s]];
    let E = 1, h = 0, trades = 0, turnover = 0, expo = 0;
    for (let j = s + 1; j <= e; j++) {
      const k = j - 1 - lag;
      let d = k >= 0 ? target[k] : 0;
      if (!isFinite(d)) d = 0;
      const diff = d - h;
      if (Math.abs(diff) > band || (d === 0 && h > 0) || (d === 1 && h < 1 && Math.abs(diff) > 1e-9)) {
        E *= 1 - cost * Math.abs(diff); turnover += Math.abs(diff); trades++; h = d;
      }
      const r = p[j] / p[j - 1] - 1, c = Math.pow(1 + cash, (t[j] - t[j - 1]) / 365) - 1;
      const g = h * (1 + r) + (1 - h) * (1 + c);
      E *= g; h = g > 0 ? (h * (1 + r)) / g : 0; expo += h;
      eq.push(E); w.push(h); days.push(t[j]);
    }
    return { eq, w, t: days, trades, turnover, exposure: expo / Math.max(1, e - s) };
  }

  // ------------------------------------------------------------ metrics
  function drawdown(eq) {
    let pk = -Infinity; return eq.map((v) => { pk = Math.max(pk, v); return v / pk - 1; });
  }

  function monthEnds(t, v) {
    const out = [];
    for (let i = 0; i < t.length; i++) {
      const d = new Date(t[i] * 864e5), key = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (out.length && out[out.length - 1].key === key) out[out.length - 1] = { key, i, v: v[i] };
      else out.push({ key, i, v: v[i] });
    }
    return out;
  }

  function metrics(res, cash = 0) {
    const { eq, t } = res, n = eq.length;
    const yrs = (t[n - 1] - t[0]) / 365.25;
    const r = eq.slice(1).map((v, i) => v / eq[i] - 1);
    const cd = Math.pow(1 + cash, 1 / TD) - 1;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
    const down = Math.sqrt(r.reduce((a, b) => a + Math.min(b - cd, 0) ** 2, 0) / r.length);
    const cagr = Math.pow(eq[n - 1], 1 / yrs) - 1;
    const dd = drawdown(eq); let mdd = 0, mddEnd = 0;
    dd.forEach((v, i) => { if (v < mdd) { mdd = v; mddEnd = i; } });
    // longest underwater spell in calendar days
    let longest = 0, startUW = null;
    for (let i = 0; i < n; i++) {
      if (dd[i] < -1e-9) { if (startUW === null) startUW = i - 1 < 0 ? 0 : i - 1; }
      else if (startUW !== null) { longest = Math.max(longest, t[i] - t[startUW]); startUW = null; }
    }
    if (startUW !== null) longest = Math.max(longest, t[n - 1] - t[startUW]);
    const me = monthEnds(t, eq); let up = 0, cnt = 0;
    for (let i = 1; i < me.length; i++) { cnt++; if (me[i].v > me[i - 1].v) up++; }
    const vol = sd * Math.sqrt(TD);
    return {
      final: eq[n - 1], cagr, vol, sharpe: vol ? ((mean - cd) * TD) / vol : 0, sortino: down ? ((mean - cd) * TD) / (down * Math.sqrt(TD)) : 0,
      mdd, mddDate: t[mddEnd], uwDays: longest, calmar: mdd ? cagr / -mdd : 0, winMonths: cnt ? up / cnt : 0,
      tradesPerYear: res.trades / yrs, exposure: res.exposure, years: yrs,
    };
  }

  function rolling(res, years = 3) {
    const { eq, t } = res, out = []; let j = 0;
    for (let i = 0; i < eq.length; i++) {
      while (j < i && t[j + 1] <= t[i] - years * 365.25) j++;
      if (t[i] - t[j] >= years * 365.25 - 7) out.push([t[i], Math.pow(eq[i] / eq[j], 365.25 / (t[i] - t[j])) - 1]);
    }
    return out;
  }

  function yearly(res) {
    const { eq, t } = res, out = {}; let prev = eq[0], year = new Date(t[0] * 864e5).getUTCFullYear();
    for (let i = 1; i < eq.length; i++) {
      const y = new Date(t[i] * 864e5).getUTCFullYear();
      if (y !== year) { out[year] = eq[i - 1] / prev - 1; prev = eq[i - 1]; year = y; }
    }
    out[year] = eq[eq.length - 1] / prev - 1;
    return out;
  }

  // ------------------------------------------------------------ validation
  const GRID_FAST = [10, 20, 50, 100], GRID_SLOW = [100, 150, 200, 250];

  function grid(gold, o, fasts = GRID_FAST, slows = GRID_SLOW) {
    const smas = {}; [...new Set([...fasts, ...slows])].forEach((n) => (smas[n] = sma(gold.p, n)));
    return fasts.map((f) => slows.map((s) => {
      if (f >= s) return null;
      const tg = smas[f].map((v, i) => (v > smas[s][i] ? 1 : 0));
      const m = metrics(backtest(gold, tg, o), o.cash);
      return { fast: f, slow: s, sharpe: m.sharpe, cagr: m.cagr, mdd: m.mdd };
    }));
  }

  /** Walk-forward: each year, pick the (fast, slow) pair with the best Sharpe over the
   *  previous `trainYears`, then trade it for the next `testDays`. Returns the stitched
   *  out-of-sample result and the choices made. */
  function walkForward(gold, o, trainYears = 5, testDays = TD) {
    const { p } = gold, smas = {};
    [...new Set([...GRID_FAST, ...GRID_SLOW])].forEach((n) => (smas[n] = sma(p, n)));
    const s0 = o.start || 0, e = o.end == null ? p.length - 1 : o.end, W = trainYears * TD;
    const target = new Array(p.length).fill(0), choices = [];
    let k = s0 + W;
    while (k < e) {
      let best = null;
      for (const f of GRID_FAST) for (const s of GRID_SLOW) {
        if (f >= s) continue;
        const tg = smas[f].map((v, i) => (v > smas[s][i] ? 1 : 0));
        const m = metrics(backtest(gold, tg, Object.assign({}, o, { start: k - W, end: k })), o.cash);
        if (!best || m.sharpe > best.sharpe) best = { fast: f, slow: s, sharpe: m.sharpe };
      }
      const to = Math.min(k + testDays, e);
      for (let i = k; i < to; i++) target[i] = smas[best.fast][i] > smas[best.slow][i] ? 1 : 0;
      choices.push({ from: gold.t[k], to: gold.t[to], fast: best.fast, slow: best.slow, trainSharpe: best.sharpe });
      k = to;
    }
    const oosStart = s0 + W;
    // targets before oosStart are 0; with lag the first OOS trade happens at oosStart+lag
    return { res: backtest(gold, target, Object.assign({}, o, { start: Math.min(oosStart, e - 1), end: e })), choices, oosStart };
  }

  // ------------------------------------------------------------ price analysis (Phase 2)
  function seasonality(gold, fromYear = 0) {
    const me = monthEnds(gold.t, gold.p), byM = Array.from({ length: 12 }, () => []), table = {};
    for (let i = 1; i < me.length; i++) {
      const y = Math.floor(me[i].key / 12), m = me[i].key % 12, r = me[i].v / me[i - 1].v - 1;
      if (me[i].key - me[i - 1].key !== 1) continue;
      (table[y] = table[y] || {})[m] = r;
      if (y >= fromYear) byM[m].push(r);
    }
    const months = byM.map((a) => {
      const s = [...a].sort((x, y) => x - y);
      return { n: a.length, mean: a.reduce((x, y) => x + y, 0) / (a.length || 1), median: s.length ? s[Math.floor(s.length / 2)] : NaN, win: a.filter((x) => x > 0).length / (a.length || 1) };
    });
    const wd = Array.from({ length: 5 }, () => []);
    for (let i = 1; i < gold.p.length; i++) {
      if (new Date(gold.t[i] * 864e5).getUTCFullYear() < fromYear) continue;
      const dow = new Date(gold.t[i] * 864e5).getUTCDay();
      if (dow >= 1 && dow <= 5 && gold.t[i] - gold.t[i - 1] <= 4) wd[dow - 1].push(gold.p[i] / gold.p[i - 1] - 1);
    }
    const weekdays = wd.map((a) => ({ n: a.length, mean: a.reduce((x, y) => x + y, 0) / (a.length || 1), win: a.filter((x) => x > 0).length / (a.length || 1) }));
    return { months, weekdays, table };
  }

  /** Weekly gold returns vs weekly changes of a macro series, rolling correlation. */
  function rollingCorr(gold, series, weeks = 52, mode = "diff") {
    if (!series || series.length < weeks + 2) return [];
    const days = series.map((x) => x[0]);
    // gold close on or before each macro date (same-day info only, no look-ahead)
    const g = []; let j = 0;
    for (const d of days) { while (j + 1 < gold.t.length && gold.t[j + 1] <= d) j++; g.push(gold.t[j] <= d ? gold.p[j] : NaN); }
    const gr = [], mr = [], dd = [];
    for (let i = 1; i < days.length; i++) {
      const a = Math.log(g[i] / g[i - 1]), b = mode === "pct" ? Math.log(series[i][1] / series[i - 1][1]) : series[i][1] - series[i - 1][1];
      if (isFinite(a) && isFinite(b)) { gr.push(a); mr.push(b); dd.push(days[i]); }
    }
    const out = [];
    for (let i = weeks; i <= gr.length; i++) {
      const A = gr.slice(i - weeks, i), B = mr.slice(i - weeks, i);
      const ma = A.reduce((x, y) => x + y, 0) / weeks, mb = B.reduce((x, y) => x + y, 0) / weeks;
      let sab = 0, saa = 0, sbb = 0;
      for (let k = 0; k < weeks; k++) { sab += (A[k] - ma) * (B[k] - mb); saa += (A[k] - ma) ** 2; sbb += (B[k] - mb) ** 2; }
      out.push([dd[i - 1], saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN]);
    }
    return out;
  }

  return { sma, rsi, rollVol, alignSeries, lagByDays, FACTOR_RULES, AUTO_MAX, factorValues, signalHistory, STRATEGIES, targets, backtest, drawdown, metrics, rolling, yearly, grid, walkForward, seasonality, rollingCorr, monthEnds, GRID_FAST, GRID_SLOW };
});
