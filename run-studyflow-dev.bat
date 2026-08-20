@echo off
setlocal
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
set "STUDYFLOW_DATA_DIR=%APPDATA%\studyflow"

if not exist "node_modules\electron\electron.exe" (
  echo Installing development dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting StudyFlow from raw source...
call npm run desktop
endlocal
