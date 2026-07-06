# Summarize Phase C all-dev retest: pool CSV since t0 + python_jobs.ndjson job counts.
# Example: powershell -NoProfile -File scripts\correlate_proc_retest.ps1

$ErrorActionPreference = "Stop"
$homeDir = Join-Path $env:USERPROFILE ".masonjar"
$t0Path = Join-Path $homeDir "proc_retest_t0.json"
$csvPath = Join-Path $homeDir "pool_leak_watch.csv"
$jobsPath = Join-Path $homeDir "python_jobs.ndjson"

if (-not (Test-Path $t0Path)) {
  Write-Host "Missing $t0Path - run record_proc_retest_t0.ps1 first"
  exit 1
}

$t0 = Get-Content $t0Path -Raw | ConvertFrom-Json
$t0Utc = [datetime]::Parse($t0.TimeUtc, $null, [Globalization.DateTimeStyles]::RoundtripKind)

Write-Host "=== Phase C all-dev retest summary ===" -ForegroundColor Cyan
Write-Host "t0: $($t0.TimeUtc)  Proc_MB=$($t0.Proc_MB)  Proc_out=$($t0.Proc_out)  fleet dev=$($t0.MasonJar_dev) release=$($t0.MasonJar_release)"

if (Test-Path $csvPath) {
  $rows = @(Import-Csv $csvPath | Where-Object {
    [datetime]::Parse($_.TimeUtc, $null, [Globalization.DateTimeStyles]::RoundtripKind) -ge $t0Utc
  })
  if ($rows.Count -ge 2) {
    $first = $rows[0]
    $last = $rows[-1]
    $dh = [double]$last.UptimeHours - [double]$first.UptimeHours
    $dProc = [int64]$last.Proc_out - [int64]$first.Proc_out
    $rate = if ($dh -gt 0) { [math]::Round($dProc / $dh, 0) } else { 0 }
    Write-Host ""
    Write-Host "Pool since t0: $($rows.Count) samples, span ${dh}h uptime"
    Write-Host "  Proc_MB: $($first.Proc_MB) -> $($last.Proc_MB)"
    Write-Host "  Proc_out: $($first.Proc_out) -> $($last.Proc_out)  delta $dProc"
    Write-Host "  Hourly Proc_out rate since t0: ~$rate/h  pre-mixed ref: $($t0.pre_retest_hourly_proc_delta_ref)/h"
    Write-Host "  Latest fleet: dev=$($last.MasonJar_dev) release=$($last.MasonJar_release) py_worker=$($last.Python_worker) py_shell=$($last.Python_shell)"
  } else {
    Write-Host ""
    Write-Host "Pool since t0: $($rows.Count) samples - need more hourly rows"
  }
}

if (Test-Path $jobsPath) {
  $starts = 0
  $worker = 0
  $shell = 0
  foreach ($line in Get-Content $jobsPath) {
    try {
      $e = $line | ConvertFrom-Json
    } catch {
      continue
    }
    if ($e.event -ne "start") { continue }
    $ts = [datetime]::Parse($e.ts, $null, [Globalization.DateTimeStyles]::RoundtripKind)
    if ($ts -lt $t0Utc) { continue }
    $starts++
    if ($e.via -eq "worker") { $worker++ }
    elseif ($e.via -eq "shell") { $shell++ }
  }
  Write-Host ""
  Write-Host "Python jobs since t0: starts=$starts  worker=$worker  shell=$shell"
}

Write-Host ""
Write-Host "Re-run after more hourly samples accumulate."
