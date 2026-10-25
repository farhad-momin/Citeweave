"""Build the static web version into dist/web (ready for GitHub Pages or any static host).

  python scripts/build_web.py

The web version is the same interface as the PC app (citeweave/static) with the browser
engine (web/engine) in place of the local server.
"""
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist" / "web"
STATIC = ROOT / "citeweave" / "static"
WEB = ROOT / "web"


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(STATIC, OUT / "static", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(WEB / "engine", OUT / "static" / "engine")
    for name in ("config.js", "auth.html"):
        shutil.copy(WEB / name, OUT / name)

    html = (STATIC / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="/static/', 'href="static/').replace('src="/static/', 'src="static/')
    html = html.replace("<title>Citeweave</title>", "<title>Citeweave</title>\n"
                        '  <meta name="description" content="Free, open source literature search, citation maps and paper tables for researchers.">')
    boot = ('  <script>window.CITEWEAVE_WEB = true;</script>\n'
            '  <script src="config.js"></script>\n')
    html = re.sub(r'(\s*<script type="module")', "\n" + boot + r"\1", html, count=1)
    (OUT / "index.html").write_text(html, encoding="utf-8")
    (OUT / ".nojekyll").write_text("", encoding="utf-8")  # serve files as they are on GitHub Pages
    print("Built", OUT)


if __name__ == "__main__":
    main()
