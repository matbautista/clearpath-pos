@echo off
:: Double-click this file to install and start Clear Path POS on this computer.
:: You do not need to type any commands - just click through the prompts.

:: Re-launch this same file elevated if it isn't running as Administrator yet.
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo This needs Administrator access. A Windows permission prompt will appear - click Yes.
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ClearPathPOS.ps1"
pause
