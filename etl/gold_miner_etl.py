"""Gold Miner — Phase 1 data pipeline.

Collects daily gold prices and macro series, runs quality checks, derives
KRW prices, and writes:
  data/raw/<series>.csv        raw downloads (one file per series)
  data/clean/daily.csv         aligned daily panel
  site/data/gm_data.js         compact bundle the dashboard loads (window.GM_DATA)

Standard library only, so it runs anywhere Python 3.9+ is available.
Usage:  python etl/gold_miner_etl.py [--offline]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import statistics
import sys
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CLEAN = ROOT / "data" / "clean"
BUNDLE = ROOT / "site" / "data" / "gm_data.js"

TROY_OUNCE_G = 31.1035
DON_G = 3.75

# FRED series used by the dashboard.
FRED_SERIES = {
    "DFII10": "10Y 실질금리 (TIPS)",
    "DTWEXBGS": "달러 인덱스 (Broad)",
    "T10YIE": "10Y 기대인플레이션",
    "DGS10": "10Y 국채금리",
    "DEXKOUS": "USD/KRW",
}
HIST_SERIES = ("DFII10", "DTWEXBGS", "T10YIE")
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
# Gold sources, tried in order.
GOLD_SOURCES = [
    ("yahoo", "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?period1=946684800&period2=9999999999&interval=1d"),
    ("stooq", "https://stooq.com/q/d/l/?s=xauusd&i=d"),
]

Series = dict  # {date: float}


# ---------------------------------------------------------------- fetching
def http_get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (gold-miner-etl)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


# ---------------------------------------------------------------- parsing
def parse_fred_csv(text: str) -> Series:
    """FRED CSV: observation_date,<ID>. Missing values are '.' or empty."""
    out: Series = {}
    rows = csv.reader(io.StringIO(text))
    header = next(rows, None)
    if not header or len(header) < 2:
        raise ValueError("unexpected FRED header")
    for row in rows:
        if len(row) < 2:
            continue
        try:
            d = date.fromisoformat(row[0].strip())
            v = float(row[1])
        except ValueError:
            continue
        if math.isfinite(v):
            out[d] = v
    return out


def parse_ohlc_csv(text: str) -> Series:
    """Stooq-style CSV: Date,Open,High,Low,Close[,Volume] → close prices."""
    out: Series = {}
    rows = csv.DictReader(io.StringIO(text))
    if not rows.fieldnames or "Close" not in rows.fieldnames:
        raise ValueError("no Close column (source may be rate-limited)")
    for row in rows:
        try:
            d = date.fromisoformat(row["Date"].strip())
            v = float(row["Close"])
        except (ValueError, KeyError, AttributeError):
            continue
        if math.isfinite(v) and v > 0:
            out[d] = v
    return out


def parse_yahoo_chart(text: str) -> Series:
    """Yahoo v8 chart JSON → daily close (UTC dates of the session timestamp)."""
    j = json.loads(text)
    res = (j.get("chart") or {}).get("result") or []
    if not res:
        raise ValueError("empty Yahoo chart result")
    r = res[0]
    ts = r.get("timestamp") or []
    closes = ((r.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    off = (r.get("meta") or {}).get("gmtoffset", 0)
    out: Series = {}
    for t, c in zip(ts, closes):
        if c is None or not math.isfinite(c) or c <= 0:
            continue
        out[datetime.fromtimestamp(t + off, tz=timezone.utc).date()] = float(c)
    return out


def parse_gold(name: str, text: str) -> Series:
    return parse_yahoo_chart(text) if name == "yahoo" else parse_ohlc_csv(text)


# ---------------------------------------------------------------- quality
@dataclass
class QualityReport:
    name: str
    rows: int = 0
    first: str = ""
    last: str = ""
    stale_days: int = 0
    max_gap_days: int = 0
    jumps: list = field(default_factory=list)  # (date, pct)
    dropped: int = 0

    def ok(self, max_stale: int = 10) -> bool:
        return self.rows > 0 and self.stale_days <= max_stale


def check_quality(name: str, s: Series, jump_pct: float = 8.0,
                  today: date | None = None, positive: bool = True) -> tuple[Series, QualityReport]:
    """Drops non-positive values (for prices), flags day-over-day jumps,
    measures gaps and staleness. Jumps are flagged, not removed: real
    markets do move that much (e.g. 2013-04, 2020-03)."""
    today = today or date.today()
    rep = QualityReport(name)
    clean: Series = {}
    for d in sorted(s):
        v = s[d]
        if positive and v <= 0:
            rep.dropped += 1
            continue
        clean[d] = v
    ds = sorted(clean)
    rep.rows = len(ds)
    if not ds:
        return clean, rep
    rep.first, rep.last = ds[0].isoformat(), ds[-1].isoformat()
    rep.stale_days = (today - ds[-1]).days
    for a, b in zip(ds, ds[1:]):
        rep.max_gap_days = max(rep.max_gap_days, (b - a).days)
        if positive and clean[a] > 0:
            pct = (clean[b] / clean[a] - 1) * 100
            if abs(pct) >= jump_pct:
                rep.jumps.append((b.isoformat(), round(pct, 2)))
    return clean, rep


# ---------------------------------------------------------------- derive
def krw_per_gram(usd_per_oz: float, usdkrw: float) -> float:
    return usd_per_oz * usdkrw / TROY_OUNCE_G


def domestic_premium(krx_krw_per_g: float, usd_per_oz: float, usdkrw: float) -> float:
    """KRX 괴리율 (%) = KRX price / international KRW price − 1."""
    return (krx_krw_per_g / krw_per_gram(usd_per_oz, usdkrw) - 1) * 100


def align(base: Series, other: Series) -> Series:
    """For every date in base, take the latest value of other on or before it
    (forward fill; never looks ahead)."""
    out: Series = {}
    od = sorted(other)
    j, last = 0, None
    for d in sorted(base):
        while j < len(od) and od[j] <= d:
            last = other[od[j]]
            j += 1
        if last is not None:
            out[d] = last
    return out


def month_end(s: Series) -> Series:
    out: Series = {}
    for d in sorted(s):
        out[date(d.year, d.month, 1)] = s[d]  # last write in month wins
    return out


EPOCH = date(1970, 1, 1)


def epoch_day(d: date) -> int:
    return (d - EPOCH).days


def week_end(s: Series) -> Series:
    """Last observation of each ISO week (keeps the real observation date)."""
    last: dict = {}
    for d in sorted(s):
        last[d.isocalendar()[:2]] = d
    return {d: s[d] for d in last.values()}


def change(s: Series, days: int) -> float | None:
    ds = sorted(s)
    if not ds:
        return None
    end = ds[-1]
    past = [d for d in ds if d <= end - timedelta(days=days)]
    if not past:
        return None
    return s[end] - s[past[-1]]


def pct_change(s: Series, days: int) -> float | None:
    ds = sorted(s)
    past = [d for d in ds if d <= ds[-1] - timedelta(days=days)] if ds else []
    if not past:
        return None
    return (s[ds[-1]] / s[past[-1]] - 1) * 100


def annual_vol(s: Series, lookback: int = 252) -> float:
    vals = [s[d] for d in sorted(s)][-lookback - 1:]
    rets = [math.log(b / a) for a, b in zip(vals, vals[1:]) if a > 0 and b > 0]
    return statistics.stdev(rets) * math.sqrt(252) if len(rets) > 2 else float("nan")


# ---------------------------------------------------------------- io
def save_raw(name: str, s: Series) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    with open(RAW / f"{name}.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", name])
        for d in sorted(s):
            w.writerow([d.isoformat(), s[d]])


def load_raw(name: str) -> Series:
    p = RAW / f"{name}.csv"
    if not p.exists():
        return {}
    with open(p) as f:
        r = csv.reader(f)
        next(r)
        return {date.fromisoformat(a): float(b) for a, b in r}


def fetch_all(offline: bool) -> dict[str, Series]:
    data: dict[str, Series] = {}
    for sid in FRED_SERIES:
        if offline:
            data[sid] = load_raw(sid)
            continue
        try:
            data[sid] = parse_fred_csv(http_get(FRED_URL.format(sid=sid)))
            save_raw(sid, data[sid])
        except Exception as e:  # keep last good copy
            print(f"  ! {sid}: {e} — using cached copy", file=sys.stderr)
            data[sid] = load_raw(sid)
    gold: Series = {}
    if not offline:
        for name, url in GOLD_SOURCES:
            try:
                gold = parse_gold(name, http_get(url))
                if gold:
                    print(f"  gold from {name}: {len(gold)} rows")
                    save_raw("XAUUSD", gold)
                    break
            except Exception as e:
                print(f"  ! gold/{name}: {e}", file=sys.stderr)
    data["XAUUSD"] = gold or load_raw("XAUUSD")
    return data


# ---------------------------------------------------------------- bundle
def build_bundle(data: dict[str, Series], reports: list[QualityReport]) -> dict:
    gold = data.get("XAUUSD", {})
    fx = data.get("DEXKOUS", {})
    out: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {"gold": "COMEX gold futures GC=F (via Yahoo Finance)", "macro": "FRED, Federal Reserve Bank of St. Louis"},
        "quality": [r.__dict__ for r in reports],
        "macro": {},
    }
    for sid, label in FRED_SERIES.items():
        s = data.get(sid, {})
        if not s:
            continue
        ds = sorted(s)
        weekly = {d: s[d] for d in ds if d >= ds[-1] - timedelta(days=365 * 5)}
        wk = month_end(weekly) if len(weekly) > 400 else weekly
        out["macro"][sid] = {
            "label": label,
            "last": s[ds[-1]], "date": ds[-1].isoformat(),
            "chg_1m": change(s, 30), "chg_1y": change(s, 365),
            "spark": [[d.isoformat(), round(v, 4)] for d, v in sorted(wk.items())][-60:],
        }
        if sid in HIST_SERIES:  # weekly history for correlation and signal backtests
            wkh = week_end({d: v for d, v in s.items() if d.year >= 2000})
            out["macro"][sid]["hist"] = [[epoch_day(d), round(v, 4)] for d, v in sorted(wkh.items())]
    if gold:
        gd = sorted(gold)
        monthly = month_end(gold)
        daily = {d: gold[d] for d in gd if d >= gd[-1] - timedelta(days=730)}
        fx_a = align(daily, fx) if fx else {}
        out["gold"] = {
            "last": gold[gd[-1]], "date": gd[-1].isoformat(),
            "chg_1d": pct_change(gold, 1), "chg_1m": pct_change(gold, 30),
            "chg_1y": pct_change(gold, 365),
            "vol_1y": annual_vol(gold),
            "monthly": [[d.strftime("%Y-%m"), round(v, 2)] for d, v in sorted(monthly.items())],
            "daily": [[d.isoformat(), round(v, 2)] for d, v in sorted(daily.items())],
            "krw_g": [[d.isoformat(), round(krw_per_gram(daily[d], fx_a[d]))] for d in sorted(fx_a)],
            # full daily history: [epoch_day, close]
            "hist": [[epoch_day(d), round(gold[d], 1)] for d in gd],
        }
        if fx:
            out["gold"]["krw_per_g_last"] = krw_per_gram(gold[gd[-1]], fx[sorted(fx)[-1]])
    return out


def write_bundle(bundle: dict) -> None:
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"), default=str)
    BUNDLE.write_text("/* generated by etl/gold_miner_etl.py — do not edit */\nwindow.GM_DATA=" + txt + ";\n",
                      encoding="utf-8")


def write_clean(data: dict[str, Series]) -> None:
    gold = data.get("XAUUSD") or data.get("DFII10") or {}
    CLEAN.mkdir(parents=True, exist_ok=True)
    cols = ["XAUUSD", *FRED_SERIES]
    aligned = {c: align(gold, data[c]) if data.get(c) else {} for c in cols}
    with open(CLEAN / "daily.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", *cols])
        for d in sorted(gold):
            w.writerow([d.isoformat(), *[aligned[c].get(d, "") for c in cols]])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="use cached data/raw only")
    a = ap.parse_args(argv)
    print("Gold Miner ETL")
    data = fetch_all(a.offline)
    reports = []
    for name in list(data):
        positive = name not in ("DFII10",)  # real yields can be negative
        data[name], rep = check_quality(name, data[name], positive=positive,
                                        jump_pct=8.0 if name == "XAUUSD" else 1e9)
        reports.append(rep)
        flag = "OK " if rep.ok() else "WARN"
        print(f"  [{flag}] {name:9s} rows={rep.rows:6d} {rep.first}→{rep.last} "
              f"stale={rep.stale_days}d gap={rep.max_gap_days}d jumps={len(rep.jumps)}")
    write_clean(data)
    write_bundle(build_bundle(data, reports))
    print(f"  wrote {BUNDLE.relative_to(ROOT)}")
    return 0 if all(r.rows for r in reports if r.name != "XAUUSD") else 1


if __name__ == "__main__":
    sys.exit(main())
