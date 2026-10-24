@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Worker.ps1"
exit /b %errorlevel%
