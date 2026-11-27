"""Inline local scripts (data bundle, engine) into each page →
site/dist/<page>.html: self-contained files that open anywhere and link to each other."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
PAGES = ["index.html", "analysis.html"]


def inline(m: re.Match) -> str:
    src = (SITE / m.group(1)).read_text(encoding="utf-8")
    return "<script>\n" + src.replace("</script", "<\\/script") + "\n</script>"


for page in PAGES:
    html = (SITE / page).read_text(encoding="utf-8")
    out_html, n = re.subn(r'<script src="((?:data|js)/[^"]+\.js)"></script>', inline, html)
    assert n >= 2, f"{page}: expected data and engine scripts, inlined {n}"
    out = SITE / "dist" / page
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(out_html, encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")
