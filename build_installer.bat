@echo off
setlocal
title Build LermLearn Installer
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found.
  echo Install Node.js 20+ from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

echo Installing desktop build dependencies...
npm install
if errorlevel 1 goto failed

echo Building LermLearn Windows installer...
npm run dist
if errorlevel 1 goto failed

echo.
echo Installer created in the dist folder.
pause
exit /b 0

:failed
echo.
echo Build failed. Read the message above and try again.
pause
exit /b 1
