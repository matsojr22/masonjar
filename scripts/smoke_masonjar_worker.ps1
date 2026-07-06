# Smoke-test masonjar_worker.py protocol (no Electron).
# Example: powershell -NoProfile -File scripts\smoke_masonjar_worker.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $repoRoot "py\masonjar_worker.py"
$py = Join-Path $env:USERPROFILE ".masonjar\benv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  $py = "python"
}

$env:PYTHONIOENCODING = "utf-8"
$payload = @(
  '{"cmd":"ping"}'
  '{"cmd":"run","id":"smoke1","script":"index_metadata.py","args":[],"env":{}}'
  '{"cmd":"shutdown"}'
) -join "`n"

$out = $payload | & $py -u $worker 2>&1
foreach ($line in $out) {
  Write-Host "stdout: $line"
}

$text = ($out | Out-String)
if ($text -notmatch '"type"\s*:\s*"ready"') { throw "worker did not emit ready" }
if ($text -notmatch '"type"\s*:\s*"pong"') { throw "ping/pong failed" }
if ($text -notmatch '"type"\s*:\s*"done"') { throw "index_metadata job did not finish" }
Write-Host "smoke_masonjar_worker: OK"
