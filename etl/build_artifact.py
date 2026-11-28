"""Prepare the standalone pages for publishing as a claude.ai Artifact.

The Artifact host wraps the main page in its own <!doctype>/<head>/<body> skeleton and only
allows stylesheets from Google Fonts, so this script:
  - drops the Pretendard stylesheet (the pages fall back to Noto Sans KR from Google Fonts),
  - writes the main page without the document skeleton tags → site/artifact/index.html,
  - keeps full documents for the linked pages → site/artifact/pages/{index,analysis,oil,oil-analysis}.html.
Run after build_standalone.py.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "site" / "dist"
OUT = ROOT / "site" / "artifact"
PRETENDARD = re.compile(r'<link rel="stylesheet" href="https://cdn\.jsdelivr\.net/[^"]*pretendard[^"]*">\n?')


def clean(html: str) -> str:
    html = PRETENDARD.sub("", html)
    assert "cdn.jsdelivr.net" not in html, "non-allowed stylesheet left"
    return html


def strip_skeleton(html: str) -> str:
    for pat in (r"<!doctype html>\s*", r'<html lang="ko">\s*', r"<head>\s*", r"</head>\s*", r"<body>\s*", r"</body>\s*", r"</html>\s*"):
        html = re.sub(pat, "", html, count=1, flags=re.I)
    return html


(OUT / "pages").mkdir(parents=True, exist_ok=True)
for page in ("index.html", "analysis.html", "oil.html", "oil-analysis.html"):
    (OUT / "pages" / page).write_text(clean((DIST / page).read_text(encoding="utf-8")), encoding="utf-8")
main = strip_skeleton(clean((DIST / "index.html").read_text(encoding="utf-8")))
(OUT / "index.html").write_text(main, encoding="utf-8")
for f in sorted(OUT.rglob("*.html")):
    print(f"wrote {f.relative_to(ROOT)} ({f.stat().st_size // 1024} KB)")
