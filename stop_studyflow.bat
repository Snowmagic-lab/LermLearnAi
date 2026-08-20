@echo off
taskkill /FI "WINDOWTITLE eq StudyFlow*" /T /F >nul 2>nul
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4173 .*LISTENING"') do taskkill /PID %%P /F >nul 2>nul
echo StudyFlow stopped.
pause
