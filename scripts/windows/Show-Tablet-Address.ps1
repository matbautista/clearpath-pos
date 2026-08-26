$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lan-ip.ps1')

$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$port = '4000'
$envPath = Join-Path $Root '.env'
if (Test-Path $envPath) {
    $envText = Get-Content $envPath -Raw
    if ($envText -match '(?m)^PORT=(\S+)') { $port = $Matches[1] }
}

$ip = Get-LanIPv4
$all = Get-AllLanIPv4

Write-Host ""
if ($ip) {
    Write-Host "Tablet address: http://${ip}:${port}" -ForegroundColor Green
} else {
    Write-Host "Could not detect a network address on this computer." -ForegroundColor Red
}
if ($all -and $all.Count -gt 1) {
    Write-Host ""
    Write-Host "This computer has more than one network address; if the one above" -ForegroundColor Yellow
    Write-Host "doesn't work on the tablet, try one of these instead:" -ForegroundColor Yellow
    $all | ForEach-Object { Write-Host "  http://${_}:${port}" }
}

Add-Type -AssemblyName System.Windows.Forms | Out-Null
$msg = if ($ip) { "On the tablet's browser, go to:`n`nhttp://${ip}:${port}" } else { "Could not detect this computer's network address. Run 'ipconfig' in Command Prompt instead." }
[System.Windows.Forms.MessageBox]::Show($msg, 'Clear Path POS - Tablet Address', 'OK', 'Information') | Out-Null
