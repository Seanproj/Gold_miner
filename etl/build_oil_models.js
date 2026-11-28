// Oil models → site/data/om_models.js (window.OM_MODELS) and site/data/oil_brief.md
// Run after the oil ETL:  node etl/build_oil_models.js
const fs = require("fs");
const path = require("path");
const E = require("../site/js/engine.js");
const O = require("../site/js/oil.js");

const ROOT = path.join(__dirname, "..");
const txt = fs.readFileSync(path.join(ROOT, "site/data/om_data.js"), "utf8");
const D = JSON.parse(txt.slice(txt.indexOf("=") + 1, txt.lastIndexOf(";")));
const g = O.toSeries(D.wti.hist);
const H = [21, 63, 126, 252];
const r4 = (v) => (isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
const t0 = Date.now();
const n = g.p.length - 1, P = g.p[n];
const day = (d) => new Date(d * 864e5).toISOString().slice(0, 10);

// 1) factor validation (each factor over its own available history)
const factors = O.factorHistory(g, D);
const fv = O.factorValidation(g, factors, [21, 63, 126], { step: 5, binH: 63 });

// 2) calibrated range model (same model as the gold pages) + check on the investable fund
const rm = E.rangeModel(g, H, { start: 1500 });

// 3) regimes: 3-state Gaussian HMM on weekly log returns
// weekly returns are clipped at ±25% for the fit: the April 2020 negative-price week (−70% after
// dropping the negative day) would otherwise get a state of its own
const w = E.weekly(g);
const CLIP = 0.25, clipped = w.r.map((x) => Math.max(-CLIP, Math.min(CLIP, x)));
const hm = E.hmmFit(clipped, 3, 120);
// name states by what they look like: lowest mean = 하락, of the rest lower volatility = 안정
const lowMu = hm.mu.indexOf(Math.min(...hm.mu));
const rest = [0, 1, 2].filter((k) => k !== lowMu).sort((a, b) => hm.sigma[a] - hm.sigma[b]);
const names = []; names[lowMu] = "하락 국면"; names[rest[0]] = "안정 국면"; names[rest[1]] = "고변동 국면";
const states = hm.mu.map((m, k) => ({
  name: names[k], muAnn: r4(m * 52), sigAnn: r4(hm.sigma[k] * Math.sqrt(52)),
  stayWeeks: Math.round(1 / Math.max(1e-6, 1 - hm.A[k][k])),
  share: r4(hm.filtered.filter((p) => p.indexOf(Math.max(...p)) === k).length / hm.filtered.length),
}));
const ribbon = w.t.map((d, i) => [d, hm.filtered[i].indexOf(Math.max(...hm.filtered[i]))]).filter((x) => x[0] >= g.t[n] - 365 * 16);

// 4) verdict, alerts, brief — numbers only from the data
const S = E.temperature(g, 200), L = E.temperature(g, 1250);
const s50 = E.sma(g.p, 50), s200 = S.sma, s1250 = L.sma;
const inv = D.inventory && D.inventory.crude, curve = D.curve;
const v = O.verdict(S.temp[n], L.temp[n], inv && inv.dev, curve && curve.roll_ann);
const al = O.alerts(g, D, { tempShort: S.temp });
const FX = D.fx ? D.fx.last : NaN;
const fmt = (x, d = 0) => (isFinite(x) ? x.toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—");
const sg = (x, d = 1) => (isFinite(x) ? (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d) : "—");
const zs = E.zoneOf(S.temp[n]), zl = E.zoneOf(L.temp[n]);
const golden = s50[n] > s200[n];
let crossDay = null; for (let k = n; k > 200; k--) if ((s50[k] > s200[k]) !== (s50[k - 1] > s200[k - 1])) { crossDay = day(g.t[k]); break; }
const q12 = rm[252].now.q.map((x) => P * Math.exp(x));
const regime = states[hm.filtered.at(-1).indexOf(Math.max(...hm.filtered.at(-1)))];
const cs = O.curveState(curve && curve.roll_ann);
const r1 = (P / g.p[n - 1] - 1) * 100;
const bullets = [
  { k: "가격", t: `WTI $${fmt(P, 2)} (${sg(r1, 2)}%)` + (D.brent ? ` · Brent $${fmt(D.brent.last, 2)} · 스프레드 $${fmt(D.brent.last - P, 2)}` : "") + ` · 원화 환산 ${fmt(O.wonPerLitre(P, FX))}원/리터` },
  { k: "가격 위치", t: `최근 1년 흐름 기준 "${zs[2]}"(200일선 대비 ${sg(S.dev[n] * 100)}%) · 장기 5년 흐름 기준 "${zl[2]}"(${sg(L.dev[n] * 100)}%)` },
  { k: "추세", t: `${golden ? "상승 추세" : "하락 추세"} (50일선 $${fmt(s50[n], 1)} ${golden ? ">" : "<"} 200일선 $${fmt(s200[n], 1)})` + (crossDay ? `, ${crossDay} 이후 지속` : "") },
  inv ? { k: "재고", t: `미국 원유 상업재고 ${fmt(inv.last / 1000, 1)}백만 배럴 (주간 ${sg(inv.chg_w / 1000, 1)}백만) · 같은 주 5년 평균 대비 ${sg(inv.dev)}% (${inv.date} 주)` } : null,
  curve ? { k: "기간구조", t: `${cs.label} — 근월물 $${fmt(curve.pts[0][1], 2)}, 12개월 뒤 $${fmt(curve.pts.at(-1)[1], 2)} · 롤 수익 연 ${sg(curve.roll_ann)}%` } : null,
  D.crack ? { k: "정제 마진", t: `3-2-1 크랙 $${fmt(D.crack.last, 1)}/배럴 (최근 10년 중 상위 ${fmt(100 - D.crack.pct_10y)}%)` } : null,
  D.cot ? { k: "투기 포지션", t: `비상업 순매수 ${fmt(D.cot.net)}계약 · 미결제약정의 ${sg(D.cot.pct_oi)}% (최근 10년 백분위 ${fmt(D.cot.pct_10y)}) · ${D.cot.date}` } : null,
  { k: "시장 국면", t: `${regime.name} 확률 ${Math.round(Math.max(...hm.filtered.at(-1)) * 100)}% (연 변동성 ${Math.round(regime.sigAnn * 100)}% 수준의 국면)` },
  { k: "1년 범위", t: `10번 중 8번은 $${fmt(q12[0])} ~ $${fmt(q12[4])}, 과거 검증 적중률 ${Math.round(rm[252].eval.model.c80 * 100)}%` },
].filter(Boolean);
const brief = { date: D.wti.date, headline: v.title, sub: v.sub, plan: v.plan, bullets, alertCount: al.length };
const LV = { critical: "경고", warn: "주의", info: "정보" };
const md = [`# 유가 일간 브리핑 · ${brief.date}`, "", `**지금은: ${v.title}** — ${v.sub}`, "", ...bullets.map((b) => `- **${b.k}**: ${b.t}`), "",
  `## 알림 ${al.length}건`, ...(al.length ? al.map((a) => `- [${LV[a.level]}] **${a.title}** — ${a.detail}`) : ["- 없음"]), "",
  "_정보 제공 목적이며 투자 권유가 아닙니다. 모든 수치는 Oil Miner 데이터 파이프라인에서 계산했습니다._", ""].join("\n");
fs.writeFileSync(path.join(ROOT, "site/data/oil_brief.md"), md);

const out = {
  generated_at: new Date().toISOString().slice(0, 19) + "Z",
  asof: D.wti.date,
  factors: fv.map((f) => ({ ...f, ic: Object.fromEntries(Object.entries(f.ic).map(([k, x]) => [k, r4(x)])), now: r4(f.now), bins: f.bins.map((b) => ({ n: b.n, lo: r4(b.lo), hi: r4(b.hi), mean: r4(b.mean), up: r4(b.up) })) })),
  range: Object.fromEntries(H.map((h) => [h, {
    eval: { n: rm[h].eval.n, skill: r4(rm[h].eval.skill), model: { c80: r4(rm[h].eval.model.c80), c50: r4(rm[h].eval.model.c50) }, base: { c80: r4(rm[h].eval.base.c80), c50: r4(rm[h].eval.base.c50) } },
    now: { q: rm[h].now.q.map(r4), up: r4(rm[h].now.up), lam: r4(rm[h].now.lam) },
  }])),
  alerts: al,
  brief,
  hmm: { clip: CLIP, states, A: hm.A.map((r) => r.map(r4)), now: hm.filtered.at(-1).map(r4), nowDate: w.t.at(-1), ribbon },
};
const dest = path.join(ROOT, "site/data/om_models.js");
fs.writeFileSync(dest, "/* generated by etl/build_oil_models.js — do not edit */\nwindow.OM_MODELS=" + JSON.stringify(out) + ";\n");
console.log(`wrote site/data/om_models.js (${Math.round(fs.statSync(dest).size / 1024)} KB) in ${Date.now() - t0}ms`);
console.log(md);
console.log("factor IC(3m):", fv.map((f) => `${f.id} ${f.ic[63] != null ? f.ic[63].toFixed(3) : "—"}`).join(" | "));
console.log("range c80", H.map((h) => out.range[h].eval.model.c80), "base", H.map((h) => out.range[h].eval.base.c80), "skill", H.map((h) => out.range[h].eval.skill));
console.log("hmm", states.map((s) => `${s.name} ${s.muAnn} ${s.sigAnn}`), "now", out.hmm.now);
