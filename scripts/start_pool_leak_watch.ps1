# Start hourly pool_leak_watch in the background (append ~/.masonjar/pool_leak_watch.csv).
# Restarts any existing watcher so script updates (e.g. fleet columns) take effect.

$watchScript = Join-Path $PSScriptRoot "pool_leak_watch.ps1"
$csvPath = Join-Path $env:USERPROFILE ".masonjar\pool_leak_watch.csv"
$dir = Split-Path $csvPath -Parent
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'pool_leak_watch\.ps1' -and $_.CommandLine -notmatch 'start_pool_leak_watch' }
foreach ($p in $existing) {
  Write-Host "Stopping prior pool_leak_watch PID $($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

$args = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $watchScript,
  "-IntervalSec", "3600",
  "-Samples", "336",
  "-CsvPath", $csvPath
)

Start-Process -FilePath "powershell.exe" -ArgumentList $args -WindowStyle Hidden
Write-Host "Started hourly pool_leak_watch -> $csvPath"
