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
    above: { n: "추세선 위 보유", params: { len: 1000 } },
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
    } else if (kind === "above") {
      const m = sma(p, P.len);
      for (let i = 0; i < n; i++) out[i] = p[i] > m[i] ? 1 : 0;
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

  // ------------------------------------------------------------ main board: valuation & plans
  function rankIn(sorted, v) { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } return lo; }

  /** "Price temperature": percentile (0–100) of today's deviation from a moving average,
   *  ranked only against deviations seen BEFORE today (expanding window). */
  function temperature(gold, len, minObs = 500) {
    const { p } = gold, m = sma(p, len), dev = p.map((v, i) => v / m[i] - 1);
    const seen = [], temp = new Array(p.length).fill(NaN);
    for (let i = 0; i < p.length; i++) {
      if (!isFinite(dev[i])) continue;
      if (seen.length >= minObs) temp[i] = (rankIn(seen, dev[i]) / seen.length) * 100;
      seen.splice(rankIn(seen, dev[i]), 0, dev[i]);
    }
    return { len, sma: m, dev, temp, sorted: seen };
  }

  /** Price at which today's temperature would equal `q` (uses today's moving average). */
  function priceAtTemp(T, q) {
    const s = T.sorted, k = Math.min(s.length - 1, Math.max(0, Math.round((q / 100) * (s.length - 1))));
    return T.sma[T.sma.length - 1] * (1 + s[k]);
  }

  const ZONES = [[0, 20, "매우 저렴"], [20, 40, "저렴"], [40, 60, "보통"], [60, 80, "비쌈"], [80, 101, "매우 비쌈"]];
  const zoneOf = (x) => ZONES.find((z) => x >= z[0] && x < z[1]) || ZONES[ZONES.length - 1];

  /** Forward return statistics on days where cond(i) holds. */
  function forwardStats(gold, cond, horizon = TD) {
    const { p, t } = gold, f = [], ep = [];
    for (let i = 0; i + horizon < p.length; i++) if (cond(i)) { f.push(p[i + horizon] / p[i] - 1); ep.push(t[i]); }
    const s = [...f].sort((a, b) => a - b);
    // distinct episodes: condition days more than 60 days apart start a new episode
    const episodes = []; ep.forEach((d) => { if (!episodes.length || d - episodes[episodes.length - 1].end > 60) episodes.push({ start: d, end: d }); else episodes[episodes.length - 1].end = d; });
    return { n: f.length, mean: f.reduce((a, b) => a + b, 0) / (f.length || 1), median: s.length ? s[s.length >> 1] : NaN, up: f.filter((x) => x > 0).length / (f.length || 1), p10: s[Math.floor(s.length * 0.1)], p90: s[Math.floor(s.length * 0.9)], episodes };
  }

  /** Buying plans: share bought today, then equal tranches every 21 trading days. */
  const PLANS = {
    aggressive: { n: "공격형", now: 0.6, tranches: 3, desc: "오늘 60%, 나머지는 2개월에 나눠" },
    balanced: { n: "균형형", now: 0.3, tranches: 6, desc: "오늘 30%, 나머지는 5개월에 나눠" },
    defensive: { n: "안정형", now: 0.15, tranches: 12, desc: "오늘 15%, 나머지는 11개월에 나눠" },
  };
  function planWeights(plan) {
    const P = PLANS[plan] || plan, rest = (1 - P.now) / Math.max(1, P.tranches - 1);
    return Array.from({ length: P.tranches }, (_, k) => (k === 0 ? P.now : rest));
  }
  /** Average cost of a plan relative to buying everything on day i (−0.03 = 3% cheaper). */
  function planCost(gold, plan, i) {
    const w = planWeights(plan), p = gold.p; let units = 0;
    for (let k = 0; k < w.length; k++) { const j = i + 21 * k; if (j >= p.length) return NaN; units += w[k] / p[j]; }
    return 1 / units / p[i] - 1;
  }
  function planStats(gold, plan, cond) {
    const d = [];
    for (let i = 0; i < gold.p.length; i++) if (cond(i)) { const c = planCost(gold, plan, i); if (isFinite(c)) d.push(c); }
    const s = [...d].sort((a, b) => a - b);
    return { n: d.length, mean: d.reduce((a, b) => a + b, 0) / (d.length || 1), cheaper: d.filter((x) => x < 0).length / (d.length || 1), best10: s[Math.floor(s.length * 0.1)], worst10: s[Math.floor(s.length * 0.9)] };
  }

  // ------------------------------------------------------------ Phase 4: models
  /** Percentile of each value among values seen before it (0..1, no look-ahead). */
  function expandingPct(vals, minObs = 250) {
    const seen = [], out = new Array(vals.length).fill(NaN);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i]; if (!isFinite(v)) continue;
      if (seen.length >= minObs) out[i] = rankIn(seen, v) / seen.length;
      seen.splice(rankIn(seen, v), 0, v);
    }
    return out;
  }

  /** Feature matrix for analog forecasts. Every feature uses data up to day i only. */
  function features(gold) {
    const p = gold.p, n = p.length;
    const tS = temperature(gold, 200).temp, tL = temperature(gold, 1000).temp;
    const p63 = p.map((v, i) => (i >= 63 ? v / p[i - 63] - 1 : NaN));
    const vol = rollVol(p, 60);
    const mom = expandingPct(p63), vp = expandingPct(vol);
    const X = [];
    for (let i = 0; i < n; i++) X.push([tS[i] / 100, tL[i] / 100, mom[i], vp[i]]);
    return { X, names: ["1년 온도", "4년 온도", "3개월 모멘텀", "변동성"] };
  }

  const QS = [0.1, 0.25, 0.5, 0.75, 0.9];
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const h = (sorted.length - 1) * q, lo = Math.floor(h);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (h - lo);
  }

  /** Analog (nearest-neighbour) forecast of the `horizon`-day log return at day i.
   *  Uses only days j whose outcome was already known at i (j + horizon <= i). */
  function analogForecast(gold, F, i, horizon, k = 120, stride = 3) {
    const p = gold.p, x = F.X[i];
    if (!x || x.some((v) => !isFinite(v))) return null;
    const cand = [];
    for (let j = 0; j + horizon <= i; j += stride) {
      const y = F.X[j]; if (y.some((v) => !isFinite(v))) continue;
      let d = 0; for (let k2 = 0; k2 < x.length; k2++) d += (x[k2] - y[k2]) ** 2;
      cand.push([d, Math.log(p[j + horizon] / p[j])]);
    }
    if (cand.length < k) return null;
    cand.sort((a, b) => a[0] - b[0]);
    const r = cand.slice(0, k).map((c) => c[1]).sort((a, b) => a - b);
    return { q: QS.map((q) => quantile(r, q)), up: r.filter((v) => v > 0).length / r.length, n: r.length };
  }

  /** Unconditional baseline: all past outcomes known at day i. */
  function baselineForecast(gold, i, horizon) {
    const p = gold.p, r = [];
    for (let j = 0; j + horizon <= i; j++) r.push(Math.log(p[j + horizon] / p[j]));
    if (r.length < 250) return null;
    r.sort((a, b) => a - b);
    return { q: QS.map((q) => quantile(r, q)), up: r.filter((v) => v > 0).length / r.length, n: r.length };
  }

  const pinball = (q, pred, y) => (y >= pred ? q * (y - pred) : (1 - q) * (pred - y));

  /** Walk-forward evaluation every `step` days: forecast, then score against what happened. */
  function evaluateForecast(gold, F, horizon, o = {}) {
    const step = o.step || 21, start = o.start || 1500, k = o.k || 120;
    const acc = { model: { pin: 0, c80: 0, c50: 0, brier: 0 }, base: { pin: 0, c80: 0, c50: 0, brier: 0 }, n: 0, series: [] };
    for (let i = start; i + horizon < gold.p.length; i += step) {
      const m = analogForecast(gold, F, i, horizon, k), b = baselineForecast(gold, i, horizon);
      if (!m || !b) continue;
      const y = Math.log(gold.p[i + horizon] / gold.p[i]), up = y > 0 ? 1 : 0;
      for (const [key, f] of [["model", m], ["base", b]]) {
        const a = acc[key];
        a.pin += QS.reduce((s2, q, qi) => s2 + pinball(q, f.q[qi], y), 0) / QS.length;
        a.c80 += y >= f.q[0] && y <= f.q[4] ? 1 : 0;
        a.c50 += y >= f.q[1] && y <= f.q[3] ? 1 : 0;
        a.brier += (f.up - up) ** 2;
      }
      acc.n++; acc.series.push({ t: gold.t[i], y, m: m.q, b: b.q });
    }
    for (const key of ["model", "base"]) { const a = acc[key]; for (const f of ["pin", "c80", "c50", "brier"]) a[f] /= acc.n || 1; }
    acc.skill = 1 - acc.model.pin / acc.base.pin; // >0: model beats baseline
    return acc;
  }

  /** Signal score vs subsequent returns, by score bucket, plus rank IC. */
  const SCORE_BINS = [[-1e9, -30, "−30 이하"], [-30, -10, "−30~−10"], [-10, 10, "−10~+10"], [10, 30, "+10~+30"], [30, 1e9, "+30 이상"]];
  function signalValidation(gold, score, horizons = [21, 63, 126]) {
    const p = gold.p, out = { bins: [], ic: {} };
    const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => (r[i] = k)); return r; };
    for (const h of horizons) {
      const xs = [], ys = [];
      for (let i = 1000; i + h < p.length; i++) if (isFinite(score[i])) { xs.push(score[i]); ys.push(p[i + h] / p[i] - 1); }
      const rx = rank(xs), ry = rank(ys), m = (xs.length - 1) / 2;
      let sxy = 0, sxx = 0; for (let k = 0; k < xs.length; k++) { sxy += (rx[k] - m) * (ry[k] - m); sxx += (rx[k] - m) ** 2; }
      out.ic[h] = sxy / sxx;
    }
    for (const [a, b, label] of SCORE_BINS) {
      const row = { label, n: 0 };
      for (const h of horizons) {
        const f = []; for (let i = 1000; i + h < p.length; i++) if (score[i] >= a && score[i] < b) f.push(p[i + h] / p[i] - 1);
        row.n = Math.max(row.n, f.length);
        row[h] = { mean: f.reduce((x, y) => x + y, 0) / (f.length || 1), up: f.filter((x) => x > 0).length / (f.length || 1), n: f.length };
      }
      out.bins.push(row);
    }
    return out;
  }

  // ---- Gaussian hidden Markov model (regimes) on a return series
  function hmmFit(x, K = 3, iters = 60, seed = 1) {
    const T = x.length, mean = x.reduce((a, b) => a + b, 0) / T, sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / T);
    const sorted = [...x].sort((a, b) => a - b);
    let mu = Array.from({ length: K }, (_, k) => quantile(sorted, (k + 0.5) / K));
    let sg = Array(K).fill(sd), pi = Array(K).fill(1 / K);
    let A = Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i === j ? 0.9 : 0.1 / (K - 1))));
    const pdf = (v, m, s) => Math.exp(-0.5 * ((v - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI)) + 1e-300;
    let ll = -Infinity, alpha, beta, c, gamma;
    for (let it = 0; it < iters; it++) {
      // forward (scaled)
      alpha = Array.from({ length: T }, () => new Array(K)); c = new Array(T);
      for (let k = 0; k < K; k++) alpha[0][k] = pi[k] * pdf(x[0], mu[k], sg[k]);
      c[0] = alpha[0].reduce((a, b) => a + b, 0); alpha[0] = alpha[0].map((v) => v / c[0]);
      for (let t = 1; t < T; t++) {
        for (let j = 0; j < K; j++) { let s2 = 0; for (let i = 0; i < K; i++) s2 += alpha[t - 1][i] * A[i][j]; alpha[t][j] = s2 * pdf(x[t], mu[j], sg[j]); }
        c[t] = alpha[t].reduce((a, b) => a + b, 0); alpha[t] = alpha[t].map((v) => v / c[t]);
      }
      // backward
      beta = Array.from({ length: T }, () => new Array(K).fill(1));
      for (let t = T - 2; t >= 0; t--) for (let i = 0; i < K; i++) { let s2 = 0; for (let j = 0; j < K; j++) s2 += A[i][j] * pdf(x[t + 1], mu[j], sg[j]) * beta[t + 1][j]; beta[t][i] = s2 / c[t + 1]; }
      gamma = alpha.map((a, t) => { const g = a.map((v, k) => v * beta[t][k]); const z = g.reduce((p2, q2) => p2 + q2, 0); return g.map((v) => v / z); });
      // M step
      const xi = Array.from({ length: K }, () => new Array(K).fill(0));
      for (let t = 0; t < T - 1; t++) for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) xi[i][j] += (alpha[t][i] * A[i][j] * pdf(x[t + 1], mu[j], sg[j]) * beta[t + 1][j]) / c[t + 1];
      A = xi.map((row) => { const z = row.reduce((a, b) => a + b, 0); return row.map((v) => v / z); });
      pi = gamma[0].slice();
      for (let k = 0; k < K; k++) {
        let w = 0, m1 = 0; for (let t = 0; t < T; t++) { w += gamma[t][k]; m1 += gamma[t][k] * x[t]; }
        mu[k] = m1 / w; let v2 = 0; for (let t = 0; t < T; t++) v2 += gamma[t][k] * (x[t] - mu[k]) ** 2;
        sg[k] = Math.max(Math.sqrt(v2 / w), sd * 0.05);
      }
      const nll = c.reduce((a, b) => a + Math.log(b), 0);
      if (Math.abs(nll - ll) < 1e-7) { ll = nll; break; }
      ll = nll;
    }
    // order states by mean (0 = lowest)
    const ord = mu.map((m, k) => [m, k]).sort((a, b) => a[0] - b[0]).map((v) => v[1]);
    const re = (arr) => ord.map((k) => arr[k]);
    return {
      mu: re(mu), sigma: re(sg), A: ord.map((i) => ord.map((j) => A[i][j])), ll,
      filtered: alpha.map(re), // P(state_t | x_1..x_t): uses no future data given the parameters
      smoothed: gamma.map(re),
    };
  }

  /** Past standardized h-day returns × today's volatility (volatility clustering). */
  function volScaledForecast(gold, vol, i, h) {
    const p = gold.p, z = [];
    for (let j = 60; j + h <= i; j++) if (vol[j] > 0) z.push(Math.log(p[j + h] / p[j]) / vol[j]);
    if (z.length < 250 || !(vol[i] > 0)) return null;
    z.sort((a, b) => a - b);
    return { q: QS.map((q) => quantile(z, q) * vol[i]), up: z.filter((v) => v > 0).length / z.length };
  }

  /** Adopted range model: average of baseline and volatility-scaled quantiles, then the band is
   *  widened by λ so that past 80% bands really covered 80%. λ is estimated walk-forward from
   *  forecasts whose outcomes were known at the time. */
  function rangeModel(gold, horizons = [21, 63, 126, 252], o = {}) {
    const p = gold.p, n = p.length - 1, step = o.step || 21, start = o.start || 1500;
    const vol = rollVol(p, 60), out = {};
    const blend = (i, h) => {
      const a = volScaledForecast(gold, vol, i, h), b = baselineForecast(gold, i, h);
      return a && b ? { q: QS.map((_, k) => (a.q[k] + b.q[k]) / 2), up: (a.up + b.up) / 2, base: b } : null;
    };
    const lamFrom = (hist, i, h) => {
      const past = hist.filter((x) => x.i + h <= i);
      if (past.length < 24) return 1;
      const r = past.map((x) => Math.abs(x.y - x.med) / Math.max(1e-9, (x.hi - x.lo) / 2)).sort((a, b) => a - b);
      return Math.max(1, r[Math.floor(r.length * 0.8)]);
    };
    const widen = (f, lam) => { const med = f.q[2]; return f.q.map((v) => med + (v - med) * lam); };
    for (const h of horizons) {
      const hist = [], acc = { model: { pin: 0, c80: 0, c50: 0 }, base: { pin: 0, c80: 0, c50: 0 }, n: 0 };
      for (let i = start; i + h <= n; i += step) {
        const f = blend(i, h); if (!f) continue;
        const lam = lamFrom(hist, i, h), q = widen(f, lam), y = Math.log(p[i + h] / p[i]);
        for (const [key, qq] of [["model", q], ["base", f.base.q]]) {
          const a = acc[key];
          a.pin += QS.reduce((s2, qv, k) => s2 + pinball(qv, qq[k], y), 0) / QS.length;
          a.c80 += y >= qq[0] && y <= qq[4] ? 1 : 0; a.c50 += y >= qq[1] && y <= qq[3] ? 1 : 0;
        }
        acc.n++; hist.push({ i, y, med: f.q[2], lo: f.q[0], hi: f.q[4] });
      }
      for (const key of ["model", "base"]) for (const f of ["pin", "c80", "c50"]) acc[key][f] /= acc.n || 1;
      acc.skill = 1 - acc.model.pin / acc.base.pin;
      const f = blend(n, h), lam = lamFrom(hist, n, h);
      out[h] = { eval: acc, now: f ? { q: widen(f, lam), up: f.up, lam } : null };
    }
    return out;
  }

  // ------------------------------------------------------------ Phase 5: verdict, alerts
  /** One-line verdict from the two temperature zones (shared by the main board and the brief). */
  function verdict(tempShort, tempLong) {
    const a = ZONES.indexOf(zoneOf(tempShort)), b = ZONES.indexOf(zoneOf(tempLong));
    if (b >= 4) return { title: "장기적으로 비싼 구간", sub: "4년 평균보다 크게 올라 있습니다. 새로 살 때는 천천히 나눠 사세요.", tone: "--z3", plan: "defensive" };
    if (a <= 1 && b >= 1 && b <= 3) return { title: "상승 추세 속 큰 조정 구간", sub: "장기 흐름은 살아 있는데 최근 1년 흐름보다 많이 내려왔습니다.", tone: "--cyan", plan: "balanced" };
    if (a <= 1 && b === 0) return { title: "하락 추세 — 서두르지 마세요", sub: "단기·장기 모두 평균 아래입니다. 과거엔 이럴 때 추가 하락이 잦았습니다.", tone: "--z4", plan: "defensive" };
    if (a >= 3 && b >= 3) return { title: "과열에 가까운 구간", sub: "단기·장기 모두 평균보다 높습니다. 신규 매수는 속도를 줄이세요.", tone: "--z3", plan: "defensive" };
    return { title: "평범한 가격대", sub: "특별히 싸지도 비싸지도 않습니다. 계획대로 나눠 사면 됩니다.", tone: "--primary", plan: "balanced" };
  }

  /** Rule-based alerts for the latest day. Levels: "critical" > "warn" > "info".
   *  Every rule reads only data up to the latest observation. */
  function alerts(gold, o = {}) {
    const { p, t } = gold, n = p.length - 1, out = [];
    const day = (d) => new Date(d * 864e5).toISOString().slice(0, 10);
    const s50 = sma(p, 50), s200 = sma(p, 200), s1000 = sma(p, 1000);
    // domestic premium
    if (o.premium != null && isFinite(o.premium)) {
      const pr = o.premium;
      if (pr > 5) out.push({ id: "premium", level: "critical", title: "국내 금이 국제가보다 크게 비쌈", detail: `KRX 괴리율 +${pr.toFixed(2)}% (기준 5% 초과). 국내 매입은 보류하고 매도 쪽이 유리할 수 있습니다.` });
      else if (pr > 2) out.push({ id: "premium", level: "warn", title: "국내 프리미엄 주의", detail: `KRX 괴리율 +${pr.toFixed(2)}% (정상 ±2%, 최근 3년 평균 ${o.premiumMean != null ? (o.premiumMean >= 0 ? "+" : "") + o.premiumMean.toFixed(2) + "%" : "—"}).` });
      else if (pr < -2) out.push({ id: "premium", level: "info", title: "국내 금이 국제가보다 저렴", detail: `KRX 괴리율 ${pr.toFixed(2)}%. 국내 매입에 유리한 가격입니다.` });
    }
    // long-term line
    if (isFinite(s1000[n])) {
      const dv = (p[n] / s1000[n] - 1) * 100;
      if (dv < 0) out.push({ id: "long", level: "critical", title: "4년 평균선 아래로 하락", detail: `가격이 4년 평균선 $${Math.round(s1000[n]).toLocaleString()}보다 ${dv.toFixed(1)}% 낮습니다. 과거엔 이후 1년 성과가 크게 나빴습니다.` });
      else if (dv < 5) out.push({ id: "long", level: "warn", title: "4년 평균선 근접", detail: `4년 평균선까지 ${dv.toFixed(1)}% 남았습니다 ($${Math.round(s1000[n]).toLocaleString()}).` });
    }
    // 50/200 cross within the last 10 trading days
    for (let k = n; k > n - 10 && k > 0; k--) {
      const now = s50[k] > s200[k], before = s50[k - 1] > s200[k - 1];
      if (isFinite(s200[k - 1]) && now !== before) { out.push({ id: "cross", level: "warn", title: now ? "상승 추세 전환 (골든크로스)" : "하락 추세 전환 (데드크로스)", detail: `${day(t[k])}에 50일선이 200일선을 ${now ? "위로" : "아래로"} 지났습니다.` }); break; }
    }
    // big daily move vs 60-day volatility
    const vol = rollVol(p, 60)[n - 1], r = p[n] / p[n - 1] - 1, sd = vol / Math.sqrt(TD);
    if (isFinite(sd) && sd > 0 && Math.abs(r) > 2 * sd) out.push({ id: "move", level: "warn", title: r > 0 ? "급등" : "급락", detail: `하루 ${(r >= 0 ? "+" : "") + (r * 100).toFixed(2)}% (최근 60일 기준 ${Math.abs(r / sd).toFixed(1)}σ).` });
    // 52-week extremes
    const w = p.slice(Math.max(0, n - 251), n);
    if (w.length > 200 && p[n] > Math.max(...w)) out.push({ id: "high", level: "info", title: "52주 신고가", detail: `$${Math.round(p[n]).toLocaleString()}로 최근 1년 최고가를 넘었습니다.` });
    if (w.length > 200 && p[n] < Math.min(...w)) out.push({ id: "low", level: "warn", title: "52주 신저가", detail: `$${Math.round(p[n]).toLocaleString()}로 최근 1년 최저가 아래입니다.` });
    // temperature zone change in the last 5 trading days
    if (o.tempShort) {
      const z0 = zoneOf(o.tempShort[n - 5]), z1 = zoneOf(o.tempShort[n]);
      if (isFinite(o.tempShort[n - 5]) && z0 !== z1) out.push({ id: "zone", level: "info", title: "가격 구간 변화", detail: `최근 1년 흐름 기준 "${z0[2]}" → "${z1[2]}"` });
    }
    const rank = { critical: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  /** Weekly log returns (every 5th trading day) with their dates. */
  function weekly(gold) {
    const t = [], r = [];
    for (let i = 5; i < gold.p.length; i += 5) { t.push(gold.t[i]); r.push(Math.log(gold.p[i] / gold.p[i - 5])); }
    return { t, r };
  }

  return { verdict, alerts, volScaledForecast, rangeModel, expandingPct, features, QS, quantile, analogForecast, baselineForecast, evaluateForecast, SCORE_BINS, signalValidation, hmmFit, weekly, temperature, priceAtTemp, ZONES, zoneOf, forwardStats, PLANS, planWeights, planCost, planStats,
    sma, rsi, rollVol, alignSeries, lagByDays, FACTOR_RULES, AUTO_MAX, factorValues, signalHistory, STRATEGIES, targets, backtest, drawdown, metrics, rolling, yearly, grid, walkForward, seasonality, rollingCorr, monthEnds, GRID_FAST, GRID_SLOW };
});
