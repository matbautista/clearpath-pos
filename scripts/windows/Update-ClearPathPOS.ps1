#requires -Version 5.1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# scripts\windows\Update-ClearPathPOS.ps1 -> project root is two levels up.
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$RepoUrl = 'https://github.com/matbautista/clearpath-pos.git'

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
    Write-Host "Update stopped because of a problem:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Nothing was left half-broken - your data/pos.db and .env were never touched. It's safe to fix the issue (e.g. check your internet connection) and run this updater again."
    Show-Popup "Update could not finish:`n`n$($_.Exception.Message)`n`nSee the black window for details. Your sales data was not touched - it's safe to run this updater again after fixing the issue." "Clear Path POS - Update Problem"
    Read-Host "Press Enter to close this window"
    exit 1
}

Write-Host "Clear Path POS - Windows Update" -ForegroundColor Green
Write-Host "Updating: $Root"
Write-Host "This pulls the latest code from GitHub and restarts the app. Your sales" -ForegroundColor Yellow
Write-Host "data (data\pos.db) and settings (.env) are never touched by this script." -ForegroundColor Yellow

# ---------------------------------------------------------------------------
Write-Step "1/5 Backing up your data first, just in case"
$dbPath = Join-Path $Root 'data\pos.db'
if (Test-Path $dbPath) {
    $backupDir = Join-Path $Root 'data\backups'
    if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
    Copy-Item $dbPath (Join-Path $backupDir "pos_pre-update_$stamp.db.bak")
    Write-Host "Backed up data\pos.db before updating." -ForegroundColor Green
} else {
    Write-Host "No data\pos.db found yet - nothing to back up." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
Write-Step "2/5 Checking for Git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git not found - downloading Git for Windows..."
    $gitApiUrl = 'https://api.github.com/repos/git-for-windows/git/releases/latest'
    $release = Invoke-RestMethod -Uri $gitApiUrl -Headers @{ 'User-Agent' = 'ClearPathPOS-Updater' }
    # Match the standard installer (e.g. "Git-2.47.0-64-bit.exe"), not the
    # PortableGit self-extracting archive, which also ends in "64-bit.exe".
    $asset = $release.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
    if (-not $asset) { throw "Could not find a Git for Windows installer to download. Install Git manually from https://git-scm.com/download/win and run this updater again." }
    $installerPath = Join-Path $env:TEMP 'clearpath-git-installer.exe'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installerPath
    Write-Host "Installing Git (silent)..."
    Start-Process $installerPath -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES' -Wait
    Remove-Item $installerPath -ErrorAction SilentlyContinue

    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git installed but isn't on PATH yet. Please restart this computer once, then run this updater again."
    }
    Write-Host "Git installed." -ForegroundColor Green
} else {
    Write-Host "Found Git - already good." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
Write-Step "3/5 Getting the latest code"
Push-Location $Root
if (-not (Test-Path (Join-Path $Root '.git'))) {
    # This copy of the app wasn't installed via "git clone" (e.g. it was set
    # up by copying the folder by hand) - turn it into one now, pointed at
    # the same GitHub repo, so this and future updates are a plain git pull.
    # Only files tracked in the repo get overwritten; data\pos.db, .env, and
    # node_modules stay exactly as they are (all three are gitignored).
    Write-Host "This install isn't set up with Git yet - doing that now (one-time)..."
    git init -q
    git checkout -q -b main
    git remote add origin $RepoUrl
    git fetch origin --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not reach GitHub. Check your internet connection and try again." }
    git reset --hard origin/main --quiet
    if ($LASTEXITCODE -ne 0) { throw "Failed to check out the latest code." }
    git branch --set-upstream-to=origin/main main --quiet
} else {
    git fetch origin --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not reach GitHub. Check your internet connection and try again." }
    git reset --hard origin/main --quiet
    if ($LASTEXITCODE -ne 0) { throw "Failed to update to the latest code." }
}
$version = (git rev-parse --short HEAD)
Write-Host "Now on the latest version ($version)." -ForegroundColor Green
Pop-Location

# ---------------------------------------------------------------------------
Write-Step "4/5 Updating app dependencies (this can take a few minutes)"
Push-Location $Root
cmd /c "npm install"
if ($LASTEXITCODE -ne 0) { throw "npm install failed. Check your internet connection and try again." }
Pop-Location

# ---------------------------------------------------------------------------
Write-Step "5/5 Restarting the app"
$pm2Running = $false
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    $pm2List = cmd /c "pm2 jlist" 2>$null
    if ($pm2List -match 'clearpath-pos') {
        cmd /c "pm2 restart clearpath-pos" | Out-Null
        if ($LASTEXITCODE -eq 0) { $pm2Running = $true }
    }
}
if ($pm2Running) {
    Write-Host "Restarted the clearpath-pos service - the update is now live." -ForegroundColor Green
} else {
    Write-Host "Could not find a running PM2 service named 'clearpath-pos'." -ForegroundColor Yellow
    Write-Host "If Clear Path POS is currently open in its own window, close that window" -ForegroundColor Yellow
    Write-Host "and reopen it (double-click the desktop shortcut) to pick up the update." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "All done!" -ForegroundColor Green
Show-Popup "Clear Path POS has been updated to the latest version ($version).`n`nYour sales data and settings were not touched.`n`nIf the app doesn't look updated on the tablet, refresh the page there." "Clear Path POS - Update Complete"
Read-Host "Press Enter to close this window"
