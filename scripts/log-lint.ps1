# Log-lint (evals plan §4, docs/evals-plan.md).
#
# Turns the field logs into a regression gate: the 2026-08-21/22 log reviews
# each found a real shipped bug by reading %APPDATA%\griddle-wm\logs by hand
# (the elevated-window fight, the 0x0 moves). This automates that reading -
# run it after a dogfooding session, or point it at a log folder a user sent.
#
#   powershell -File scripts/log-lint.ps1              # last 3 days
#   powershell -File scripts/log-lint.ps1 -Days 0      # all history
#   powershell -File scripts/log-lint.ps1 -LogDir <folder>
#
# Exit 1 when a hard rule breaks; the table always prints. The default
# window is 3 days because the log keeps months of history and already-fixed
# bugs must not fail the gate forever (first run, 2026-08-31: 975 of the
# 1244 all-time ERROR lines predated the fixes that closed them).

param(
    [string]$LogDir = (Join-Path $env:APPDATA 'griddle-wm\logs'),
    # Only lines stamped within this many days count; 0 = all history.
    [int]$Days = 3
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $LogDir)) {
    Write-Error "No log folder at $LogDir"
}
$files = Get-ChildItem -Path $LogDir -Filter '*.log*' -File
if ($files.Count -eq 0) {
    Write-Error "No log files under $LogDir"
}
$lines = $files | Get-Content
$window = 'all history'
if ($Days -gt 0) {
    $cutoff = (Get-Date).Date.AddDays(1 - $Days)
    $lines = @($lines | Where-Object {
        $_ -match '^\[(\d{4}-\d{2}-\d{2})\]' -and [datetime]$matches[1] -ge $cutoff
    })
    $window = "since $($cutoff.ToString('yyyy-MM-dd'))"
}
Write-Host ("Linting {0} file(s), {1} line(s) from {2} ({3})`n" -f $files.Count, $lines.Count, $LogDir, $window)

# Each rule: a pattern, what it means, and the count above which it fails.
# Thresholds are deliberate:
#   - errors and respawns are always defects;
#   - "declined"/"not in live set" happen legitimately in small numbers
#     (windows dying mid-action) but a burst means brain/tracker drift;
#   - repeated windows-snap suppression writes are the WM_SETTINGCHANGE
#     storm the OS-sync idempotence rule exists to prevent.
$rules = @(
    # Updater network failures are environmental (offline at check time),
    # carved out of the hard ERROR budget into their own count.
    @{ Name = 'ERROR lines';                Pattern = '\bERROR\b';                          Exclude = 'tauri_plugin_updater'; FailOver = 0 },
    @{ Name = 'updater network errors';     Pattern = 'failed to check for updates';        FailOver = 999999 },
    @{ Name = 'brain host respawns';        Pattern = 'brain host respawned';               FailOver = 0 },
    @{ Name = 'SetWindowPos failures';      Pattern = 'SetWindowPos failed';                FailOver = 0 },
    @{ Name = 'ShowWindowAsync declined';   Pattern = 'ShowWindowAsync declined';           FailOver = 5 },
    @{ Name = 'not-in-live-set skips';      Pattern = 'not in live eligible set, skipping'; FailOver = 50 },
    # Boot-time "suppressing" is one legitimate write per launch; only the
    # drift-driven re-apply indicates a WM_SETTINGCHANGE storm.
    @{ Name = 'windows-snap re-applies';    Pattern = 're-applying suppression';            FailOver = 5 },
    @{ Name = 'maximized-apply races';      Pattern = 'is maximized, skipping';             FailOver = 200 },
    @{ Name = 'malformed hwnd inputs';      Pattern = 'malformed hwnd';                     FailOver = 0 }
)

$failed = $false
$width = ($rules.Name | Measure-Object -Maximum -Property Length).Maximum
foreach ($rule in $rules) {
    $hits = @($lines | Select-String -Pattern $rule.Pattern)
    if ($rule.Exclude) {
        $hits = @($hits | Where-Object { $_.Line -notmatch $rule.Exclude })
    }
    $status = if ($hits.Count -gt $rule.FailOver) { $failed = $true; 'FAIL' }
              elseif ($hits.Count -gt 0)          { 'note' }
              else                                { 'ok  ' }
    Write-Host ("  [{0}] {1}  {2}  (allowed: <= {3})" -f $status, $rule.Name.PadRight($width), $hits.Count, $rule.FailOver)
    if ($status -eq 'FAIL') {
        $hits | Select-Object -First 3 | ForEach-Object { Write-Host ("         e.g. {0}" -f $_.Line.Trim()) }
    }
}

if ($failed) {
    Write-Host "`nLOG LINT FAILED - the lines above are worth a read before shipping." -ForegroundColor Red
    exit 1
}
Write-Host "`nLOG LINT PASSED." -ForegroundColor Green
exit 0
