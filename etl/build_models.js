// Phase 4 batch models → site/data/gm_models.js (window.GM_MODELS)
// Run after the ETL:  node etl/build_models.js
const fs = require("fs");
const path = require("path");
const E = require("../site/js/engine.js");

const ROOT = path.join(__dirname, "..");
const txt = fs.readFileSync(path.join(ROOT, "site/data/gm_data.js"), "utf8");
const D = JSON.parse(txt.slice(txt.indexOf("=") + 1, txt.lastIndexOf(";")));
const g = { t: D.gold.hist.map((x) => x[0]), p: D.gold.hist.map((x) => x[1]) };
const macro = { DFII10: D.macro.DFII10 && D.macro.DFII10.hist, DTWEXBGS: D.macro.DTWEXBGS && D.macro.DTWEXBGS.hist, T10YIE: D.macro.T10YIE && D.macro.T10YIE.hist };
const H = [21, 63, 126, 252];
const r4 = (v) => (isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
const t0 = Date.now();

// 1) signal validation
const score = E.signalHistory(g, macro);
const sv = E.signalValidation(g, score, [21, 63, 126]);

// 2) adopted range model + rejected analog model (for transparency)
const rm = E.rangeModel(g, H);
const F = E.features(g);
const analog = {};
for (const h of H) {
  const ev = E.evaluateForecast(g, F, h, { start: 1500, step: 21, k: 120 });
  analog[h] = { skill: r4(ev.skill), c80: r4(ev.model.c80), n: ev.n };
}

// 3) regimes: 3-state Gaussian HMM on weekly log returns
const w = E.weekly(g);
const hm = E.hmmFit(w.r, 3, 120);
const names = ["급락 국면", "안정 국면", "고변동 국면"];
const states = hm.mu.map((m, k) => ({
  name: names[k], muAnn: r4(m * 52), sigAnn: r4(hm.sigma[k] * Math.sqrt(52)),
  stayWeeks: Math.round(1 / Math.max(1e-6, 1 - hm.A[k][k])),
  share: r4(hm.filtered.filter((p) => p.indexOf(Math.max(...p)) === k).length / hm.filtered.length),
}));
const ribbon = w.t.map((d, i) => [d, hm.filtered[i].indexOf(Math.max(...hm.filtered[i]))]);

// 4) alerts + daily brief (Phase 5). Numbers only from the data; no speculation.
const n = g.p.length - 1, P = g.p[n];
const S = E.temperature(g, 200), L = E.temperature(g, 1000);
const s50 = E.sma(g.p, 50), s200 = S.sma;
const dom = D.domestic, prem = dom && dom.premium;
const FX = D.macro.DEXKOUS ? D.macro.DEXKOUS.last : NaN;
const wonDon = (usd) => (usd * FX / 31.1035) * 3.75;
const fmt = (v, d = 0) => (isFinite(v) ? v.toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—");
const sg = (v, d = 1) => (isFinite(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d) : "—");
const al = E.alerts(g, { premium: prem ? prem.last : null, premiumMean: prem ? prem.mean_3y : null, tempShort: S.temp });
const v = E.verdict(S.temp[n], L.temp[n]);
const zs = E.zoneOf(S.temp[n]), zl = E.zoneOf(L.temp[n]);
let crossDay = null; for (let k = n; k > 200; k--) if ((s50[k] > s200[k]) !== (s50[k - 1] > s200[k - 1])) { crossDay = new Date(g.t[k] * 864e5).toISOString().slice(0, 10); break; }
const golden = s50[n] > s200[n];
const r1 = (P / g.p[n - 1] - 1) * 100;
const q12 = rm[252].now.q.map((x) => P * Math.exp(x));
const regime = states[hm.filtered.at(-1).indexOf(Math.max(...hm.filtered.at(-1)))];
const M = D.macro;
const bullets = [
  { k: "가격", t: `국제 금 $${fmt(P, 1)} (${sg(r1, 2)}%), 국제가 환산 ${fmt(wonDon(P))}원/돈` + (dom ? ` · KRX ${fmt(dom.last)}원/g (${sg(dom.chg_1d, 2)}%)` : "") },
  prem ? { k: "국내 프리미엄", t: `KRX 괴리율 ${sg(prem.last, 2)}% (최근 3년 평균 ${sg(prem.mean_3y, 2)}%, ${prem.date} 기준)` } : null,
  { k: "가격 위치", t: `최근 1년 흐름 기준 "${zs[2]}"(200일선 대비 ${sg(S.dev[n] * 100)}%) · 장기 4년 흐름 기준 "${zl[2]}"(${sg(L.dev[n] * 100)}%)` },
  { k: "추세", t: `${golden ? "상승 추세" : "하락 추세"} (50일선 $${fmt(s50[n])} ${golden ? ">" : "<"} 200일선 $${fmt(s200[n])})` + (crossDay ? `, ${crossDay} 이후 지속` : "") },
  { k: "거시", t: `10년 실질금리 ${M.DFII10 ? M.DFII10.last.toFixed(2) + "% (1개월 " + sg(M.DFII10.chg_1m * 100, 0) + "bp)" : "—"} · 달러 인덱스 ${M.DTWEXBGS ? M.DTWEXBGS.last.toFixed(1) + " (" + sg(M.DTWEXBGS.chg_1m / M.DTWEXBGS.last * 100) + "%)" : "—"} · 원/달러 ${fmt(FX, 1)}` },
  { k: "시장 국면", t: `${regime.name} 확률 ${Math.round(Math.max(...hm.filtered.at(-1)) * 100)}% (연 변동성 ${Math.round(regime.sigAnn * 100)}% 수준의 국면)` },
  { k: "1년 범위", t: `10번 중 8번은 $${fmt(q12[0])} ~ $${fmt(q12[4])} (${fmt(wonDon(q12[0]) / 1e4, 1)}만 ~ ${fmt(wonDon(q12[4]) / 1e4, 1)}만원/돈), 과거 검증 적중률 ${Math.round(rm[252].eval.model.c80 * 100)}%` },
].filter(Boolean);
const brief = { date: D.gold.date, headline: v.title, sub: v.sub, plan: v.plan, bullets, alertCount: al.length };
const md = [`# 금 시장 일간 브리핑 · ${brief.date}`, "", `**지금은: ${v.title}** — ${v.sub}`, "", ...bullets.map((b) => `- **${b.k}**: ${b.t}`), "",
  `## 알림 ${al.length}건`, ...(al.length ? al.map((a) => `- [${a.level === "critical" ? "경고" : a.level === "warn" ? "주의" : "정보"}] **${a.title}** — ${a.detail}`) : ["- 없음"]), "",
  "_정보 제공 목적이며 투자 권유가 아닙니다. 모든 수치는 Gold Miner 데이터 파이프라인에서 계산했습니다._", ""].join("\n");
fs.writeFileSync(path.join(ROOT, "site/data/brief.md"), md);

const out = {
  generated_at: new Date().toISOString().slice(0, 19) + "Z",
  asof: D.gold.date,
  signal: { ic: Object.fromEntries(Object.entries(sv.ic).map(([k, v]) => [k, r4(v)])), bins: sv.bins.map((b) => ({ label: b.label, n: b.n, ...Object.fromEntries([21, 63, 126].map((h) => [h, { mean: r4(b[h].mean), up: r4(b[h].up), n: b[h].n }])) })) },
  range: Object.fromEntries(H.map((h) => [h, {
    eval: { n: rm[h].eval.n, skill: r4(rm[h].eval.skill), model: { c80: r4(rm[h].eval.model.c80), c50: r4(rm[h].eval.model.c50) }, base: { c80: r4(rm[h].eval.base.c80), c50: r4(rm[h].eval.base.c50) } },
    now: { q: rm[h].now.q.map(r4), up: r4(rm[h].now.up), lam: r4(rm[h].now.lam) },
  }])),
  analog,
  alerts: al,
  brief,
  hmm: { states, A: hm.A.map((r) => r.map(r4)), now: hm.filtered.at(-1).map(r4), nowDate: w.t.at(-1), ribbon },
};
const dest = path.join(ROOT, "site/data/gm_models.js");
fs.writeFileSync(dest, "/* generated by etl/build_models.js — do not edit */\nwindow.GM_MODELS=" + JSON.stringify(out) + ";\n");
console.log(`wrote site/data/gm_models.js (${Math.round(fs.statSync(dest).size / 1024)} KB) in ${Date.now() - t0}ms`);
console.log(md);
console.log("signal IC", out.signal.ic, "| range c80", H.map((h) => out.range[h].eval.model.c80), "| hmm now", out.hmm.now);
