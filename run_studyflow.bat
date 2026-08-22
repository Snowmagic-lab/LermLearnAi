@echo off
setlocal
title StudyFlow

cd /d "%~dp0"
set "STUDYFLOW_DATA_DIR=%APPDATA%\studyflow"

if not exist ".env.local" (
  echo [StudyFlow] Warning: .env.local was not found.
  echo Create it beside this file before using real AI API calls.
  echo.
)

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Users\ACER\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=C:\Users\ACER\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo [StudyFlow] Node.js was not found in PATH.
  echo Install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)

echo [StudyFlow] Starting server at http://127.0.0.1:4173/
start "StudyFlow Browser" http://127.0.0.1:4173/
"%NODE_EXE%" server.mjs

echo.
echo [StudyFlow] Server stopped.
pause
