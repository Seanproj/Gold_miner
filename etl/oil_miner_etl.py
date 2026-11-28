"""Oil Miner — data pipeline for the oil pages (shares helpers with the gold ETL).

Collects oil prices, the futures curve, US inventories, positioning and the oil ETFs a
Korean investor can buy, runs quality checks and writes:
  data/raw/<series>.csv        raw downloads (one file per series)
  site/data/om_data.js         compact bundle the oil pages load (window.OM_DATA)

Standard library only (Python 3.9+).   Usage:  python etl/oil_miner_etl.py [--offline]

Rules worth knowing
  * Headline price = WTI spot (FRED DCOILWTICO, 1986~). FRED publishes with a few days' delay,
    so days after FRED's last date are filled from the front-month future (Yahoo CL=F).
  * 2020-04-20: WTI settled at −$36.98. A log return through a negative price is undefined,
    so analysis series drop non-positive days (the 04-17 → 04-21 move counts as one day).
    The raw file keeps the real value and the bundle reports it.
  * EIA weekly data (week ending Friday) is published the next Wednesday; CFTC positions
    (Tuesday) are published on Friday. Models use them only after those delays.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import statistics
import sys
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gold_miner_etl import (  # noqa: E402  (shared helpers)
    RAW, align, annual_vol, check_quality, epoch_day, http_get, load_raw, month_end,
    parse_fred_csv, parse_yahoo_chart, pct_change, save_raw, week_end, FRED_URL, QualityReport,
)

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "site" / "data" / "om_data.js"
BARREL_L = 158.987
GALLON_PER_BBL = 42

FRED_OIL = {
    "DCOILWTICO": "WTI 현물 (USD/배럴)",
    "DCOILBRENTEU": "Brent 현물 (USD/배럴)",
    "DGASNYH": "뉴욕항 휘발유 현물 (USD/갤런)",
    "DHOILNYH": "뉴욕항 난방유 현물 (USD/갤런)",
    "CPIAUCSL": "미국 소비자물가지수",
    "GASREGW": "미국 휘발유 소매가 (USD/갤런)",
}
FRED_SHARED = ("DEXKOUS", "DTWEXBGS")  # also collected by the gold ETL
YAHOO = {"CL_F": "CL=F", "BZ_F": "BZ=F", "USO": "USO", "BNO": "BNO"}
YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1=0&period2=9999999999&interval=1d"
YAHOO_SNAP = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=5d&interval=1d"
MONTH_CODES = "FGHJKMNQUVXZ"

EIA_URL = "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s={sid}&f=W"
EIA_SERIES = {
    "WCESTUS1": ("crude", "원유 상업재고 (SPR 제외)", "천 배럴"),
    "W_EPC0_SAX_YCUOK_MBBL": ("cushing", "쿠싱 재고 (WTI 인도지)", "천 배럴"),
    "WGTSTUS1": ("gasoline", "휘발유 재고", "천 배럴"),
    "WDISTUS1": ("distillate", "정제유(경유·난방유) 재고", "천 배럴"),
    "WCSSTUS1": ("spr", "전략비축유 (SPR)", "천 배럴"),
    "WCRFPUS2": ("production", "미국 원유 생산", "천 배럴/일"),
    "WPULEUS3": ("utilization", "정제 가동률", "%"),
}
SEASONAL = ("crude", "cushing", "gasoline", "distillate")

COT_URL = "https://www.cftc.gov/files/dea/history/deacot{year}.zip"
COT_CODE = "067651"  # NYMEX WTI light sweet crude (legacy report, futures only)
COT_FIRST_YEAR = 2006

NAVER_STOCK = "https://m.stock.naver.com/api/stock/{code}/price?pageSize=60&page={page}"
KR_ETFS = {
    "KODEX_WTI": ("261220", "KODEX WTI원유선물(H)"),
    "TIGER_OIL": ("130680", "TIGER 원유선물Enhanced(H)"),
}

Series = dict


# ---------------------------------------------------------------- parsing
def parse_eia_leaf(text: str) -> Series:
    """EIA 'LeafHandler' weekly history table → {week-ending date: value}.
    Each row is one month ('2026-Nov') holding up to five (MM/DD, value) pairs."""
    out: Series = {}
    for row in re.findall(r"<td class='B6'>(.*?)</tr>", text, re.S):
        m = re.search(r"(\d{4})-([A-Z][a-z]{2})", row)
        if not m:
            continue
        year = int(m.group(1))
        mon = datetime.strptime(m.group(2), "%b").month
        cells = [re.sub(r"<[^>]+>|&nbsp;", "", c).strip() for c in re.findall(r"<td class='B[35]'>(.*?)</td>", row, re.S)]
        for md, val in zip(cells[0::2], cells[1::2]):
            if not md or not val:
                continue
            try:
                mm, dd = (int(x) for x in md.split("/"))
                v = float(val.replace(",", ""))
            except ValueError:
                continue
            y = year + 1 if (mon == 12 and mm == 1) else year - 1 if (mon == 1 and mm == 12) else year
            out[date(y, mm, dd)] = v
    if not out:
        raise ValueError("no rows in EIA table")
    return out


def parse_cot_csv(text: str, code: str = COT_CODE) -> dict:
    """CFTC legacy futures-only annual file → {report date: (open interest, noncommercial net)}."""
    out = {}
    r = csv.reader(io.StringIO(text))
    header = next(r, None)
    if not header:
        return out
    idx = {h.strip(): i for i, h in enumerate(header)}
    i_d = idx["As of Date in Form YYYY-MM-DD"]
    i_c = idx["CFTC Contract Market Code"]
    i_oi = idx["Open Interest (All)"]
    i_l = idx["Noncommercial Positions-Long (All)"]
    i_s = idx["Noncommercial Positions-Short (All)"]
    for row in r:
        if len(row) <= i_s or row[i_c].strip() != code:
            continue
        try:
            out[date.fromisoformat(row[i_d].strip())] = (float(row[i_oi]), float(row[i_l]) - float(row[i_s]))
        except ValueError:
            continue
    return out


def parse_naver_stock(text: str) -> Series:
    """Naver stock daily price JSON (list, newest first) → {date: close}."""
    j = json.loads(text)
    if not isinstance(j, list):
        raise ValueError(f"naver stock: {str(j)[:80]}")
    out: Series = {}
    for row in j:
        try:
            out[date.fromisoformat(str(row["localTradedAt"])[:10])] = float(str(row["closePrice"]).replace(",", ""))
        except (KeyError, ValueError):
            continue
    return out


# ---------------------------------------------------------------- derive
def splice(base: Series, ext: Series) -> tuple[Series, date | None]:
    """base history, then ext only for dates after base's last date."""
    if not base:
        return dict(ext), (min(ext) if ext else None)
    last = max(base)
    tail = {d: v for d, v in ext.items() if d > last}
    return {**base, **tail}, (min(tail) if tail else None)


def crack_321(wti: Series, gas: Series, ho: Series) -> Series:
    """3-2-1 crack spread (USD/bbl) = (2 × gasoline + 1 × heating oil − 3 × crude) ÷ 3, gallon prices × 42."""
    out: Series = {}
    for d, c in wti.items():
        g, h = gas.get(d), ho.get(d)
        if g is not None and h is not None and c > 0:
            out[d] = (2 * g * GALLON_PER_BBL + h * GALLON_PER_BBL - 3 * c) / 3
    return out


def seasonal_stats(s: Series, years: int = 5) -> dict:
    """For each weekly observation: mean/min/max of the same calendar week in the previous
    `years` years (nearest observation within ±4 days), deviation and position in that range."""
    ds = sorted(s)
    out = {}
    for d in ds:
        past = []
        for k in range(1, years + 1):
            try:
                target = d.replace(year=d.year - k)
            except ValueError:  # Feb 29
                target = d.replace(year=d.year - k, day=28)
            best = None
            for dd in (target + timedelta(days=x) for x in range(-4, 5)):
                if dd in s and (best is None or abs((dd - target).days) < abs((best - target).days)):
                    best = dd
            if best is not None:
                past.append(s[best])
        if len(past) == years:
            avg = statistics.mean(past)
            out[d] = {"v": s[d], "avg": avg, "min": min(past), "max": max(past), "dev": (s[d] / avg - 1) * 100}
    return out


def realized_roll(fut: Series, spot: Series, days: int = 365) -> Series:
    """1-year log return of an investable futures fund minus the spot log return over the same
    window (×100, ≈ %p). Negative = contango cost (and fees) ate part of the spot move.
    Log returns keep the gap meaningful when spot starts near zero (April 2020)."""
    out: Series = {}
    fd = sorted(fut)
    sp = align(fut, spot)
    j = 0
    for d in fd:
        while j < len(fd) and fd[j] <= d - timedelta(days=days):
            j += 1
        if j == 0:
            continue
        a = fd[j - 1]
        if sp.get(a) and sp.get(d) and sp[a] > 0 and sp[d] > 0:
            out[d] = (math.log(fut[d] / fut[a]) - math.log(sp[d] / sp[a])) * 100
    return out


def percentile_of(vals: list, v: float) -> float:
    return sum(1 for x in vals if x < v) / len(vals) * 100 if vals else float("nan")


def contract_months(today: date, n: int = 14) -> list[tuple[str, str]]:
    """Next n CL contract symbols starting from this calendar month: [('2027-01', 'CLF27.NYM'), ...]."""
    out = []
    y, m = today.year, today.month
    for _ in range(n):
        out.append((f"{y}-{m:02d}", f"CL{MONTH_CODES[m - 1]}{y % 100:02d}.NYM"))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


# ---------------------------------------------------------------- fetching
def fetch_series(name: str, fn, offline: bool) -> Series:
    if offline:
        return load_raw(name)
    try:
        s = fn()
        if s:
            save_raw(name, s)
            return s
        raise ValueError("empty")
    except Exception as e:  # keep last good copy
        print(f"  ! {name}: {e} — using cached copy", file=sys.stderr)
        return load_raw(name)


def fetch_naver_stock(code: str, max_pages: int = 90) -> Series:
    out: Series = {}
    for page in range(1, max_pages + 1):
        chunk = parse_naver_stock(http_get(NAVER_STOCK.format(code=code, page=page)))
        if not chunk or set(chunk) <= set(out):
            break
        out.update(chunk)
    return out


def fetch_cot(offline: bool) -> dict:
    """WTI positions since 2006. Past years are cached; only the current year is re-downloaded."""
    p = RAW / "CFTC_WTI.csv"
    cached = {}
    if p.exists():
        with open(p) as f:
            r = csv.reader(f)
            next(r)
            cached = {date.fromisoformat(a): (float(b), float(c)) for a, b, c in r}
    if offline:
        return cached
    have = {d.year for d in cached}
    this_year = date.today().year
    for y in range(COT_FIRST_YEAR, this_year + 1):
        if y in have and y < this_year:
            continue
        try:
            z = zipfile.ZipFile(io.BytesIO(http_get_bytes(COT_URL.format(year=y))))
            cached.update(parse_cot_csv(z.read(z.namelist()[0]).decode("latin1")))
        except Exception as e:
            print(f"  ! CFTC {y}: {e}", file=sys.stderr)
    if cached:
        RAW.mkdir(parents=True, exist_ok=True)
        with open(p, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "open_interest", "noncomm_net"])
            for d in sorted(cached):
                w.writerow([d.isoformat(), *cached[d]])
    return cached


def http_get_bytes(url: str, timeout: int = 60) -> bytes:
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (oil-miner-etl)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_curve(offline: bool) -> tuple[list, dict]:
    """Today's WTI futures curve from individual contracts, appended to a growing history
    (Yahoo does not keep expired contracts, so the history starts when this pipeline started)."""
    hist_p = RAW / "CL_CURVE.csv"
    hist = {}
    if hist_p.exists():
        with open(hist_p) as f:
            r = csv.reader(f)
            next(r)
            for row in r:
                hist[date.fromisoformat(row[0])] = [float(x) if x else None for x in row[1:]]
    pts, asof = [], None
    if not offline:
        for label, sym in contract_months(date.today()):
            try:
                j = json.loads(http_get(YAHOO_SNAP.format(sym=sym)))
                res = (j.get("chart") or {}).get("result") or []
                if not res:
                    continue
                s = parse_yahoo_chart(json.dumps(j))
                if not s:
                    continue
                d = max(s)
                if asof is None or d > asof:
                    asof = d
                pts.append([label, round(s[d], 2), d])
            except Exception as e:  # expired front months return 404 — expected, stay quiet
                if "404" not in str(e):
                    print(f"  ! curve {sym}: {e}", file=sys.stderr)
        # keep contracts that traded on the latest session (drops expired fronts)
        pts = [p[:2] for p in pts if asof and (asof - p[2]).days <= 3]
        if len(pts) >= 6:
            pick = [pts[i][1] if i < len(pts) else None for i in (0, 1, 2, 5, 11)]
            hist[asof] = pick
            with open(hist_p, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["date", "m1", "m2", "m3", "m6", "m12"])
                for d in sorted(hist):
                    w.writerow([d.isoformat(), *["" if v is None else v for v in hist[d]]])
            (RAW / "CL_CURVE_LATEST.json").write_text(json.dumps({"date": asof.isoformat(), "pts": pts}))
    if not pts and (RAW / "CL_CURVE_LATEST.json").exists():
        j = json.loads((RAW / "CL_CURVE_LATEST.json").read_text())
        pts, asof = j["pts"], date.fromisoformat(j["date"])
    return pts, {"date": asof.isoformat() if asof else None, "hist": hist}


def fetch_all(offline: bool) -> dict:
    data: dict = {}
    for sid in FRED_OIL:
        data[sid] = fetch_series(sid, lambda sid=sid: parse_fred_csv(http_get(FRED_URL.format(sid=sid))), offline)
    for sid in FRED_SHARED:  # reuse the gold ETL's download when it ran first today
        cached = load_raw(sid)
        fresh = cached and (date.today() - max(cached)).days <= 7
        data[sid] = cached if (offline or fresh) else fetch_series(sid, lambda sid=sid: parse_fred_csv(http_get(FRED_URL.format(sid=sid))), offline)
    fxn = load_raw("USDKRW_NAVER")
    if fxn and data.get("DEXKOUS"):
        data["DEXKOUS"] = {**data["DEXKOUS"], **fxn}
    for name, sym in YAHOO.items():
        data[name] = fetch_series(name, lambda sym=sym: parse_yahoo_chart(http_get(YAHOO_URL.format(sym=sym))), offline)
    for sid in EIA_SERIES:
        data["EIA_" + sid] = fetch_series("EIA_" + sid, lambda sid=sid: parse_eia_leaf(http_get(EIA_URL.format(sid=sid))), offline)
    for name, (code, _) in KR_ETFS.items():
        data[name] = fetch_series(name, lambda code=code: fetch_naver_stock(code), offline)
    data["_cot"] = fetch_cot(offline)
    data["_curve"] = fetch_curve(offline)
    return data


# ---------------------------------------------------------------- bundle
def ser(s: Series, nd: int = 2, since: date | None = None) -> list:
    return [[epoch_day(d), round(v, nd)] for d, v in sorted(s.items()) if since is None or d >= since]


def ser_mixed(s: Series, nd: int = 2, daily_days: int = 800) -> list:
    """Weekly history, then daily for the most recent `daily_days` (keeps the bundle small)."""
    cut = max(s) - timedelta(days=daily_days)
    old = week_end({d: v for d, v in s.items() if d < cut})
    return ser({**old, **{d: v for d, v in s.items() if d >= cut}}, nd)


def price_block(s: Series) -> dict:
    ds = sorted(s)
    return {"last": s[ds[-1]], "date": ds[-1].isoformat(), "chg_1d": pct_change(s, 1), "chg_1m": pct_change(s, 30),
            "chg_1y": pct_change(s, 365), "vol_1y": annual_vol(s)}


def build_bundle(data: dict, reports: list) -> dict:
    out: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "price": "WTI·Brent 현물: FRED(미 EIA 원자료), 최근 며칠은 NYMEX/ICE 근월물 선물(Yahoo Finance)로 보충",
            "curve": "NYMEX WTI 월물별 선물 종가 (Yahoo Finance)",
            "inventory": "미 에너지정보청(EIA) 주간 석유 현황",
            "positioning": "미 상품선물거래위원회(CFTC) 주간 포지션 (legacy, 선물만)",
            "etf": "USO·BNO: Yahoo Finance · 국내 ETF: 네이버 금융",
            "macro": "FRED, Federal Reserve Bank of St. Louis",
        },
        "quality": [r.__dict__ for r in reports],
        "units": {"barrel_l": BARREL_L},
        "etf_names": {k: v[1] for k, v in KR_ETFS.items()} | {"USO": "USO (미국 WTI 원유 펀드)", "BNO": "BNO (미국 Brent 원유 펀드)"},
    }
    raw_wti = load_raw("DCOILWTICO")
    neg = {d: v for d, v in raw_wti.items() if v <= 0}
    if neg:
        d = min(neg, key=neg.get)
        out["negative"] = {"date": d.isoformat(), "value": neg[d]}

    for key, spot, fut in (("wti", "DCOILWTICO", "CL_F"), ("brent", "DCOILBRENTEU", "BZ_F")):
        s, from_d = splice(data.get(spot, {}), data.get(fut, {}))
        if not s:
            continue
        b = price_block(s)
        b["spliced_from"] = from_d.isoformat() if from_d else None
        b["hist"] = ser(s, 2) if key == "wti" else ser_mixed(s, 2)
        out[key] = b
        data["_" + key] = s
    wti, brent = data.get("_wti", {}), data.get("_brent", {})
    if wti and brent:
        sp = {d: brent[d] - wti[d] for d in wti if d in brent}
        out["spread"] = {"last": sp[max(sp)], "date": max(sp).isoformat(), "hist": ser(week_end(sp), 2, date(2000, 1, 1))}
    cpi = data.get("CPIAUCSL", {})
    if cpi:
        out["cpi"] = [[d.strftime("%Y-%m"), v] for d, v in sorted(cpi.items()) if d.year >= 1986]
    # crack spread from spot prices (FRED, same day)
    cr = crack_321(data.get("DCOILWTICO", {}), data.get("DGASNYH", {}), data.get("DHOILNYH", {}))
    if cr:
        cd = sorted(cr)
        vals = [cr[d] for d in cd if d >= cd[-1] - timedelta(days=365 * 10)]
        out["crack"] = {"last": cr[cd[-1]], "date": cd[-1].isoformat(), "pct_10y": percentile_of(vals, cr[cd[-1]]),
                        "mean_10y": statistics.mean(vals), "hist": ser(week_end(cr), 2)}
    gas = data.get("GASREGW", {})
    if gas:
        out["retail_gas"] = {"last": gas[max(gas)], "date": max(gas).isoformat(), "chg_1y": pct_change(gas, 365)}
    # futures curve
    pts, ch = data.get("_curve", ([], {}))
    if pts:
        m1, m2 = pts[0][1], pts[1][1]
        out["curve"] = {
            "date": ch["date"], "pts": pts,
            "roll_ann": (m1 / m2 - 1) * 12 * 100,  # % per year, positive = backwardation
            "m1_m12": (m1 / pts[min(11, len(pts) - 1)][1] - 1) * 100,
            "hist": [[epoch_day(d), *v] for d, v in sorted(ch["hist"].items())],
        }
    # inventories
    inv = {}
    for sid, (key, label, unit) in EIA_SERIES.items():
        s = data.get("EIA_" + sid, {})
        if not s:
            continue
        ds = sorted(s)
        blk = {"label": label, "unit": unit, "last": s[ds[-1]], "date": ds[-1].isoformat(),
               "chg_w": s[ds[-1]] - s[ds[-2]] if len(ds) > 1 else None}
        if key in SEASONAL:
            st = seasonal_stats(s)
            if st:
                sd = sorted(st)
                L = st[sd[-1]]
                devs = [st[d]["dev"] for d in sd if d >= sd[-1] - timedelta(days=365 * 15)]
                blk.update({"avg5": L["avg"], "min5": L["min"], "max5": L["max"], "dev": L["dev"],
                            "dev_pct": percentile_of(devs, L["dev"]),
                            "season": [[epoch_day(d), st[d]["v"], round(st[d]["avg"]), st[d]["min"], st[d]["max"]] for d in sd if d >= sd[-1] - timedelta(days=370)],
                            "devhist": [[epoch_day(d), round(st[d]["dev"], 1)] for d in sd if d.year >= 2000]})
        else:
            blk["hist"] = ser(s, 1, ds[-1] - timedelta(days=365 * 5))
        inv[key] = blk
    if inv:
        out["inventory"] = inv
    # positioning
    cot = data.get("_cot", {})
    if cot:
        cd = sorted(cot)
        pct = {d: cot[d][1] / cot[d][0] * 100 for d in cd if cot[d][0] > 0}
        vals = [pct[d] for d in cd if d >= cd[-1] - timedelta(days=365 * 10)]
        out["cot"] = {"date": cd[-1].isoformat(), "net": cot[cd[-1]][1], "oi": cot[cd[-1]][0], "pct_oi": pct[cd[-1]],
                      "pct_10y": percentile_of(vals, pct[cd[-1]]), "hist": ser(pct, 2)}
    # ETFs (daily) and the FX series needed to convert USD results to won
    etf = {}
    for name in ("USO", "BNO", *KR_ETFS):
        s = data.get(name, {})
        if s:
            etf[name] = {"last": s[max(s)], "date": max(s).isoformat(), "hist": ser(s, 2 if name in ("USO", "BNO") else 0)}
    out["etf"] = etf
    uso = data.get("USO", {})
    if uso and wti:
        rr = realized_roll(uso, wti)
        out["realized_roll"] = {"last": rr[max(rr)], "date": max(rr).isoformat(), "hist": ser(week_end(rr), 2)}
    fx = data.get("DEXKOUS", {})
    if fx:
        out["fx"] = {"last": fx[max(fx)], "date": max(fx).isoformat(), "hist": ser_mixed({d: v for d, v in fx.items() if d.year >= 2006}, 1)}
    usd = data.get("DTWEXBGS", {})
    if usd:
        out["dollar"] = {"last": usd[max(usd)], "date": max(usd).isoformat(), "chg_1m": pct_change(usd, 30), "hist": ser(week_end(usd), 3)}
    gold = load_raw("XAUUSD")  # written by the gold ETL; used to compare volatility for sizing
    if gold:
        out["gold_vol_1y"] = annual_vol(gold)
    if wti:
        out["wti"]["monthly"] = [[d.strftime("%Y-%m"), round(v, 2)] for d, v in sorted(month_end(wti).items())]
    return out


def write_bundle(bundle: dict) -> None:
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"), default=str)
    BUNDLE.write_text("/* generated by etl/oil_miner_etl.py — do not edit */\nwindow.OM_DATA=" + txt + ";\n", encoding="utf-8")


QUALITY_LIMITS = {  # (max stale days, jump % flag) — weekly series are allowed to lag more
    "default": (10, 25.0), "CPIAUCSL": (75, 1e9), "GASREGW": (14, 1e9), "EIA": (16, 1e9),
}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="use cached data/raw only")
    a = ap.parse_args(argv)
    print("Oil Miner ETL")
    data = fetch_all(a.offline)
    reports = []
    for name in [k for k in data if not k.startswith("_")]:
        if not data[name]:
            rep = QualityReport(name)
            reports.append(rep)
            print(f"  [WARN] {name:22s} no data")
            continue
        lim = QUALITY_LIMITS.get("EIA" if name.startswith("EIA_") else name, QUALITY_LIMITS["default"])
        # prices are positive; drop non-positive days (only 2020-04-20 WTI) — see module docstring
        data[name], rep = check_quality(name, data[name], jump_pct=lim[1])
        rep.ok_limit = lim[0]
        reports.append(rep)
        flag = "OK " if rep.ok(lim[0]) else "WARN"
        print(f"  [{flag}] {name:22s} rows={rep.rows:6d} {rep.first}→{rep.last} stale={rep.stale_days}d jumps={len(rep.jumps)}")
    cot = data.get("_cot", {})
    print(f"  [{'OK ' if cot else 'WARN'}] CFTC_WTI               rows={len(cot):6d}")
    pts = data.get("_curve", ([], {}))[0]
    print(f"  [{'OK ' if pts else 'WARN'}] WTI curve              contracts={len(pts)}")
    write_bundle(build_bundle(data, reports))
    print(f"  wrote {BUNDLE.relative_to(ROOT)} ({BUNDLE.stat().st_size // 1024} KB)")
    must = ("DCOILWTICO", "CL_F")
    return 0 if all(data.get(m) for m in must) else 1


if __name__ == "__main__":
    sys.exit(main())
