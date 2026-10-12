@echo off
rem phos on PATH, the work phos.ps1's
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0phos.ps1" %*
exit /b %ERRORLEVEL%
