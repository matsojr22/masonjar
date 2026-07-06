# Record Phase C all-dev retest t0 and append baseline row to pool CSV.
# Example: powershell -NoProfile -File scripts\record_proc_retest_t0.ps1

$ErrorActionPreference = "Stop"
$watchScript = Join-Path $PSScriptRoot "pool_leak_watch.ps1"
$homeDir = Join-Path $env:USERPROFILE ".masonjar"
$csvPath = Join-Path $homeDir "pool_leak_watch.csv"
$t0Path = Join-Path $homeDir "proc_retest_t0.json"

if (-not (Test-Path $homeDir)) {
  New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
}

$tempCsv = Join-Path $env:TEMP "pool_t0_$([guid]::NewGuid().ToString('N')).csv"
& $watchScript -Samples 1 -CsvPath $tempCsv
$snap = Import-Csv $tempCsv | Select-Object -Last 1
Remove-Item $tempCsv -Force -ErrorAction SilentlyContinue

$t0 = [ordered]@{
  recorded_at_utc = (Get-Date).ToUniversalTime().ToString('o')
  note = "7-day gate t0: Mason Jar worker release (>=6.0.12); mixed fleet OK"
  TimeUtc = $snap.TimeUtc
  UptimeHours = [double]$snap.UptimeHours
  Proc_MB = [double]$snap.Proc_MB
  Proc_out = [int64]$snap.Proc_out
  Proc_allocs = [int64]$snap.Proc_allocs
  Proc_frees = [int64]$snap.Proc_frees
  Proc_free_pct = [double]$snap.Proc_free_pct
  MasonJar_dev = [int]$snap.MasonJar_dev
  MasonJar_release = [int]$snap.MasonJar_release
  Python_worker = [int]$snap.Python_worker
  Python_shell = [int]$snap.Python_shell
  pre_retest_hourly_proc_delta_ref = 2714
}
$t0 | ConvertTo-Json -Depth 4 | Set-Content -Path $t0Path -Encoding UTF8
Write-Host "Wrote $t0Path"

$snap | Add-Member -NotePropertyName RetestSegment -NotePropertyValue "all_dev_t0" -Force
if (Test-Path $csvPath) {
  $existing = Import-Csv $csvPath
  $merged = foreach ($r in $existing) {
    if ($null -eq $r.PSObject.Properties['MasonJar_dev']) {
      $r | Add-Member -NotePropertyName MasonJar_dev -NotePropertyValue '' -Force
      $r | Add-Member -NotePropertyName MasonJar_release -NotePropertyValue '' -Force
      $r | Add-Member -NotePropertyName Python_worker -NotePropertyValue '' -Force
      $r | Add-Member -NotePropertyName Python_shell -NotePropertyValue '' -Force
    }
    if ($null -eq $r.PSObject.Properties['RetestSegment']) {
      $r | Add-Member -NotePropertyName RetestSegment -NotePropertyValue 'pre_all_dev' -Force
    }
    $r
  }
  @($merged) + @($snap) | Export-Csv -Path $csvPath -NoTypeInformation
} else {
  $snap | Export-Csv -Path $csvPath -NoTypeInformation
}
Write-Host "Appended t0 row to $csvPath"
