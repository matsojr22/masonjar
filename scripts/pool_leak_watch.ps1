# Track nonpaged pool tags that accumulate across multi-day RDP uptime.
# Run elevated or as a normal user (NtQuerySystemInformation works either way).
# Example: powershell -NoProfile -File scripts\pool_leak_watch.ps1
#          powershell -NoProfile -File scripts\pool_leak_watch.ps1 -IntervalSec 60 -Samples 120

param(
  [int]$IntervalSec = 0,
  [int]$Samples = 1,
  [string]$CsvPath = ""
)

$watch = @('Proc', 'MiP2', 'PsIn', 'Thre', 'File', 'Even', 'FMsc', 'Toke', 'NxRx', 'cxbm', 'sshl', 'NVRM', 'smSt')

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class PoolWatch {
  [StructLayout(LayoutKind.Sequential)]
  public struct TagInfo {
    public uint Tag;
    public uint PagedAllocs;
    public uint PagedFrees;
    public UIntPtr PagedUsed;
    public uint NonPagedAllocs;
    public uint NonPagedFrees;
    public UIntPtr NonPagedUsed;
  }

  [DllImport("ntdll.dll")]
  public static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int returnLength);

  static string TagName(uint tag) {
    var b = BitConverter.GetBytes(tag);
    var sb = new StringBuilder(4);
    for (int i = 0; i < 4; i++) {
      char c = (char)b[i];
      sb.Append(char.IsControl(c) || c > 126 ? '.' : c);
    }
    return sb.ToString();
  }

  public static Dictionary<string, TagInfo> Snapshot() {
    int len = 0;
    NtQuerySystemInformation(22, IntPtr.Zero, 0, out len);
    len = Math.Max(len, 256 * 1024);
    IntPtr buf = Marshal.AllocHGlobal(len + 4096);
    try {
      int status = NtQuerySystemInformation(22, buf, len + 4096, out len);
      if (status != 0) throw new Exception(string.Format("NtQuerySystemInformation 0x{0:X8}", status));
      int count = Marshal.ReadInt32(buf);
      int stride = Marshal.SizeOf(typeof(TagInfo));
      var map = new Dictionary<string, TagInfo>(StringComparer.Ordinal);
      for (int i = 0; i < count; i++) {
        var t = Marshal.PtrToStructure<TagInfo>(IntPtr.Add(buf, IntPtr.Size + i * stride));
        map[TagName(t.Tag)] = t;
      }
      return map;
    } finally {
      Marshal.FreeHGlobal(buf);
    }
  }
}
'@

Add-Type -TypeDefinition $cs -ErrorAction Stop

function Get-FleetCounts {
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(electron|masonjar)\.exe$' -or $_.Name -eq 'python.exe' }
  $devMain = 0
  $releaseMain = 0
  $pythonWorker = 0
  $pythonShell = 0
  foreach ($p in $procs) {
    $cmd = [string]$p.CommandLine
    if ($p.Name -eq 'electron.exe') {
      if ($cmd -match 'git\\masonjar\\node_modules\\electron' -and $cmd -notmatch '--type=') {
        $devMain++
      }
    } elseif ($p.Name -eq 'masonjar.exe') {
      # Ignore zombie PIDs (empty CommandLine) left after release was killed
      if ($cmd.Length -gt 0 -and $cmd -notmatch '--type=') {
        $releaseMain++
      }
    } elseif ($p.Name -eq 'python.exe') {
      if ($cmd -match 'masonjar_worker\.py') {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
        $pname = [string]$parent.Name
        # Count one worker per dev main (electron-spawned benv chain only)
        if ($pname -eq 'electron.exe') {
          $pythonWorker++
        }
      } elseif ($cmd -match '\\py\\[^\\]+\.py' -and $cmd -notmatch 'masonjar_worker\.py') {
        $pythonShell++
      }
    }
  }
  [ordered]@{
    MasonJar_dev     = $devMain
    MasonJar_release = $releaseMain
    Python_worker    = $pythonWorker
    Python_shell     = $pythonShell
  }
}

function Get-Row {
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
  $np = (Get-Counter '\Memory\Pool Nonpaged Bytes').CounterSamples[0].CookedValue
  $map = [PoolWatch]::Snapshot()
  $row = [ordered]@{
    TimeUtc     = (Get-Date).ToUniversalTime().ToString('o')
    UptimeHours = [math]::Round(((Get-Date) - $boot).TotalHours, 2)
    Processes   = (Get-Process).Count
    Handles     = [int]((Get-Process | Measure-Object Handles -Sum).Sum)
    NonpagedGB  = [math]::Round($np / 1GB, 3)
  }
  foreach ($name in $watch) {
    if ($map.ContainsKey($name)) {
      $t = $map[$name]
      $out = [int64]$t.NonPagedAllocs - [int64]$t.NonPagedFrees
      $row["${name}_MB"] = [math]::Round($t.NonPagedUsed.ToUInt64() / 1MB, 1)
      $row["${name}_out"] = $out
      $row["${name}_allocs"] = [int64]$t.NonPagedAllocs
      $row["${name}_frees"] = [int64]$t.NonPagedFrees
    } else {
      $row["${name}_MB"] = 0
      $row["${name}_out"] = 0
      $row["${name}_allocs"] = 0
      $row["${name}_frees"] = 0
    }
  }
  # Leak signal: allocs almost never freed
  $procFrees = [int64]$row['Proc_frees']
  $procAllocs = [int64]$row['Proc_allocs']
  $row['Proc_free_pct'] = if ($procAllocs -gt 0) { [math]::Round(100.0 * $procFrees / $procAllocs, 4) } else { 0 }
  foreach ($kv in (Get-FleetCounts).GetEnumerator()) {
    $row[$kv.Key] = $kv.Value
  }
  [pscustomobject]$row
}

function Write-Report($row) {
  Write-Host ("{0}  uptime={1}h  procs={2}  handles={3}  nonpaged={4}GB" -f $row.TimeUtc, $row.UptimeHours, $row.Processes, $row.Handles, $row.NonpagedGB)
  Write-Host ("  Proc  {0,8} MB  outstanding={1,9}  allocs={2}  frees={3}  free%={4}" -f $row.Proc_MB, $row.Proc_out, $row.Proc_allocs, $row.Proc_frees, $row.Proc_free_pct)
  Write-Host ("  MiP2  {0,8} MB  outstanding={1,9}" -f $row.MiP2_MB, $row.MiP2_out)
  Write-Host ("  File  {0,8} MB  outstanding={1,9}" -f $row.File_MB, $row.File_out)
  Write-Host ("  FMsc  {0,8} MB  outstanding={1,9}" -f $row.FMsc_MB, $row.FMsc_out)
  if ($null -ne $row.MasonJar_dev) {
    Write-Host ("  fleet dev={0} release={1} py_worker={2} py_shell={3}" -f $row.MasonJar_dev, $row.MasonJar_release, $row.Python_worker, $row.Python_shell)
  }
  if ($row.Proc_free_pct -lt 1.0 -and $row.Proc_allocs -gt 1000) {
    Write-Host "  *** LEAK SIGNATURE: Proc frees are near-zero (process objects not being destroyed) ***" -ForegroundColor Yellow
  }
}

if ($CsvPath -eq "" -and $Samples -gt 1) {
  $homeCsv = Join-Path $env:USERPROFILE ".masonjar\pool_leak_watch.csv"
  $CsvPath = $homeCsv
}

$n = [Math]::Max(1, $Samples)
for ($i = 0; $i -lt $n; $i++) {
  $row = Get-Row
  Write-Report $row
  if ($CsvPath) {
    if ($i -eq 0 -or -not (Test-Path $CsvPath)) {
      $row | Export-Csv -Path $CsvPath -NoTypeInformation
    } else {
      $row | Export-Csv -Path $CsvPath -NoTypeInformation -Append
    }
    Write-Host "  wrote $CsvPath"
  }
  if ($i -lt $n - 1 -and $IntervalSec -gt 0) {
    Start-Sleep -Seconds $IntervalSec
  }
}
