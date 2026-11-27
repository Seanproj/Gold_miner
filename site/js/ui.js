/* Gold Miner — shared UI: theme, up/down colour convention, global header, count-up.
   Loaded in <head> so the saved theme applies before first paint. */
(function () {
  "use strict";
  const root = document.documentElement;
  const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  root.dataset.theme = get("gm-theme", "dark");
  root.dataset.updown = get("gm-updown", "kr");
  const subs = [];
  const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

  function sync() {
    const tb = document.getElementById("themeBtn"), ub = document.getElementById("udBtn");
    if (tb) { tb.innerHTML = root.dataset.theme === "dark" ? MOON : SUN; tb.title = root.dataset.theme === "dark" ? "라이트 모드로" : "다크 모드로"; }
    if (ub) {
      const kr = root.dataset.updown === "kr";
      ub.innerHTML = '<span style="color:var(--up)">▲</span><span style="color:var(--down)">▼</span><span class="lbl">' + (kr ? "한국식" : "글로벌") + "</span>";
      ub.title = kr ? "상승 빨강 · 하락 파랑 (국내 관례). 누르면 글로벌식으로" : "상승 초록 · 하락 빨강 (글로벌). 누르면 한국식으로";
    }
  }
  const fire = () => { sync(); subs.forEach((f) => f()); };

  window.GMUI = {
    onChange(f) { subs.push(f); },
    init(opts = {}) {
      sync();
      const tb = document.getElementById("themeBtn"), ub = document.getElementById("udBtn");
      if (tb) tb.onclick = () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; set("gm-theme", root.dataset.theme); fire(); };
      if (ub) ub.onclick = () => { root.dataset.updown = root.dataset.updown === "kr" ? "global" : "kr"; set("gm-updown", root.dataset.updown); fire(); };
      const fr = document.getElementById("fresh");
      if (fr && opts.asOf) fr.innerHTML = '<i></i><span>실데이터 · ' + opts.asOf + " 기준</span>";
      // section chips: highlight the section in view
      const chips = [...document.querySelectorAll(".gh-sub a")];
      if (chips.length) {
        const onScroll = () => {
          let cur = chips[0];
          chips.forEach((a) => { const t = document.querySelector(a.getAttribute("href")); if (t && t.getBoundingClientRect().top < 180) cur = a; });
          chips.forEach((a) => a.classList.toggle("on", a === cur));
        };
        addEventListener("scroll", onScroll, { passive: true }); onScroll();
      }
    },
    /** Animate a number into `el`; `format` turns a number into display HTML. */
    countUp(el, to, format, ms = 900) {
      if (!el) return;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches || !isFinite(to)) { el.innerHTML = format(to); return; }
      const t0 = performance.now();
      const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.innerHTML = format(to * e); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    },
  };
})();
