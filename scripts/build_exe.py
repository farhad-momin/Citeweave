"""Build the Windows app with PyInstaller. Run on Windows: python scripts/build_exe.py"""
import shutil
import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
sep = ";" if sys.platform == "win32" else ":"

COMMON = [
    "--noconfirm",
    # the launchers live in scripts/, so tell PyInstaller where the citeweave package is
    "--paths", str(ROOT),
    "--icon", str(ROOT / "assets" / "citeweave.ico"),
    "--add-data", f"{ROOT / 'citeweave' / 'static'}{sep}citeweave/static",
    "--collect-submodules", "uvicorn",
    "--collect-submodules", "citeweave",
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
]

# 1. the app window
PyInstaller.__main__.run([
    str(ROOT / "scripts" / "launcher.py"),
    "--name", "Citeweave",
    "--clean",
    "--windowed",
    "--onedir",
    "--distpath", str(DIST),
    *COMMON,
])

# 2. the tool server for the Claude desktop app. It needs a console program because
#    Claude talks to it over standard input and output. Built next to Citeweave.exe.
MCP_DIST = ROOT / "build" / "mcp-dist"
PyInstaller.__main__.run([
    str(ROOT / "scripts" / "mcp_launcher.py"),
    "--name", "citeweave-mcp",
    "--console",
    "--onefile",
    "--distpath", str(MCP_DIST),
    *COMMON,
])
shutil.copy2(MCP_DIST / ("citeweave-mcp.exe" if sys.platform == "win32" else "citeweave-mcp"), DIST / "Citeweave")

archive = shutil.make_archive(str(DIST / "Citeweave-windows"), "zip", DIST, "Citeweave")
print("Built", archive)
