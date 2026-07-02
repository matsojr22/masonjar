import fs from "fs";
import os from "os";
import path from "path";
import https from "https";
import { spawn } from "child_process";

const semver = require("semver");
const serverFetch = require("node-fetch");

export const GITHUB_REPO = "matsojr22/masonjar";

export interface UpdatePreferences {
  allow_prerelease: boolean;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  assets: ReleaseAsset[];
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  current: string;
  latest: string | null;
  isPrerelease: boolean;
  releaseUrl: string | null;
  releaseNotesExcerpt: string;
  windowsAsset: ReleaseAsset | null;
  release: GitHubRelease | null;
  error?: string;
}

export interface UpdateApplyInfo {
  canApplyInApp: boolean;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  installRoot: string | null;
  logPath: string;
  stagingReady: boolean;
  stagedVersion: string | null;
  updateInProgress: boolean;
}

const DEFAULT_PREFS: UpdatePreferences = { allow_prerelease: false };

export function updatePreferencesPath(homeDir: string): string {
  return path.join(homeDir, "update_preferences.json");
}

export function loadUpdatePreferences(homeDir: string): UpdatePreferences {
  const filePath = updatePreferencesPath(homeDir);
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_PREFS };
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<UpdatePreferences>;
    return {
      allow_prerelease: !!raw.allow_prerelease,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveUpdatePreferences(
  homeDir: string,
  patch: Partial<UpdatePreferences>,
): UpdatePreferences {
  const current = loadUpdatePreferences(homeDir);
  const next: UpdatePreferences = {
    allow_prerelease:
      patch.allow_prerelease != null
        ? !!patch.allow_prerelease
        : current.allow_prerelease,
  };
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(updatePreferencesPath(homeDir), JSON.stringify(next, null, 2));
  return next;
}

export function releaseNotesExcerpt(body: string | null | undefined): string {
  const text = String(body || "").trim();
  if (!text) {
    return "";
  }
  const paragraph = text.split(/\n\s*\n/)[0] || text;
  return paragraph.replace(/\r/g, "").trim().slice(0, 600);
}

export function pickWindowsZipAsset(
  assets: ReleaseAsset[] | undefined,
  version: string,
): ReleaseAsset | null {
  if (!assets || !assets.length) {
    return null;
  }
  const expected = `masonjar-win32-x64-${version}.zip`;
  const exact = assets.find((a) => a.name === expected);
  if (exact) {
    return exact;
  }
  const fallback = assets.find(
    (a) =>
      /^masonjar-win32-x64-.+\.zip$/i.test(a.name) &&
      a.browser_download_url,
  );
  return fallback || null;
}

export function releaseSemver(tag: string): ReturnType<typeof semver.parse> {
  const cleaned = String(tag || "").replace(/^v/i, "");
  return semver.parse(cleaned) || semver.coerce(cleaned);
}

export function pickBestRelease(
  releases: GitHubRelease[],
): GitHubRelease | null {
  let best: GitHubRelease | null = null;
  let bestVer: ReturnType<typeof semver.parse> = null;
  for (const rel of releases) {
    if (rel.draft) {
      continue;
    }
    const parsed = releaseSemver(rel.tag_name);
    if (!parsed) {
      continue;
    }
    if (!bestVer || semver.gt(parsed, bestVer)) {
      best = rel;
      bestVer = parsed;
    }
  }
  return best;
}

export function compareUpdateAvailable(
  currentVersion: string,
  latestVersion: string | null,
): boolean {
  if (!latestVersion) {
    return false;
  }
  const current = semver.coerce(currentVersion);
  const latest = semver.coerce(latestVersion);
  if (!current || !latest) {
    return false;
  }
  return semver.gt(latest, current);
}

export function masonJarTempRoot(): string {
  return path.join(os.tmpdir(), "MasonJar");
}

export function updateLockPath(): string {
  return path.join(masonJarTempRoot(), "update.lock");
}

export function updateLogPath(homeDir: string): string {
  return path.join(homeDir, "update.log");
}

export function resolveInstallRoot(isPackaged: boolean): string | null {
  if (!isPackaged) {
    return null;
  }
  return path.dirname(process.execPath);
}

export function expectedWindowsZipName(version: string): string {
  return `masonjar-win32-x64-${version}.zip`;
}

function githubHeaders(userAgent: string): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: "application/vnd.github+json",
  };
}

async function fetchJson<T>(
  url: string,
  userAgent: string,
): Promise<{ ok: boolean; status: number; data?: T }> {
  const response = await serverFetch(url, { headers: githubHeaders(userAgent) });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const data = (await response.json()) as T;
  return { ok: true, status: response.status, data };
}

export function buildCheckResult(
  currentVersion: string,
  release: GitHubRelease | null,
): UpdateCheckResult {
  if (!release) {
    return {
      updateAvailable: false,
      current: currentVersion,
      latest: null,
      isPrerelease: false,
      releaseUrl: null,
      releaseNotesExcerpt: "",
      windowsAsset: null,
      release: null,
    };
  }
  const latestCoerced = semver.coerce(release.tag_name);
  const latest = latestCoerced ? latestCoerced.version : null;
  const windowsAsset =
    latest != null ? pickWindowsZipAsset(release.assets, latest) : null;
  return {
    updateAvailable: compareUpdateAvailable(currentVersion, latest),
    current: currentVersion,
    latest,
    isPrerelease: !!release.prerelease,
    releaseUrl: release.html_url || null,
    releaseNotesExcerpt: releaseNotesExcerpt(release.body),
    windowsAsset,
    release,
  };
}

export class UpdateManager {
  private cachedCheck: UpdateCheckResult | null = null;
  private stagedVersion: string | null = null;
  private stagedExtractDir: string | null = null;
  private downloadInFlight = false;

  constructor(
    private readonly homeDir: string,
    private readonly currentVersion: string,
    private readonly isPackaged: boolean,
  ) {}

  getCachedCheck(): UpdateCheckResult | null {
    return this.cachedCheck;
  }

  setCachedCheck(result: UpdateCheckResult | null): void {
    this.cachedCheck = result;
  }

  getPreferences(): UpdatePreferences {
    return loadUpdatePreferences(this.homeDir);
  }

  savePreferences(patch: Partial<UpdatePreferences>): UpdatePreferences {
    return saveUpdatePreferences(this.homeDir, patch);
  }

  async checkForUpdatesDetailed(
    allowPrerelease?: boolean,
  ): Promise<UpdateCheckResult> {
    const prefs =
      allowPrerelease != null
        ? { allow_prerelease: !!allowPrerelease }
        : this.getPreferences();
    const userAgent = `MasonJar/${this.currentVersion}`;

    try {
      let release: GitHubRelease | null = null;
      if (prefs.allow_prerelease) {
        const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
        const res = await fetchJson<GitHubRelease[]>(url, userAgent);
        if (!res.ok) {
          const err: UpdateCheckResult = {
            ...buildCheckResult(this.currentVersion, null),
            error: `GitHub API returned ${res.status}`,
          };
          this.cachedCheck = err;
          return err;
        }
        release = pickBestRelease(res.data || []);
      } else {
        const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
        const res = await fetchJson<GitHubRelease>(url, userAgent);
        if (res.status === 404) {
          const empty = buildCheckResult(this.currentVersion, null);
          this.cachedCheck = empty;
          return empty;
        }
        if (!res.ok || !res.data) {
          const err: UpdateCheckResult = {
            ...buildCheckResult(this.currentVersion, null),
            error: `GitHub API returned ${res.status}`,
          };
          this.cachedCheck = err;
          return err;
        }
        release = res.data;
      }

      const result = buildCheckResult(this.currentVersion, release);
      this.cachedCheck = result;
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const err: UpdateCheckResult = {
        ...buildCheckResult(this.currentVersion, null),
        error: msg,
      };
      this.cachedCheck = err;
      return err;
    }
  }

  getApplyInfo(): UpdateApplyInfo {
    const installRoot = resolveInstallRoot(this.isPackaged);
    return {
      canApplyInApp:
        this.isPackaged && process.platform === "win32" && !!installRoot,
      platform: process.platform,
      isPackaged: this.isPackaged,
      installRoot,
      logPath: updateLogPath(this.homeDir),
      stagingReady: !!this.stagedExtractDir && !!this.stagedVersion,
      stagedVersion: this.stagedVersion,
      updateInProgress: fs.existsSync(updateLockPath()) || this.downloadInFlight,
    };
  }

  private updatesDir(): string {
    return path.join(masonJarTempRoot(), "updates");
  }

  private zipPathForVersion(version: string): string {
    return path.join(this.updatesDir(), `masonjar-${version}.zip`);
  }

  private extractDirForVersion(version: string): string {
    return path.join(this.updatesDir(), `extract-${version}`);
  }

  findStagedInstallFolder(extractDir: string): string | null {
    const direct = path.join(extractDir, "masonjar-win32-x64");
    if (fs.existsSync(path.join(direct, "masonjar.exe"))) {
      return direct;
    }
    if (fs.existsSync(path.join(extractDir, "masonjar.exe"))) {
      return extractDir;
    }
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) {
        continue;
      }
      const candidate = path.join(extractDir, ent.name);
      if (fs.existsSync(path.join(candidate, "masonjar.exe"))) {
        return candidate;
      }
    }
    return null;
  }

  async downloadWindowsUpdate(
    onProgress: (percent: number, message: string) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== "win32") {
      return { ok: false, error: "Windows-only download" };
    }
    if (this.downloadInFlight) {
      return { ok: false, error: "Download already in progress" };
    }
    const check = this.cachedCheck;
    if (!check?.windowsAsset || !check.latest) {
      return { ok: false, error: "No Windows update asset available" };
    }

    this.downloadInFlight = true;
    const version = check.latest;
    const zipPath = this.zipPathForVersion(version);
    const extractDir = this.extractDirForVersion(version);

    try {
      fs.mkdirSync(this.updatesDir(), { recursive: true });
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }

      onProgress(0, "Starting download…");
      await this.streamDownload(
        check.windowsAsset.browser_download_url,
        zipPath,
        check.windowsAsset.size,
        onProgress,
      );

      onProgress(95, "Extracting update…");
      await this.extractZip(zipPath, extractDir);

      const staged = this.findStagedInstallFolder(extractDir);
      if (!staged) {
        return {
          ok: false,
          error: "Extracted package does not contain masonjar.exe",
        };
      }

      this.stagedVersion = version;
      this.stagedExtractDir = staged;
      onProgress(100, "Ready to install");
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: msg };
    } finally {
      this.downloadInFlight = false;
    }
  }

  private streamDownload(
    url: string,
    target: string,
    totalBytesHint: number,
    onProgress: (percent: number, message: string) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(target, { highWaterMark: 64 * 1024 });
      const request = https.get(url, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          file.close();
          fs.unlink(target, () => {
            this.streamDownload(
              response.headers.location as string,
              target,
              totalBytesHint,
              onProgress,
            )
              .then(resolve)
              .catch(reject);
          });
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }
        const totalBytes =
          parseInt(String(response.headers["content-length"] || "0"), 10) ||
          totalBytesHint ||
          0;
        let received = 0;
        let lastPct = -1;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.min(90, Math.floor((received / totalBytes) * 90));
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress(
                pct,
                `Downloading… ${Math.round((received / totalBytes) * 100)}%`,
              );
            }
          } else {
            onProgress(10, `Downloading… ${Math.round(received / 1024 / 1024)} MB`);
          }
        });
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      });
      request.on("error", (err) => {
        fs.unlink(target, () => reject(err));
      });
      file.on("error", (err) => {
        fs.unlink(target, () => reject(err));
      });
    });
  }

  private extractZip(zipPath: string, extractDir: string): Promise<void> {
    fs.mkdirSync(extractDir, { recursive: true });
    const ps = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ps, { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `Expand-Archive exited ${code}`));
        }
      });
    });
  }

  writeApplyScript(
    installRoot: string,
    stagingDir: string,
    oldVersion: string,
    newVersion: string,
  ): string {
    const scriptPath = path.join(masonJarTempRoot(), "apply-update.ps1");
    const logPath = updateLogPath(this.homeDir);
    const backupDir = `${installRoot}.backup-${oldVersion}`;
    const exePath = path.join(installRoot, "masonjar.exe");
    const lockPath = updateLockPath();

    const ps1 = `
$ErrorActionPreference = 'Stop'
$LogPath = '${logPath.replace(/'/g, "''")}'
$InstallRoot = '${installRoot.replace(/'/g, "''")}'
$StagingDir = '${stagingDir.replace(/'/g, "''")}'
$BackupDir = '${backupDir.replace(/'/g, "''")}'
$ExePath = '${exePath.replace(/'/g, "''")}'
$LockPath = '${lockPath.replace(/'/g, "''")}'
$Elevated = $args -contains '-Elevated'

function Write-Log([string]$Message) {
  $line = "[$(Get-Date -Format o)] $Message"
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
  Write-Log "Apply update started (elevated=$Elevated) ${oldVersion} -> ${newVersion}"

  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $deadline) {
    $running = Get-Process -Name masonjar -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ExePath }
    if (-not $running) { break }
    Start-Sleep -Milliseconds 500
  }

  if (-not $Elevated) {
    $probe = Join-Path $InstallRoot '.masonjar_update_write_probe'
    $needsElevation = $false
    try {
      Set-Content -LiteralPath $probe -Value 'ok' -Encoding ASCII -ErrorAction Stop
      Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    } catch {
      $needsElevation = $true
    }
    if ($needsElevation) {
      Write-Log 'Install folder not writable; requesting elevation'
      Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', $MyInvocation.MyCommand.Path, '-Elevated') -Wait
      exit 0
    }
  }

  if (Test-Path -LiteralPath $BackupDir) {
    Remove-Item -LiteralPath $BackupDir -Recurse -Force
  }
  Write-Log "Backing up to $BackupDir"
  robocopy $InstallRoot $BackupDir /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null

  Write-Log "Merging staged files from $StagingDir"
  $rc = 0
  cmd /c robocopy "$StagingDir" "$InstallRoot" /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    throw "robocopy failed with exit code $rc"
  }

  Write-Log 'Relaunching Mason Jar'
  Start-Process -FilePath $ExePath -WorkingDirectory $InstallRoot
  Write-Log 'Apply update finished successfully'
} catch {
  Write-Log "Apply update failed: $($_.Exception.Message)"
  exit 1
} finally {
  if (Test-Path -LiteralPath $LockPath) {
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  }
}
`.trim();

    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, ps1, "utf8");
    return scriptPath;
  }

  prepareWindowsApply(): { ok: boolean; error?: string; scriptPath?: string } {
    if (!this.isPackaged || process.platform !== "win32") {
      return {
        ok: false,
        error: "In-app updates apply only to the packaged Windows app.",
      };
    }
    if (fs.existsSync(updateLockPath())) {
      return { ok: false, error: "Another update is already in progress." };
    }
    const installRoot = resolveInstallRoot(this.isPackaged);
    if (!installRoot || !this.stagedExtractDir || !this.stagedVersion) {
      return { ok: false, error: "Download and extract an update first." };
    }
    if (!fs.existsSync(path.join(this.stagedExtractDir, "masonjar.exe"))) {
      return { ok: false, error: "Staged update is missing masonjar.exe." };
    }

    const scriptPath = this.writeApplyScript(
      installRoot,
      this.stagedExtractDir,
      this.currentVersion,
      this.stagedVersion,
    );
    fs.mkdirSync(path.dirname(updateLockPath()), { recursive: true });
    fs.writeFileSync(
      updateLockPath(),
      JSON.stringify({
        started: new Date().toISOString(),
        version: this.stagedVersion,
      }),
    );
    return { ok: true, scriptPath };
  }

  launchApplyAndQuit(scriptPath: string, quit: () => void): void {
    spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        scriptPath,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    ).unref();
    quit();
  }
}
