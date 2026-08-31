@echo off
:: Double-click this file to update Clear Path POS to the latest version.
:: You do not need to type any commands - just click through the prompts.
:: Your sales data (data\pos.db) and settings (.env) are never touched.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-ClearPathPOS.ps1"
pause
