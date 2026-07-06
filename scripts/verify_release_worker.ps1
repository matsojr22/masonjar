# Verify Mason Jar worker release is installed and batch jobs use via:worker.
# Run after deploying v6.0.12+ from GitHub releases.
# Example: powershell -NoProfile -File scripts\verify_release_worker.ps1

$ErrorActionPreference = "Stop"
$homeDir = Join-Path $env:USERPROFILE ".masonjar"
$jobsPath = Join-Path $homeDir "python_jobs.ndjson"

Write-Host "=== Mason Jar worker deploy verification ===" -ForegroundColor Cyan

# 1. Mason Jar processes
$mj = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'masonjar|electron' -and $_.CommandLine -match 'masonjar' })
Write-Host ""
Write-Host "Mason Jar / Electron instances: $($mj.Count)"
foreach ($p in $mj) {
  $cl = $p.CommandLine
  if ($cl.Length -gt 120) { $cl = $cl.Substring(0, 117) + "..." }
  Write-Host "  PID $($p.ProcessId): $cl"
}

# 2. Python worker vs shell PIDs (benv python running masonjar_worker.py)
$pyWorker = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'masonjar_worker\.py' })
$pyShell = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -match '\\benv\\Scripts\\python' -and
    $_.CommandLine -notmatch 'masonjar_worker\.py' -and
    ($_.CommandLine -match 'map\.py|adjust\.py|max\.py|find_neurons\.py|czi_')
  })
Write-Host ""
Write-Host "Python worker processes: $($pyWorker.Count)"
Write-Host "Python one-shot shell processes (pipeline): $($pyShell.Count)"

# 3. Job log — recent starts
Write-Host ""
if (-not (Test-Path $jobsPath)) {
  Write-Host "WARN: No job log yet at $jobsPath" -ForegroundColor Yellow
  Write-Host "  Open Mason Jar, run any batch tool (e.g. max projection on one slice), re-run this script."
  exit 1
}

$lines = @(Get-Content $jobsPath -ErrorAction SilentlyContinue | Select-Object -Last 200)
$starts = @()
foreach ($line in $lines) {
  try {
    $e = $line | ConvertFrom-Json
  } catch {
    continue
  }
  if ($e.event -eq "start") { $starts += $e }
}

if ($starts.Count -eq 0) {
  Write-Host "WARN: Job log exists but no recent starts in last 200 lines." -ForegroundColor Yellow
  Write-Host "  Run a batch tool, then re-run this script."
  exit 1
}

$worker = @($starts | Where-Object { $_.via -eq "worker" }).Count
$shell = @($starts | Where-Object { $_.via -eq "shell" }).Count
$gui = @($starts | Where-Object { $_.gui -eq $true }).Count

Write-Host "Recent job starts (last 200 log lines): worker=$worker shell=$shell gui=$gui"
$last = $starts[-1]
Write-Host "  Last start: $($last.script) via=$($last.via) build=$($last.build)"

$batchScripts = @(
  "max.py", "find_neurons.py", "region.py", "czi_extract.py", "index_metadata.py"
)
$batchStarts = @($starts | Where-Object { $batchScripts -contains $_.script })
$batchWorker = @($batchStarts | Where-Object { $_.via -eq "worker" }).Count

Write-Host ""
if ($batchStarts.Count -gt 0 -and $batchWorker -eq $batchStarts.Count) {
  Write-Host "PASS: All recent batch-tool starts used worker." -ForegroundColor Green
} elseif ($batchStarts.Count -eq 0) {
  Write-Host "WARN: No batch-tool jobs in recent log — run max/detect/CZI to confirm worker." -ForegroundColor Yellow
  exit 1
} else {
  Write-Host "FAIL: Some batch jobs used shell instead of worker." -ForegroundColor Red
  Write-Host "  Check MASONJAR_PYTHON_WORKER=0 is not set; confirm v6.0.12+ installed."
  exit 1
}

Write-Host ""
Write-Host "Next: scripts\start_7d_uptime_gate.ps1 for hourly Proc monitoring."
