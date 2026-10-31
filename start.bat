@echo off
title Planchette
cd /d "%~dp0"
rem Stop any Planchette that is still running in the background on port 6660
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:7666 .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
)
timeout /t 1 /nobreak >nul
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py %*
  goto end
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py %*
  goto end
)
echo.
echo   Python was not found. Install it from https://www.python.org/downloads/
echo   (tick "Add python.exe to PATH" in the installer), then run start.bat again.
echo.
:end
pause
