@echo off
rem hesperus on PATH, the work hesperus.ps1's
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hesperus.ps1" %*
exit /b %ERRORLEVEL%
