#!/usr/bin/env bash
# Gold Miner + Oil Miner daily update: data → models/brief/alerts → tests → standalone pages.
# Usage: scripts/update.sh [--offline]
# Gold runs first; the oil ETL reuses its USD/KRW and dollar-index downloads.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/5 gold ETL (FRED, COMEX gold, KRX gold, USD/KRW)"
python3 etl/gold_miner_etl.py "$@"

echo "== 2/5 oil ETL (FRED, NYMEX curve, EIA inventories, CFTC, oil ETFs)"
python3 etl/oil_miner_etl.py "$@"

echo "== 3/5 models, alerts, daily briefs"
node etl/build_models.js | tail -n 3
node etl/build_oil_models.js | tail -n 3

echo "== 4/5 tests"
python3 -m unittest discover -s etl -q
node --test site/js/engine.test.js 2>&1 | grep -E "^# (pass|fail)"
node --test site/js/oil.test.js 2>&1 | grep -E "^# (pass|fail)"

echo "== 5/5 standalone pages"
python3 etl/build_standalone.py
python3 etl/build_artifact.py
echo "done: site/dist/*.html, site/artifact/*, site/data/brief.md, site/data/oil_brief.md"
