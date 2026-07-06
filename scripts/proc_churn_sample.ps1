# One-shot Mason Jar fleet + process churn snapshot for Proc leak attribution.
# Example: powershell -NoProfile -File scripts\proc_churn_sample.ps1
#          powershell -NoProfile -File scripts\proc_churn_sample.ps1 -CsvPath "$env:USERPROFILE\.masonjar\proc_churn_watch.csv"

param(
  [string]$CsvPath = "",
  [int]$SampleSec = 30
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$poolScript = Join-Path $PSScriptRoot "pool_leak_watch.ps1"

function Get-MasonJarFleet {
  $rows = @()
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(electron|masonjar)\.exe$' } |
    ForEach-Object {
      $cmd = [string]$_.CommandLine
      $build = "other"
      if ($_.Name -eq 'electron.exe' -and $cmd -match 'git\\masonjar\\node_modules\\electron') {
        $build = if ($cmd -match '--type=') { "dev-child" } else { "dev-main" }
      } elseif ($_.Name -eq 'masonjar.exe') {
        $build = if ($cmd -match '--type=') { "release-child" } else { "release-main" }
      }
      $rows += [pscustomobject]@{
        Pid = $_.ProcessId
        Name = $_.Name
        Build = $build
        SessionId = $_.SessionId
        Cmd = if ($cmd.Length -gt 120) { $cmd.Substring(0, 120) + "..." } else { $cmd }
      }
    }
  $rows
}

function Get-PythonChildren {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object {
      $cmd = [string]$_.CommandLine
      $kind = if ($cmd -match 'masonjar_worker\.py') { "worker" }
              elseif ($cmd -match '\\py\\') { "shell" }
              else { "other" }
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue
      [pscustomobject]@{
        Pid = $_.ProcessId
        ParentPid = $_.ParentProcessId
        ParentName = $parent.Name
        Kind = $kind
        Cmd = if ($cmd.Length -gt 100) { $cmd.Substring(0, 100) + "..." } else { $cmd }
      }
    }
}

Write-Host "=== Proc churn sample ($(Get-Date -Format o)) ===" -ForegroundColor Cyan

& $poolScript -Samples 1 | Out-Null

$p1 = (Get-Process -ErrorAction SilentlyContinue).Count
$h1 = [int]((Get-Process -ErrorAction SilentlyContinue | Measure-Object Handles -Sum).Sum)
Start-Sleep -Seconds $SampleSec
$p2 = (Get-Process -ErrorAction SilentlyContinue).Count
$h2 = [int]((Get-Process -ErrorAction SilentlyContinue | Measure-Object Handles -Sum).Sum)

Write-Host "`nProcess count delta in ${SampleSec}s: $($p2 - $p1)  handles delta: $($h2 - $h1)"

Write-Host "`n--- Mason Jar fleet ---" -ForegroundColor Yellow
Get-MasonJarFleet | Format-Table -AutoSize

Write-Host "--- Python processes ---" -ForegroundColor Yellow
Get-PythonChildren | Format-Table -AutoSize

$devMain = (Get-MasonJarFleet | Where-Object { $_.Build -eq 'dev-main' }).Count
$relMain = (Get-MasonJarFleet | Where-Object { $_.Build -eq 'release-main' }).Count
$workers = (Get-PythonChildren | Where-Object { $_.Kind -eq 'worker' }).Count
$shells = (Get-PythonChildren | Where-Object { $_.Kind -eq 'shell' }).Count

$row = [pscustomobject]@{
  TimeUtc = (Get-Date).ToUniversalTime().ToString('o')
  SampleSec = $SampleSec
  ProcessDelta = $p2 - $p1
  HandleDelta = $h2 - $h1
  MasonJar_dev = $devMain
  MasonJar_release = $relMain
  Python_worker = $workers
  Python_shell = $shells
}

if ($CsvPath -eq "") {
  $dir = Join-Path $env:USERPROFILE ".masonjar"
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $CsvPath = Join-Path $dir "proc_churn_watch.csv"
}

if (-not (Test-Path $CsvPath)) {
  $row | Export-Csv -Path $CsvPath -NoTypeInformation
} else {
  $row | Export-Csv -Path $CsvPath -NoTypeInformation -Append
}
Write-Host "`nAppended fleet row to $CsvPath"
