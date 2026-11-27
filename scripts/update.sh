#!/usr/bin/env bash
# Gold Miner daily update: data → models/brief/alerts → tests → standalone pages.
# Usage: scripts/update.sh [--offline]
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/4 ETL (FRED, COMEX gold, KRX gold, USD/KRW)"
python3 etl/gold_miner_etl.py "$@"

echo "== 2/4 models, alerts, daily brief"
node etl/build_models.js | tail -n 3

echo "== 3/4 tests"
python3 -m unittest discover -s etl -q
node --test site/js/engine.test.js 2>&1 | grep -E "^# (pass|fail)"

echo "== 4/4 standalone pages"
python3 etl/build_standalone.py
python3 etl/build_artifact.py
echo "done: site/dist/*.html, site/artifact/*, site/data/brief.md"
