@echo off
:: Double-click this any time to see the web address the tablet should use.
:: Safe to run any time; it does not change anything on this computer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Show-Tablet-Address.ps1"
pause
