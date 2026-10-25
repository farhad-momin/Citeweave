@echo off
setlocal
title Citeweave
cd /d "%~dp0"

rem Find Python 3.10 or newer
set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=py -3" & goto :havepy
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=python" & goto :havepy

echo.
echo Citeweave needs Python 3.10 or newer.
echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
echo Or download the ready-made Citeweave app from the project's Releases page.
echo.
pause
exit /b 1

:havepy
rem First run: create a private environment and install what Citeweave needs
if exist ".venv\Scripts\python.exe" goto :haveenv
echo Setting up Citeweave for the first time. This takes a minute...
%PY% -m venv .venv
if errorlevel 1 goto :fail

:haveenv
if exist ".venv\.installed-0.2.0" goto :run
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :fail
".venv\Scripts\python.exe" -m pip install -r requirements-window.txt
if errorlevel 1 echo Native window not available. Citeweave will open in an Edge app window instead.
echo ok> ".venv\.installed-0.2.0"

:run
rem Start without a console window
start "" ".venv\Scripts\pythonw.exe" -m citeweave
exit /b 0

:fail
echo.
echo Setup failed. Check your internet connection and try again.
echo If it keeps failing, open an issue on the project page and include the message above.
pause
exit /b 1
