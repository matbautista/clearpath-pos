#requires -Version 5.1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# scripts\windows\Install-ClearPathPOS.ps1 -> project root is two levels up.
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $PSScriptRoot 'lan-ip.ps1')

function Write-Step($text) {
    Write-Host ""
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Show-Popup($text, $title) {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    [System.Windows.Forms.MessageBox]::Show($text, $title, 'OK', 'Information') | Out-Null
}

trap {
    Write-Host ""
    Write-Host "Setup stopped because of a problem:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Nothing was left half-broken - it's safe to fix the issue (e.g. check your internet connection) and run this installer again."
    Show-Popup "Setup could not finish:`n`n$($_.Exception.Message)`n`nSee the black window for details. It's safe to run this installer again after fixing the issue." "Clear Path POS - Setup Problem"
    Read-Host "Press Enter to close this window"
    exit 1
}

Write-Host "Clear Path POS - Windows Setup" -ForegroundColor Green
Write-Host "Installing from: $Root"

# ---------------------------------------------------------------------------
Write-Step "1/7 Checking for Node.js"
$needsNode = $true
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $verString = (& node -v)
    if ($verString -match 'v(\d+)\.') {
        if ([int]$Matches[1] -ge 18) { $needsNode = $false }
    }
}

if ($needsNode) {
    Write-Host "Node.js not found (or too old) - downloading the current LTS installer..."
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    $msiUrl = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
    $msiPath = Join-Path $env:TEMP 'clearpath-node-installer.msi'
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath
    Write-Host "Installing Node.js $($lts.version) (silent)..."
    Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /quiet /norestart" -Wait
    Remove-Item $msiPath -ErrorAction SilentlyContinue

    # Pick up the newly-installed Node without needing to restart this window.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js installed but isn't on PATH yet. Please restart this computer once, then run this installer again."
    }
    Write-Host "Node.js installed: $(& node -v)" -ForegroundColor Green
} else {
    Write-Host "Found Node.js $(& node -v) - already good." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
Write-Step "2/7 Installing app dependencies (this can take a few minutes)"
Push-Location $Root
cmd /c "npm install"
if ($LASTEXITCODE -ne 0) { throw "npm install failed. Check your internet connection and try again." }
Pop-Location

# ---------------------------------------------------------------------------
Write-Step "3/7 Writing configuration (.env)"
$envPath = Join-Path $Root '.env'
$examplePath = Join-Path $Root '.env.example'
if (-not (Test-Path $envPath)) { Copy-Item $examplePath $envPath }

$envText = Get-Content $envPath -Raw
if ($envText -match 'SESSION_SECRET=change-this-to-a-random-string') {
    $chars = (48..57) + (65..90) + (97..122)
    $secret = -join (1..40 | ForEach-Object { [char]($chars | Get-Random) })
    $envText = $envText -replace 'SESSION_SECRET=change-this-to-a-random-string', "SESSION_SECRET=$secret"
}
if ($envText -notmatch '(?m)^NO_OPEN=') {
    # Running under PM2, there's no interactive user for the app to pop a browser
    # open in - staff use the desktop shortcut or the tablet instead.
    $envText += "`nNO_OPEN=true`n"
}
Set-Content -Path $envPath -Value $envText -NoNewline

$port = '4000'
if ($envText -match '(?m)^PORT=(\S+)') { $port = $Matches[1] }
Write-Host "App will run on port $port" -ForegroundColor Green

# ---------------------------------------------------------------------------
Write-Step "4/7 Allowing it through Windows Firewall"
$ruleName = 'Clear Path POS'
# netsh's exit code here isn't reliable across Windows versions, so check the
# actual "no rules match" text instead of trusting $LASTEXITCODE.
$existingRule = netsh advfirewall firewall show rule name="$ruleName" 2>$null
if ((-not $existingRule) -or (($existingRule -join "`n") -match 'No rules match')) {
    netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$port profile=private,domain | Out-Null
    Write-Host "Firewall rule added for port $port." -ForegroundColor Green
} else {
    Write-Host "Firewall rule already exists." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
Write-Step "5/7 Keeping this computer awake while plugged in"
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
Write-Host "Sleep/hibernate disabled on AC power (screen can still turn off)." -ForegroundColor Green

# ---------------------------------------------------------------------------
Write-Step "6/7 Setting up auto-start (PM2)"
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    cmd /c "npm install -g pm2 pm2-windows-startup"
    if ($LASTEXITCODE -ne 0) { throw "Failed to install PM2." }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    cmd /c "pm2-startup install"
}
Push-Location $Root
cmd /c "pm2 delete clearpath-pos" *> $null
cmd /c "pm2 start server/index.js --name clearpath-pos --cwd `"$Root`""
if ($LASTEXITCODE -ne 0) { throw "Failed to start the app with PM2." }
cmd /c "pm2 save"
Pop-Location
Write-Host "Clear Path POS will now start automatically whenever this computer turns on." -ForegroundColor Green

# ---------------------------------------------------------------------------
Write-Step "7/7 Desktop shortcut and tablet address"
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
Set-Content -Path (Join-Path $desktop 'Clear Path POS.url') -Value "[InternetShortcut]`nURL=http://localhost:$port`n"

$ip = Get-LanIPv4
$tabletLines = @()
if ($ip) {
    $tabletLines += "On the tablet's browser, go to:"
    $tabletLines += "http://${ip}:${port}"
} else {
    $tabletLines += "Could not auto-detect this computer's network address."
    $tabletLines += "Run 'ipconfig' in Command Prompt and look for the IPv4 Address,"
    $tabletLines += "then use http://<that address>:$port on the tablet."
}
$instructions = @(
    "Clear Path POS - Tablet Setup"
    ""
) + $tabletLines + @(
    ""
    "On the tablet, Chrome/Edge -> menu -> 'Add to Home screen' makes it launch"
    "full-screen like an app."
    ""
    "If this stops working after a router restart, the address above may have"
    "changed. Double-click 'Show-Tablet-Address' in the app folder to check again,"
    "or ask your network admin for a fixed (reserved) IP for this computer."
)
$instructions -join "`r`n" | Set-Content -Path (Join-Path $desktop 'Clear Path POS - Tablet Setup.txt')

Write-Host ""
Write-Host "All done!" -ForegroundColor Green
Write-Host ($tabletLines -join ' ')

Show-Popup (($instructions | Select-Object -Skip 1) -join "`n") "Clear Path POS - Setup Complete"
Read-Host "Press Enter to close this window"
