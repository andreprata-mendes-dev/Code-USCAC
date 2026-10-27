@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>&1
if not errorlevel 1 (
  py -m http.server 3000 --bind 127.0.0.1
  exit /b %errorlevel%
)
where python >nul 2>&1
if errorlevel 1 (
  echo Python 3 was not found. Install Python 3 or use VS Code Live Server.
  pause
  exit /b 1
)
python -m http.server 3000 --bind 127.0.0.1
