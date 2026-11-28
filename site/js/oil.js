/* Oil Miner — oil-specific analysis on top of the shared engine (site/js/engine.js).
 * Pure functions, no DOM. Browser: window.OilEngine (needs window.GMEngine). Node: require("./oil.js").
 *
 * No look-ahead: weekly EIA inventories are used 5 days after the week-ending date (published the
 * next Wednesday), CFTC positions 3 days after the report date (published Friday), daily FRED/market
 * data from the next day.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./engine.js"));
  else root.OilEngine = factory(root.GMEngine);
})(typeof self !== "undefined" ? self : this, function (E) {
  "use strict";
  const TD = 252, BARREL_L = 158.987;
  const LAGS = { inventory: 5, cot: 3, daily: 1 };

  const toSeries = (hist) => ({ t: hist.map((x) => x[0]), p: hist.map((x) => x[1]) });

  // ------------------------------------------------------------ prices & units
  /** USD/bbl → KRW per litre at a given USD/KRW rate. */
  const wonPerLitre = (usd, fx) => (usd * fx) / BARREL_L;

  /** Real price in today's dollars using monthly CPI [["YYYY-MM", cpi], ...] (latest CPI = 1×). */
  function realPrices(g, cpi) {
    const map = new Map(cpi.map(([m, v]) => [m, v])), lastM = cpi[cpi.length - 1][0], last = cpi[cpi.length - 1][1];
    let cur = cpi[0][1];
    return g.t.map((d, i) => {
      const m = new Date(d * 864e5).toISOString().slice(0, 7);
      if (m >= lastM) cur = last; // months after the latest CPI use the latest value
      else if (map.has(m)) cur = map.get(m); // a missing month keeps the previous value
      return (g.p[i] * last) / cur;
    });
  }

  /** Futures-curve state from the annualised front-to-second-month roll (% per year). */
  function curveState(rollAnn) {
    if (!isFinite(rollAnn)) return { key: "na", label: "데이터 없음", plain: "", tone: "--muted" };
    if (rollAnn >= 3) return { key: "back", label: "백워데이션", plain: "가까운 달 원유가 더 비쌉니다. 시장이 지금 당장 원유를 원한다는 뜻이고, 선물을 갈아탈(롤오버) 때 이익이 생깁니다.", tone: "--cyan" };
    if (rollAnn <= -3) return { key: "contango", label: "콘탱고", plain: "먼 달 원유가 더 비쌉니다. 지금 원유가 남는다는 뜻이고, 선물 ETF는 갈아탈 때마다 비용을 냅니다.", tone: "--z3" };
    return { key: "flat", label: "평탄", plain: "가까운 달과 먼 달 가격이 비슷합니다. 롤오버 손익이 작습니다.", tone: "--muted" };
  }

  /** Inventory label from deviation vs the 5-year average (%). */
  function inventoryState(dev) {
    if (!isFinite(dev)) return { label: "데이터 없음", tone: "--muted" };
    if (dev <= -5) return { label: "재고 부족 (수급 빡빡)", tone: "--cyan" };
    if (dev < -1.5) return { label: "평균보다 조금 적음", tone: "--z1" };
    if (dev <= 1.5) return { label: "평년 수준", tone: "--muted" };
    if (dev < 5) return { label: "평균보다 조금 많음", tone: "--z3" };
    return { label: "재고 과잉 (수급 느슨)", tone: "--z4" };
  }

  // ------------------------------------------------------------ factors & validation
  /** Spearman rank correlation of paired finite values. */
  function spearman(a, b) {
    const idx = a.map((_, i) => i).filter((i) => isFinite(a[i]) && isFinite(b[i]));
    const n = idx.length; if (n < 30) return NaN;
    const rank = (v) => { const o = idx.map((i) => [v[i], i]).sort((x, y) => x[0] - y[0]); const r = new Map(); o.forEach(([, i], k) => r.set(i, k)); return r; };
    const ra = rank(a), rb = rank(b); let s = 0;
    for (const i of idx) s += (ra.get(i) - rb.get(i)) ** 2;
    return 1 - (6 * s) / (n * (n * n - 1));
  }

  /** Daily factor values at oil dates. D = OM_DATA bundle. Each factor: {id, n, desc, sign, v[]}. */
  function factorHistory(g, D) {
    const t = g.t, p = g.p;
    const S = E.temperature(g, 200), L = E.temperature(g, 1250);
    const s50 = E.sma(p, 50), s200 = S.sma;
    const out = [
      { id: "tempS", n: "가격 온도 (1년 흐름)", desc: "200일 평균 대비 위치의 백분위", v: S.temp },
      { id: "tempL", n: "가격 온도 (5년 흐름)", desc: "1,250일 평균 대비 위치의 백분위", v: L.temp },
      { id: "trend", n: "추세 (50/200일선 차이)", desc: "50일선 ÷ 200일선 − 1", v: s50.map((v, i) => (v / s200[i] - 1) * 100) },
    ];
    const inv = D.inventory && D.inventory.crude && D.inventory.crude.devhist;
    if (inv) out.push({ id: "inv", n: "원유 재고 (5년 평균 대비)", desc: "EIA 상업재고, 발표 지연 5일 반영", v: E.alignSeries(t, inv, LAGS.inventory) });
    if (D.realized_roll) out.push({ id: "roll", n: "실현 롤 수익 (USO − 현물, 1년)", desc: "기간구조 대리 지표 · 양수 = 백워데이션", v: E.alignSeries(t, D.realized_roll.hist, LAGS.daily) });
    if (D.crack) out.push({ id: "crack", n: "정제 마진 (3-2-1 크랙)", desc: "USD/배럴, 높을수록 정제 수요 강함", v: E.alignSeries(t, D.crack.hist, LAGS.daily) });
    if (D.cot) out.push({ id: "cot", n: "투기적 순매수 (% 미결제약정)", desc: "CFTC 비상업 순포지션, 발표 지연 3일", v: E.alignSeries(t, D.cot.hist, LAGS.cot) });
    if (D.dollar) {
      const usd = E.alignSeries(t, D.dollar.hist, LAGS.daily), u91 = E.lagByDays(t, usd, 91);
      out.push({ id: "usd", n: "달러 3개월 변화", desc: "FRED 달러 인덱스 (Broad)", v: usd.map((v, i) => (v / u91[i] - 1) * 100) });
    }
    return out;
  }

  /** IC and quintile table for each factor vs forward log returns.
   *  Sampled every `step` trading days to reduce overlap; quintile edges use the full sample
   *  (descriptive), the IC is rank-based so edges do not matter for it. */
  function factorValidation(g, factors, horizons = [21, 63, 126], o = {}) {
    const step = o.step || 5, from = o.fromDay || 0, p = g.p, n = p.length;
    return factors.map((f) => {
      const idx = [];
      for (let i = 0; i < n; i += step) if (g.t[i] >= from && isFinite(f.v[i])) idx.push(i);
      const ic = {}, bins = [];
      for (const h of horizons) {
        const xs = [], ys = [];
        for (const i of idx) if (i + h < n) { xs.push(f.v[i]); ys.push(Math.log(p[i + h] / p[i])); }
        ic[h] = spearman(xs, ys);
      }
      const h = o.binH || 63, vals = idx.filter((i) => i + h < n).map((i) => f.v[i]).sort((a, b) => a - b);
      if (vals.length >= 100) {
        const edges = [0.2, 0.4, 0.6, 0.8].map((q) => vals[Math.floor(q * vals.length)]);
        for (let k = 0; k < 5; k++) {
          const lo = k ? edges[k - 1] : -Infinity, hi = k < 4 ? edges[k] : Infinity;
          const r = idx.filter((i) => i + h < n && f.v[i] >= lo && f.v[i] < hi).map((i) => p[i + h] / p[i] - 1);
          bins.push({ k, lo, hi, n: r.length, mean: r.reduce((a, b) => a + b, 0) / (r.length || 1), up: r.filter((x) => x > 0).length / (r.length || 1) });
        }
      }
      const now = f.v[n - 1], nowBin = bins.findIndex((b) => now >= b.lo && now < b.hi);
      const first = idx.length ? g.t[idx[0]] : null;
      return { id: f.id, n: f.n, desc: f.desc, ic, bins, now, nowBin, samples: idx.length, from: first, verdict: icVerdict(ic[63]) };
    });
  }
  const icVerdict = (v) => (!isFinite(v) ? "표본 부족" : Math.abs(v) < 0.05 ? "예측력 없음" : Math.abs(v) < 0.1 ? "약함" : "있음 (과대평가 가능)");

  // ------------------------------------------------------------ product comparison
  /** Value of `hist` [[day, v]] on or before `day` (binary search). */
  function at(hist, day) {
    let lo = 0, hi = hist.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (hist[m][0] <= day) { r = m; lo = m + 1; } else hi = m - 1; }
    return r >= 0 ? hist[r][1] : NaN;
  }

  /** Growth of 1 from `fromDay` to the latest common date for each product, in won where noted.
   *  Decomposition (won terms, additive in return points):
   *    환율 효과        = spot in won − spot in USD
   *    롤·운용비용      = USO (USD) − spot (USD)
   *    환헤지·국내 운용 = KODEX(H) − USO (USD) */
  function compareProducts(D, fromDay) {
    const fx = D.fx.hist, wti = D.wti.hist, E_ = D.etf || {};
    const ends = [wti.at(-1)[0], fx.at(-1)[0], ...["USO", "KODEX_WTI"].filter((k) => E_[k]).map((k) => E_[k].hist.at(-1)[0])];
    const end = Math.min(...ends);
    const starts = [wti[0][0], ...["USO", "KODEX_WTI"].filter((k) => E_[k]).map((k) => E_[k].hist[0][0])];
    const start = Math.max(fromDay, ...starts);
    const r = (h, a = start, b = end) => at(h, b) / at(h, a) - 1;
    const fxr = at(fx, end) / at(fx, start);
    const spot = r(wti), spotKrw = (1 + spot) * fxr - 1;
    const rows = [
      { id: "spot", n: "WTI 현물 (달러 기준)", cur: "USD", ret: spot, invest: false, note: "직접 살 수 없는 기준 가격" },
      { id: "spotKrw", n: "WTI 현물 (원화 환산)", cur: "KRW", ret: spotKrw, invest: false, note: "환율 변화까지 포함" },
    ];
    if (E_.USO) rows.push({ id: "uso", n: "USO (미국 상장)", cur: "USD", ret: r(E_.USO.hist), invest: true, note: "근월물 선물 · 보수 연 0.6% 내외" }, { id: "usoKrw", n: "USO (원화 환산)", cur: "KRW", ret: (1 + r(E_.USO.hist)) * fxr - 1, invest: true, note: "해외주식 계좌 · 환율 노출" });
    if (E_.KODEX_WTI) rows.push({ id: "kodex", n: D.etf_names.KODEX_WTI, cur: "KRW", ret: r(E_.KODEX_WTI.hist), invest: true, note: "국내 상장 · 환헤지(H)" });
    if (E_.TIGER_OIL && E_.TIGER_OIL.hist[0][0] <= start) rows.push({ id: "tiger", n: D.etf_names.TIGER_OIL, cur: "KRW", ret: r(E_.TIGER_OIL.hist), invest: true, note: "국내 상장 · 환헤지(H) · 여러 월물 분산" });
    const get = (id) => (rows.find((x) => x.id === id) || {}).ret;
    const parts = {
      fx: spotKrw - spot,
      roll: get("uso") != null ? get("uso") - spot : NaN,
      hedge: get("kodex") != null && get("uso") != null ? get("kodex") - get("uso") : NaN,
    };
    return { start, end, years: (end - start) / 365.25, rows, parts };
  }

  /** k× daily-rebalanced product vs simply k × the underlying move, between indices i0..i1 of {t,p}. */
  function leverage(s, i0, i1, k = 2, feeAnn = 0.0068) {
    let v = 1, inv = 1;
    for (let i = i0 + 1; i <= i1; i++) {
      const r = s.p[i] / s.p[i - 1] - 1, dt = (s.t[i] - s.t[i - 1]) / 365;
      v *= Math.max(0, 1 + k * r) * Math.pow(1 - feeAnn, dt);
      inv *= Math.max(0, 1 - r) * Math.pow(1 - feeAnn, dt);
    }
    const under = s.p[i1] / s.p[i0] - 1;
    return { under, naive: k * under, actual: v - 1, inverse: inv - 1, naiveInv: -under, drag: v - 1 - k * under };
  }

  // ------------------------------------------------------------ verdict & alerts
  /** One-line verdict from the two temperatures plus the supply picture. */
  function verdict(tempS, tempL, invDev, rollAnn) {
    const a = E.ZONES.indexOf(E.zoneOf(tempS)), b = E.ZONES.indexOf(E.zoneOf(tempL));
    const tight = isFinite(invDev) && invDev < -1.5, loose = isFinite(invDev) && invDev > 1.5;
    const back = isFinite(rollAnn) && rollAnn >= 3, cont = isFinite(rollAnn) && rollAnn <= -3;
    const supply = tight && back ? "수급 빡빡" : loose && cont ? "수급 느슨" : tight || back ? "수급 다소 빡빡" : loose || cont ? "수급 다소 느슨" : "수급 보통";
    if (a >= 4 && b >= 3) return { title: `급등 후 과열 구간 · ${supply}`, sub: "단기·장기 모두 평균보다 크게 올라 있습니다. 유가는 급등 뒤 되돌림이 잦았습니다. 신규 매수는 아주 천천히.", tone: "--z4", plan: "defensive" };
    if (a >= 3 && b >= 3) return { title: `비싼 구간 · ${supply}`, sub: "단기·장기 평균보다 높습니다. 새로 산다면 나눠서, 비중은 작게.", tone: "--z3", plan: "defensive" };
    if (a <= 1 && b <= 1) return { title: `싼 구간 · ${supply}`, sub: "단기·장기 모두 평균보다 낮습니다. 다만 유가는 싸 보여도 더 떨어진 적이 많았습니다(2014~16, 2020).", tone: "--z1", plan: "defensive" };
    if (a <= 1) return { title: `단기 조정 구간 · ${supply}`, sub: "최근 1년 흐름보다 많이 내려왔지만 장기 평균선 근처입니다.", tone: "--cyan", plan: "balanced" };
    return { title: `보통 가격대 · ${supply}`, sub: "특별히 싸지도 비싸지도 않습니다. 수급과 추세를 함께 보며 나눠 사세요.", tone: "--primary", plan: "balanced" };
  }

  /** Rule-based alerts for the latest day. Levels: critical > warn > info. */
  function alerts(g, D, o = {}) {
    const { p, t } = g, n = p.length - 1, out = [];
    const day = (d) => new Date(d * 864e5).toISOString().slice(0, 10);
    // big daily move vs 60-day volatility
    const vol = E.rollVol(p, 60)[n - 1], r = p[n] / p[n - 1] - 1, sd = vol / Math.sqrt(TD);
    if (isFinite(sd) && sd > 0 && Math.abs(r) > 2 * sd) out.push({ id: "move", level: Math.abs(r) > 3 * sd ? "critical" : "warn", title: r > 0 ? "유가 급등" : "유가 급락", detail: `하루 ${(r >= 0 ? "+" : "") + (r * 100).toFixed(2)}% (최근 60일 기준 ${Math.abs(r / sd).toFixed(1)}σ).` });
    // 52-week extremes
    const w = p.slice(Math.max(0, n - 251), n);
    if (w.length > 200 && p[n] > Math.max(...w)) out.push({ id: "high", level: "info", title: "52주 신고가", detail: `$${p[n].toFixed(2)}로 최근 1년 최고가를 넘었습니다.` });
    if (w.length > 200 && p[n] < Math.min(...w)) out.push({ id: "low", level: "warn", title: "52주 신저가", detail: `$${p[n].toFixed(2)}로 최근 1년 최저가 아래입니다.` });
    // 50/200 cross in the last 10 trading days
    const s50 = E.sma(p, 50), s200 = E.sma(p, 200);
    for (let k = n; k > n - 10 && k > 0; k--) {
      const now = s50[k] > s200[k], before = s50[k - 1] > s200[k - 1];
      if (isFinite(s200[k - 1]) && now !== before) { out.push({ id: "cross", level: "warn", title: now ? "상승 추세 전환 (골든크로스)" : "하락 추세 전환 (데드크로스)", detail: `${day(t[k])}에 50일선이 200일선을 ${now ? "위로" : "아래로"} 지났습니다.` }); break; }
    }
    // curve state change vs the previous stored snapshot
    const ch = D.curve && D.curve.hist;
    if (ch && ch.length >= 2) {
      const st = (row) => curveState((row[1] / row[2] - 1) * 1200).key, a = st(ch.at(-2)), b = st(ch.at(-1));
      if (a !== b && a !== "na" && b !== "na") out.push({ id: "curve", level: "warn", title: "기간구조 전환", detail: `${curveState(a === "back" ? 9 : a === "contango" ? -9 : 0).label} → ${curveState(b === "back" ? 9 : b === "contango" ? -9 : 0).label} (${day(ch.at(-1)[0])})` });
    }
    // inventories outside the 5-year range
    const inv = D.inventory && D.inventory.crude;
    if (inv && isFinite(inv.min5)) {
      if (inv.last < inv.min5) out.push({ id: "invlow", level: "warn", title: "원유 재고 5년 최저 범위 아래", detail: `${(inv.last / 1000).toFixed(1)}백만 배럴 · 같은 주 5년 최저 ${(inv.min5 / 1000).toFixed(1)}백만 배럴 (${inv.date})` });
      if (inv.last > inv.max5) out.push({ id: "invhigh", level: "warn", title: "원유 재고 5년 최고 범위 위", detail: `${(inv.last / 1000).toFixed(1)}백만 배럴 · 같은 주 5년 최고 ${(inv.max5 / 1000).toFixed(1)}백만 배럴 (${inv.date})` });
    }
    // ETF tracking gap over 3 months
    const uso = D.etf && D.etf.USO;
    if (uso) {
      const e = uso.hist.at(-1)[0], s = e - 91, gu = at(uso.hist, e) / at(uso.hist, s) - 1, gs = at(D.wti.hist, e) / at(D.wti.hist, s) - 1;
      if (isFinite(gu - gs) && Math.abs(gu - gs) > 0.08) out.push({ id: "track", level: "info", title: gu < gs ? "ETF가 현물보다 크게 뒤처짐" : "ETF가 현물보다 크게 앞섬", detail: `최근 3개월 USO ${(gu * 100).toFixed(1)}% vs WTI 현물 ${(gs * 100).toFixed(1)}% — 차이는 대부분 롤오버 손익입니다.` });
    }
    // temperature zone change in the last 5 trading days
    if (o.tempShort) {
      const z0 = E.zoneOf(o.tempShort[n - 5]), z1 = E.zoneOf(o.tempShort[n]);
      if (isFinite(o.tempShort[n - 5]) && z0 !== z1) out.push({ id: "zone", level: "info", title: "가격 구간 변화", detail: `최근 1년 흐름 기준 "${z0[2]}" → "${z1[2]}"` });
    }
    const rank = { critical: 0, warn: 1, info: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  /** Target weights that hold only while cond(i) is true (for filter strategies in the backtest lab). */
  const filterTargets = (n, cond) => Array.from({ length: n }, (_, i) => (cond(i) ? 1 : 0));

  return { TD, BARREL_L, LAGS, toSeries, wonPerLitre, realPrices, curveState, inventoryState, spearman, factorHistory, factorValidation, icVerdict, at, compareProducts, leverage, verdict, alerts, filterTargets };
});
