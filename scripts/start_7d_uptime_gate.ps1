# Start 7-day uptime gate: record t0, start hourly pool watch, print pass/fail criteria.
# Run once after deploying v6.0.12+ on KIM-SERVER (or any host under test).
# Example: powershell -NoProfile -File scripts\start_7d_uptime_gate.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$recordScript = Join-Path $PSScriptRoot "record_proc_retest_t0.ps1"
$startWatch = Join-Path $PSScriptRoot "start_pool_leak_watch.ps1"
$correlate = Join-Path $PSScriptRoot "correlate_proc_retest.ps1"
$homeDir = Join-Path $env:USERPROFILE ".masonjar"
$t0Path = Join-Path $homeDir "proc_retest_t0.json"

Write-Host "=== 7-day uptime gate (Mason Jar-only) ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Prerequisite: v6.0.12+ installed. Run scripts\verify_release_worker.ps1 first."
Write-Host ""

# Update t0 note for 6.0.12+ gate (record script writes t0.json + CSV row)
& $recordScript

# Patch t0 note if record script still has old text
if (Test-Path $t0Path) {
  $t0Obj = Get-Content $t0Path -Raw | ConvertFrom-Json
  $t0Hash = [ordered]@{}
  foreach ($p in $t0Obj.PSObject.Properties) {
    $t0Hash[$p.Name] = $p.Value
  }
  $t0Hash.note = "7-day gate t0: Mason Jar worker release (>=6.0.12); mixed fleet OK"
  $t0Hash.gate_version = "6.0.12+"
  $t0Hash.gate_pass_criteria = @{
    uptime_days = 7
    proc_hourly_rate_max = 1500
    proc_mb_at_7d_max = 400
    machine_usable = $true
  }
  $t0Hash | ConvertTo-Json -Depth 6 | Set-Content -Path $t0Path -Encoding UTF8
}

& $startWatch

Write-Host ""
Write-Host "Hourly CSV: $homeDir\pool_leak_watch.csv"
Write-Host ""
Write-Host "Pass criteria (after ~7 days uptime, normal lab use):"
Write-Host "  - Machine remains interactive (no 600-mile reboot trip)"
Write-Host "  - Proc_out hourly rate materially below ~2,714/h bad-boot reference"
Write-Host "  - Proc_MB at day 7 well below ~1,050 MB bad-boot reference"
Write-Host "  - python_jobs.ndjson: batch tools show via:worker"
Write-Host ""
Write-Host "Check progress anytime:"
Write-Host "  powershell -NoProfile -File `"$correlate`""
Write-Host ""
Write-Host "If gate FAILs: ship Phase F in-app hardening (6.0.13+). Never third-party license software."
