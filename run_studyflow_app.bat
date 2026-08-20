@echo off
setlocal
title StudyFlow Desktop
cd /d "%~dp0"
set "STUDYFLOW_DATA_DIR=%APPDATA%\studyflow"

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Users\ACER\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=C:\Users\ACER\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo Node.js was not found.
  pause
  exit /b 1
)

set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE_EXE%" set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE_EXE%" (
  echo Microsoft Edge was not found.
  pause
  exit /b 1
)

echo Starting StudyFlow desktop window...
start "StudyFlow Server" /min "%NODE_EXE%" server.mjs
timeout /t 2 /nobreak >nul
start "StudyFlow" "%EDGE_EXE%" --app=http://127.0.0.1:4173/ --start-maximized --no-first-run --disable-features=msEdgeSidebarV2
exit /b 0
