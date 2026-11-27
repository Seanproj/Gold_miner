"""Inline site/data/gm_data.js into site/index.html → site/dist/gold_miner.html
(a single file that opens anywhere, e.g. as an email attachment or preview)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
data = (ROOT / "site" / "data" / "gm_data.js").read_text(encoding="utf-8")
tag = '<script src="data/gm_data.js"></script>'
assert tag in html, "data script tag not found"
out = ROOT / "site" / "dist" / "gold_miner.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html.replace(tag, "<script>\n" + data + "</script>"), encoding="utf-8")
print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")
