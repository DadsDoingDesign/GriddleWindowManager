# Packaged-boot smoke (evals plan §1, docs/evals-plan.md).
#
# The one eval aimed at the DOA class: v0.1.0 and v0.2.0 both shipped unable
# to boot (the WebView2 browser-args invariant) with every unit suite green.
# This installs the real NSIS bundle, launches it, lets it soak past the
# brain-host watchdog window (90 s), and asserts the process survived and the
# log carries the boot markers and no ERROR lines.
#
# Usage (local, before tagging a release):
#   powershell -File scripts/boot-smoke.ps1
#   powershell -File scripts/boot-smoke.ps1 -InstallerPath <setup.exe> -KeepInstalled
#
# CI runs it via .github/workflows/boot-smoke.yml on a windows-latest runner.
# NOTE: this installs and launches the window manager on the machine that
# runs it — on a workstation, expect your windows to be managed for ~2 min.

param(
    # Defaults to the newest *-setup.exe under the release bundle dir.
    [string]$InstallerPath,
    # Long enough to cross the 90 s brain-host watchdog timeout: a boot whose
    # brain never heartbeats respawns (and logs) inside this window.
    [int]$SoakSeconds = 110,
    # Leave the app installed and running (local iteration).
    [switch]$KeepInstalled
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exeName = 'griddle-wm'
$logDir = Join-Path $env:APPDATA 'griddle-wm\logs'
$failures = @()

if (-not $InstallerPath) {
    $bundleDir = Join-Path $repo 'apps\desktop\src-tauri\target\release\bundle\nsis'
    $candidate = Get-ChildItem -Path $bundleDir -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) {
        Write-Error "No installer under $bundleDir - build one first (npm run tauri:build:local)."
    }
    $InstallerPath = $candidate.FullName
}
Write-Host "Installer: $InstallerPath"

# A still-running copy would make every assertion ambiguous.
Get-Process -Name $exeName -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Stopping running $exeName (pid $($_.Id)) before install"
    Stop-Process -Id $_.Id -Force
}
Start-Sleep -Seconds 2

# Baseline the log so only lines this boot appends are judged.
$logFile = Join-Path $logDir 'griddle-wm.log'
$baseline = 0
if (Test-Path $logFile) {
    $baseline = (Get-Content $logFile | Measure-Object -Line).Lines
}

# Silent per-user NSIS install.
Write-Host 'Installing silently...'
$install = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) {
    Write-Error "Installer exited $($install.ExitCode)"
}

# Tauri's currentUser NSIS installs under LOCALAPPDATA; find the exe rather
# than hardcoding the product-name path.
$exe = Get-ChildItem -Path $env:LOCALAPPDATA -Filter "$exeName.exe" -Recurse -Depth 3 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) {
    Write-Error "Installed $exeName.exe not found under $env:LOCALAPPDATA"
}
Write-Host "Installed exe: $($exe.FullName)"

Write-Host "Launching and soaking $SoakSeconds s (past the 90 s watchdog)..."
$proc = Start-Process -FilePath $exe.FullName -PassThru
Start-Sleep -Seconds $SoakSeconds

# 1. The process is alive after the soak.
$alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if (-not $alive) { $failures += 'process died during the soak' }

# 2. The log exists, carries the boot marker, and appended no ERROR lines
#    and no brain-host respawn (a respawn means the webviews never booted -
#    exactly the v0.1.0/v0.2.0 failure).
if (-not (Test-Path $logFile)) {
    $failures += "no log file at $logFile"
} else {
    $lines = @(Get-Content $logFile | Select-Object -Skip $baseline)
    Write-Host "Log appended $($lines.Count) line(s) during the soak."
    if (-not ($lines | Select-String -SimpleMatch 'tray icon created')) {
        $failures += 'boot marker missing: "tray icon created" never logged'
    }
    $errors = @($lines | Select-String '\bERROR\b')
    if ($errors.Count -gt 0) {
        $failures += "$($errors.Count) ERROR line(s):"
        $errors | Select-Object -First 5 | ForEach-Object { $failures += "  $_" }
    }
    if ($lines | Select-String -SimpleMatch 'brain host respawned') {
        $failures += 'the watchdog respawned the brain host - webviews failed to boot'
    }
}

if (-not $KeepInstalled) {
    if ($alive) { Stop-Process -Id $proc.Id -Force; Start-Sleep -Seconds 2 }
    $uninstall = Join-Path (Split-Path -Parent $exe.FullName) 'uninstall.exe'
    if (Test-Path $uninstall) {
        Write-Host 'Uninstalling...'
        Start-Process -FilePath $uninstall -ArgumentList '/S' -Wait
    }
}

if ($failures.Count -gt 0) {
    Write-Host "`nBOOT SMOKE FAILED:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "`nBOOT SMOKE PASSED: installed, booted, survived $SoakSeconds s with a clean log." -ForegroundColor Green
exit 0
