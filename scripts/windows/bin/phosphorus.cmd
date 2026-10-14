@echo off
rem phosphorus on PATH, the work phosphorus.ps1's
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0phosphorus.ps1" %*
exit /b %ERRORLEVEL%
