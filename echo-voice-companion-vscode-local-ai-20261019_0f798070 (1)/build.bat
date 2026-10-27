@echo off
setlocal
cd /d "%~dp0"
copy /Y index.html public\index.html >nul || exit /b 1
copy /Y style.css public\style.css >nul || exit /b 1
copy /Y script.js public\script.js >nul || exit /b 1
copy /Y logo.svg public\logo.svg >nul || exit /b 1
echo Public static files updated.
