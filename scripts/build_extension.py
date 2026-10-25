"""Package the browser extension for Chromium browsers (Chrome, Edge, Brave, Opera) and Firefox.

Output:
  dist/citeweave-extension-chromium.zip
  dist/citeweave-extension-firefox.zip
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "extension"
DIST = ROOT / "dist"
FILES = ["popup.html", "popup.css", "popup.js", "detect.js", "options.html", "options.js",
         "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"]


def build(name: str, manifest: dict) -> Path:
    DIST.mkdir(exist_ok=True)
    out = DIST / f"citeweave-extension-{name}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        for f in FILES:
            z.write(SRC / f, f)
    return out


def main() -> None:
    base = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    print("Built", build("chromium", base))
    firefox = dict(base)
    firefox["browser_specific_settings"] = {
        "gecko": {
            "id": "citeweave@citeweave.org",
            "strict_min_version": "128.0",
            "data_collection_permissions": {"required": ["none"]},
        }
    }
    print("Built", build("firefox", firefox))


if __name__ == "__main__":
    main()
