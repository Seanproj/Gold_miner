"""Inline local scripts (data bundle, engine) into site/index.html →
site/dist/gold_miner.html, a single file that opens anywhere."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
html = (SITE / "index.html").read_text(encoding="utf-8")


def inline(m: re.Match) -> str:
    src = (SITE / m.group(1)).read_text(encoding="utf-8")
    return "<script>\n" + src.replace("</script", "<\\/script") + "\n</script>"


out_html, n = re.subn(r'<script src="((?:data|js)/[^"]+\.js)"></script>', inline, html)
assert n >= 2, f"expected data and engine scripts, inlined {n}"
out = SITE / "dist" / "gold_miner.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(out_html, encoding="utf-8")
print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB, {n} scripts inlined)")
