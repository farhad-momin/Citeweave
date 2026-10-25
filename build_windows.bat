@echo off
rem Build a standalone Citeweave.exe (no Python needed on the target computer).
rem Output: dist\Citeweave\Citeweave.exe  and  dist\Citeweave-windows.zip
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" py -3 -m venv .venv
".venv\Scripts\python.exe" -m pip install -r requirements-dev.txt -r requirements-window.txt || exit /b 1
".venv\Scripts\python.exe" scripts\build_exe.py || exit /b 1
".venv\Scripts\python.exe" scripts\build_extension.py || exit /b 1
echo.
echo Done. See the dist folder.
pause
