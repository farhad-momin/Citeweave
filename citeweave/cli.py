"""Start Citeweave: run the local server and open the app window.

Kept out of __main__.py because PyInstaller does not bundle modules named __main__.

  python -m citeweave            open the app window
  python -m citeweave --server   run without a window (for the browser extension only)
  python -m citeweave --browser  open in the default web browser instead of an app window
  python -m citeweave --mcp      run the tool server for the Claude desktop app (stdio)
"""
from __future__ import annotations

import argparse
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

from . import APP_NAME, __version__
from .config import data_dir, settings

log = logging.getLogger("citeweave")


def already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ext/ping", timeout=1.5) as r:
            return b"Citeweave" in r.read()
    except Exception:  # noqa: BLE001
        return False


def server_config(port: int):
    import uvicorn

    from .server import app

    # log_config=None: uvicorn's own logging setup calls sys.stdout.isatty(), which crashes under
    # pythonw.exe and in the windowed .exe where sys.stdout is None. Our logging goes to the log file.
    return uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False, log_config=None)


def start_server(port: int) -> threading.Thread:
    import uvicorn

    server = uvicorn.Server(server_config(port))
    t = threading.Thread(target=server.run, daemon=True, name="citeweave-server")
    t.start()
    for _ in range(100):
        if already_running(port):
            break
        time.sleep(0.1)
    return t


def find_edge() -> str | None:
    candidates = [
        shutil.which("msedge"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%LocalAppData%\Microsoft\Edge\Application\msedge.exe"),
        shutil.which("chrome"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        shutil.which("chromium"),
        shutil.which("google-chrome"),
    ]
    return next((c for c in candidates if c and Path(c).exists()), None)


def open_window(url: str) -> None:
    """Prefer a native window (pywebview, uses Windows' built-in WebView2).
    Fall back to an Edge or Chrome app window, then to the default browser."""
    try:
        import webview  # pywebview

        icon = Path(__file__).parent / "static" / "icon.png"
        # pywebview blocks downloads by default; exports (BibTeX, RIS, CSV, backups) need them.
        # Downloads show the normal Windows "Save as" dialog.
        webview.settings["ALLOW_DOWNLOADS"] = True
        # Researchers copy titles, abstracts and quotes, and some need to zoom.
        webview.create_window(APP_NAME, url, width=1360, height=880, min_size=(900, 600),
                              background_color="#F3F5F2", text_select=True, zoomable=True)
        # Keep the window's own storage between launches (remembered sync state and choices).
        webview.start(icon=str(icon) if icon.exists() else None, private_mode=False,
                      storage_path=str(data_dir() / "window"))
        return
    except Exception as e:  # noqa: BLE001
        log.info("Native window unavailable (%s); trying an app window", e)
    edge = find_edge()
    if edge:
        profile = data_dir() / "window-profile"
        proc = subprocess.Popen([edge, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                                 "--window-size=1360,880", "--disable-features=Translate"])
        proc.wait()
        return
    webbrowser.open(url)
    print(f"{APP_NAME} is running at {url}. Press Ctrl+C to stop.")
    while True:
        time.sleep(3600)


def main() -> None:
    parser = argparse.ArgumentParser(prog="citeweave", description=f"{APP_NAME} {__version__}")
    parser.add_argument("--server", action="store_true", help="run without opening a window")
    parser.add_argument("--browser", action="store_true", help="open in the default web browser")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--mcp", action="store_true", help="run the tool server for the Claude desktop app")
    args = parser.parse_args()
    if args.mcp:
        from .mcp_server import main as mcp_main

        mcp_main()  # stdout carries the protocol, so nothing else may print
        return

    handlers: list[logging.Handler] = [logging.FileHandler(data_dir() / "citeweave.log", encoding="utf-8")]
    if sys.stdout:  # absent in the windowed .exe
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    port = args.port or int(settings().get("port") or 23120)
    url = f"http://127.0.0.1:{port}/"

    if already_running(port):
        if not args.server:
            webbrowser.open(url) if args.browser else open_window(url)
        return
    server_thread = start_server(port)
    if args.server:
        print(f"{APP_NAME} server running at {url}. Press Ctrl+C to stop.")
        try:
            server_thread.join()
        except KeyboardInterrupt:
            pass
        return
    if args.browser:
        webbrowser.open(url)
        print(f"{APP_NAME} is running at {url}. Press Ctrl+C to stop.")
        try:
            server_thread.join()
        except KeyboardInterrupt:
            pass
        return
    open_window(url)


if __name__ == "__main__":
    main()
