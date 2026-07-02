"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateManager = exports.buildCheckResult = exports.expectedWindowsZipName = exports.resolveInstallRoot = exports.isUpdateInProgress = exports.buildApplySpawnCommand = exports.clearStaleUpdateLock = exports.isUpdateLockStale = exports.appendUpdateLogLine = exports.UPDATE_LOCK_STALE_MS = exports.updateFallbackLogPath = exports.updateLogPath = exports.updateLockPath = exports.masonJarTempRoot = exports.compareUpdateAvailable = exports.pickBestRelease = exports.releaseSemver = exports.pickWindowsZipAsset = exports.releaseNotesExcerpt = exports.saveUpdatePreferences = exports.loadUpdatePreferences = exports.updatePreferencesPath = exports.GITHUB_REPO = void 0;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const https_1 = __importDefault(require("https"));
const child_process_1 = require("child_process");
const semver = require("semver");
const serverFetch = require("node-fetch");
exports.GITHUB_REPO = "matsojr22/masonjar";
const DEFAULT_PREFS = { allow_prerelease: false };
function updatePreferencesPath(homeDir) {
    return path_1.default.join(homeDir, "update_preferences.json");
}
exports.updatePreferencesPath = updatePreferencesPath;
function loadUpdatePreferences(homeDir) {
    const filePath = updatePreferencesPath(homeDir);
    try {
        if (!fs_1.default.existsSync(filePath)) {
            return Object.assign({}, DEFAULT_PREFS);
        }
        const raw = JSON.parse(fs_1.default.readFileSync(filePath, "utf8"));
        return {
            allow_prerelease: !!raw.allow_prerelease,
        };
    }
    catch (_a) {
        return Object.assign({}, DEFAULT_PREFS);
    }
}
exports.loadUpdatePreferences = loadUpdatePreferences;
function saveUpdatePreferences(homeDir, patch) {
    const current = loadUpdatePreferences(homeDir);
    const next = {
        allow_prerelease: patch.allow_prerelease != null
            ? !!patch.allow_prerelease
            : current.allow_prerelease,
    };
    fs_1.default.mkdirSync(homeDir, { recursive: true });
    fs_1.default.writeFileSync(updatePreferencesPath(homeDir), JSON.stringify(next, null, 2));
    return next;
}
exports.saveUpdatePreferences = saveUpdatePreferences;
function releaseNotesExcerpt(body) {
    const text = String(body || "").trim();
    if (!text) {
        return "";
    }
    const paragraph = text.split(/\n\s*\n/)[0] || text;
    return paragraph.replace(/\r/g, "").trim().slice(0, 600);
}
exports.releaseNotesExcerpt = releaseNotesExcerpt;
function pickWindowsZipAsset(assets, version) {
    if (!assets || !assets.length) {
        return null;
    }
    const expected = `masonjar-win32-x64-${version}.zip`;
    const exact = assets.find((a) => a.name === expected);
    if (exact) {
        return exact;
    }
    const fallback = assets.find((a) => /^masonjar-win32-x64-.+\.zip$/i.test(a.name) &&
        a.browser_download_url);
    return fallback || null;
}
exports.pickWindowsZipAsset = pickWindowsZipAsset;
function releaseSemver(tag) {
    const cleaned = String(tag || "").replace(/^v/i, "");
    return semver.parse(cleaned) || semver.coerce(cleaned);
}
exports.releaseSemver = releaseSemver;
function pickBestRelease(releases) {
    let best = null;
    let bestVer = null;
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
exports.pickBestRelease = pickBestRelease;
function compareUpdateAvailable(currentVersion, latestVersion) {
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
exports.compareUpdateAvailable = compareUpdateAvailable;
function masonJarTempRoot() {
    return path_1.default.join(os_1.default.tmpdir(), "MasonJar");
}
exports.masonJarTempRoot = masonJarTempRoot;
function updateLockPath() {
    return path_1.default.join(masonJarTempRoot(), "update.lock");
}
exports.updateLockPath = updateLockPath;
function updateLogPath(homeDir) {
    return path_1.default.join(homeDir, "update.log");
}
exports.updateLogPath = updateLogPath;
function updateFallbackLogPath() {
    return path_1.default.join(masonJarTempRoot(), "update-fallback.log");
}
exports.updateFallbackLogPath = updateFallbackLogPath;
exports.UPDATE_LOCK_STALE_MS = 30 * 60 * 1000;
function appendUpdateLogLine(homeDir, message) {
    fs_1.default.mkdirSync(homeDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs_1.default.appendFileSync(updateLogPath(homeDir), line, "utf8");
}
exports.appendUpdateLogLine = appendUpdateLogLine;
function isUpdateLockStale(lockPath, maxAgeMs = exports.UPDATE_LOCK_STALE_MS) {
    try {
        if (!fs_1.default.existsSync(lockPath)) {
            return false;
        }
        const stat = fs_1.default.statSync(lockPath);
        return Date.now() - stat.mtimeMs > maxAgeMs;
    }
    catch (_a) {
        return true;
    }
}
exports.isUpdateLockStale = isUpdateLockStale;
function clearStaleUpdateLock() {
    const lockPath = updateLockPath();
    if (fs_1.default.existsSync(lockPath) && isUpdateLockStale(lockPath)) {
        fs_1.default.unlinkSync(lockPath);
        return true;
    }
    return false;
}
exports.clearStaleUpdateLock = clearStaleUpdateLock;
function buildApplySpawnCommand(scriptPath) {
    return {
        command: "cmd.exe",
        args: [
            "/c",
            "start",
            "",
            "/MIN",
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
        ],
    };
}
exports.buildApplySpawnCommand = buildApplySpawnCommand;
function isUpdateInProgress() {
    const lockPath = updateLockPath();
    return fs_1.default.existsSync(lockPath) && !isUpdateLockStale(lockPath);
}
exports.isUpdateInProgress = isUpdateInProgress;
function resolveInstallRoot(isPackaged) {
    if (!isPackaged) {
        return null;
    }
    return path_1.default.dirname(process.execPath);
}
exports.resolveInstallRoot = resolveInstallRoot;
function expectedWindowsZipName(version) {
    return `masonjar-win32-x64-${version}.zip`;
}
exports.expectedWindowsZipName = expectedWindowsZipName;
function githubHeaders(userAgent) {
    return {
        "User-Agent": userAgent,
        Accept: "application/vnd.github+json",
    };
}
function fetchJson(url, userAgent) {
    return __awaiter(this, void 0, void 0, function* () {
        const response = yield serverFetch(url, { headers: githubHeaders(userAgent) });
        if (!response.ok) {
            return { ok: false, status: response.status };
        }
        const data = (yield response.json());
        return { ok: true, status: response.status, data };
    });
}
function buildCheckResult(currentVersion, release) {
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
    const windowsAsset = latest != null ? pickWindowsZipAsset(release.assets, latest) : null;
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
exports.buildCheckResult = buildCheckResult;
class UpdateManager {
    constructor(homeDir, currentVersion, isPackaged) {
        this.homeDir = homeDir;
        this.currentVersion = currentVersion;
        this.isPackaged = isPackaged;
        this.cachedCheck = null;
        this.stagedVersion = null;
        this.stagedExtractDir = null;
        this.downloadInFlight = false;
    }
    getCachedCheck() {
        return this.cachedCheck;
    }
    setCachedCheck(result) {
        this.cachedCheck = result;
    }
    getPreferences() {
        return loadUpdatePreferences(this.homeDir);
    }
    savePreferences(patch) {
        return saveUpdatePreferences(this.homeDir, patch);
    }
    checkForUpdatesDetailed(allowPrerelease) {
        return __awaiter(this, void 0, void 0, function* () {
            const prefs = allowPrerelease != null
                ? { allow_prerelease: !!allowPrerelease }
                : this.getPreferences();
            const userAgent = `MasonJar/${this.currentVersion}`;
            try {
                let release = null;
                if (prefs.allow_prerelease) {
                    const url = `https://api.github.com/repos/${exports.GITHUB_REPO}/releases?per_page=30`;
                    const res = yield fetchJson(url, userAgent);
                    if (!res.ok) {
                        const err = Object.assign(Object.assign({}, buildCheckResult(this.currentVersion, null)), { error: `GitHub API returned ${res.status}` });
                        this.cachedCheck = err;
                        return err;
                    }
                    release = pickBestRelease(res.data || []);
                }
                else {
                    const url = `https://api.github.com/repos/${exports.GITHUB_REPO}/releases/latest`;
                    const res = yield fetchJson(url, userAgent);
                    if (res.status === 404) {
                        const empty = buildCheckResult(this.currentVersion, null);
                        this.cachedCheck = empty;
                        return empty;
                    }
                    if (!res.ok || !res.data) {
                        const err = Object.assign(Object.assign({}, buildCheckResult(this.currentVersion, null)), { error: `GitHub API returned ${res.status}` });
                        this.cachedCheck = err;
                        return err;
                    }
                    release = res.data;
                }
                const result = buildCheckResult(this.currentVersion, release);
                this.cachedCheck = result;
                return result;
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                const err = Object.assign(Object.assign({}, buildCheckResult(this.currentVersion, null)), { error: msg });
                this.cachedCheck = err;
                return err;
            }
        });
    }
    getApplyInfo() {
        const installRoot = resolveInstallRoot(this.isPackaged);
        return {
            canApplyInApp: this.isPackaged && process.platform === "win32" && !!installRoot,
            platform: process.platform,
            isPackaged: this.isPackaged,
            installRoot,
            logPath: updateLogPath(this.homeDir),
            stagingReady: !!this.stagedExtractDir && !!this.stagedVersion,
            stagedVersion: this.stagedVersion,
            updateInProgress: isUpdateInProgress() || this.downloadInFlight,
        };
    }
    updatesDir() {
        return path_1.default.join(masonJarTempRoot(), "updates");
    }
    zipPathForVersion(version) {
        return path_1.default.join(this.updatesDir(), `masonjar-${version}.zip`);
    }
    extractDirForVersion(version) {
        return path_1.default.join(this.updatesDir(), `extract-${version}`);
    }
    findStagedInstallFolder(extractDir) {
        const direct = path_1.default.join(extractDir, "masonjar-win32-x64");
        if (fs_1.default.existsSync(path_1.default.join(direct, "masonjar.exe"))) {
            return direct;
        }
        if (fs_1.default.existsSync(path_1.default.join(extractDir, "masonjar.exe"))) {
            return extractDir;
        }
        const entries = fs_1.default.readdirSync(extractDir, { withFileTypes: true });
        for (const ent of entries) {
            if (!ent.isDirectory()) {
                continue;
            }
            const candidate = path_1.default.join(extractDir, ent.name);
            if (fs_1.default.existsSync(path_1.default.join(candidate, "masonjar.exe"))) {
                return candidate;
            }
        }
        return null;
    }
    downloadWindowsUpdate(onProgress) {
        return __awaiter(this, void 0, void 0, function* () {
            if (process.platform !== "win32") {
                return { ok: false, error: "Windows-only download" };
            }
            if (this.downloadInFlight) {
                return { ok: false, error: "Download already in progress" };
            }
            const check = this.cachedCheck;
            if (!(check === null || check === void 0 ? void 0 : check.windowsAsset) || !check.latest) {
                return { ok: false, error: "No Windows update asset available" };
            }
            this.downloadInFlight = true;
            const version = check.latest;
            const zipPath = this.zipPathForVersion(version);
            const extractDir = this.extractDirForVersion(version);
            try {
                fs_1.default.mkdirSync(this.updatesDir(), { recursive: true });
                if (fs_1.default.existsSync(extractDir)) {
                    fs_1.default.rmSync(extractDir, { recursive: true, force: true });
                }
                onProgress(0, "Starting download…");
                yield this.streamDownload(check.windowsAsset.browser_download_url, zipPath, check.windowsAsset.size, onProgress);
                onProgress(95, "Extracting update…");
                yield this.extractZip(zipPath, extractDir);
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
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { ok: false, error: msg };
            }
            finally {
                this.downloadInFlight = false;
            }
        });
    }
    streamDownload(url, target, totalBytesHint, onProgress) {
        return new Promise((resolve, reject) => {
            const file = fs_1.default.createWriteStream(target, { highWaterMark: 64 * 1024 });
            const request = https_1.default.get(url, (response) => {
                if (response.statusCode &&
                    response.statusCode >= 300 &&
                    response.statusCode < 400 &&
                    response.headers.location) {
                    file.close();
                    fs_1.default.unlink(target, () => {
                        this.streamDownload(response.headers.location, target, totalBytesHint, onProgress)
                            .then(resolve)
                            .catch(reject);
                    });
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Download failed: HTTP ${response.statusCode}`));
                    return;
                }
                const totalBytes = parseInt(String(response.headers["content-length"] || "0"), 10) ||
                    totalBytesHint ||
                    0;
                let received = 0;
                let lastPct = -1;
                response.on("data", (chunk) => {
                    received += chunk.length;
                    if (totalBytes > 0) {
                        const pct = Math.min(90, Math.floor((received / totalBytes) * 90));
                        if (pct !== lastPct) {
                            lastPct = pct;
                            onProgress(pct, `Downloading… ${Math.round((received / totalBytes) * 100)}%`);
                        }
                    }
                    else {
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
                fs_1.default.unlink(target, () => reject(err));
            });
            file.on("error", (err) => {
                fs_1.default.unlink(target, () => reject(err));
            });
        });
    }
    extractZip(zipPath, extractDir) {
        fs_1.default.mkdirSync(extractDir, { recursive: true });
        const ps = [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
        ];
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)("powershell.exe", ps, { windowsHide: true });
            let stderr = "";
            child.stderr.on("data", (d) => {
                stderr += String(d);
            });
            child.on("error", reject);
            child.on("close", (code) => {
                if (code === 0) {
                    resolve();
                }
                else {
                    reject(new Error(stderr.trim() || `Expand-Archive exited ${code}`));
                }
            });
        });
    }
    writeApplyScript(installRoot, stagingDir, oldVersion, newVersion) {
        const scriptPath = path_1.default.join(masonJarTempRoot(), "apply-update.ps1");
        const logPath = updateLogPath(this.homeDir);
        const fallbackLogPath = updateFallbackLogPath();
        const backupDir = `${installRoot}.backup-${oldVersion}`;
        const exePath = path_1.default.join(installRoot, "masonjar.exe");
        const lockPath = updateLockPath();
        const pkgPath = path_1.default.join(installRoot, "package.json");
        const ps1 = `
$ErrorActionPreference = 'Stop'
$LogPath = '${logPath.replace(/'/g, "''")}'
$FallbackLogPath = '${fallbackLogPath.replace(/'/g, "''")}'
$InstallRoot = '${installRoot.replace(/'/g, "''")}'
$StagingDir = '${stagingDir.replace(/'/g, "''")}'
$BackupDir = '${backupDir.replace(/'/g, "''")}'
$ExePath = '${exePath.replace(/'/g, "''")}'
$LockPath = '${lockPath.replace(/'/g, "''")}'
$PkgPath = '${pkgPath.replace(/'/g, "''")}'
$TargetVersion = '${newVersion.replace(/'/g, "''")}'
$Elevated = $args -contains '-Elevated'

function Write-Log([string]$Message) {
  $line = "[$(Get-Date -Format o)] $Message"
  try {
    $parent = Split-Path -Parent $LogPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    try {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $FallbackLogPath) | Out-Null
      Add-Content -LiteralPath $FallbackLogPath -Value $line -Encoding UTF8
    } catch {
      # best-effort logging only
    }
  }
}

function Wait-InstallProcesses {
  $deadline = (Get-Date).AddMinutes(5)
  $warnedFallback = $false
  while ((Get-Date) -lt $deadline) {
    $procs = @()
    try {
      $procs = @(Get-CimInstance Win32_Process -Filter "Name='masonjar.exe'" -ErrorAction Stop |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $ExePath) })
    } catch {
      if (-not $warnedFallback) {
        Write-Log 'WARN: CIM process query failed; waiting on any masonjar process'
        $warnedFallback = $true
      }
      $procs = @(Get-Process -Name masonjar -ErrorAction SilentlyContinue)
    }
    if (-not $procs -or $procs.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  Start-Sleep -Seconds 2
}

function Invoke-RobocopyChecked([string]$Source, [string]$Dest, [string]$Label) {
  cmd /c robocopy "$Source" "$Dest" /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP
  $rc = $LASTEXITCODE
  Write-Log "$Label robocopy exit code $rc"
  if ($rc -ge 8) {
    throw "$Label robocopy failed with exit code $rc"
  }
}

function Merge-WithRetries {
  param([int]$MaxAttempts = 3)
  for ($i = 1; $i -le $MaxAttempts; $i++) {
    try {
      Write-Log "Merge attempt $i from $StagingDir"
      Invoke-RobocopyChecked -Source $StagingDir -Dest $InstallRoot -Label "merge"
      return
    } catch {
      Write-Log $_.Exception.Message
      if ($i -ge $MaxAttempts) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

try {
  Write-Log "Apply update started (elevated=$Elevated) ${oldVersion} -> ${newVersion}"
  Wait-InstallProcesses

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
  Invoke-RobocopyChecked -Source $InstallRoot -Dest $BackupDir -Label "backup"

  Merge-WithRetries

  if (Test-Path -LiteralPath $PkgPath) {
    $pkgText = Get-Content -LiteralPath $PkgPath -Raw
    if ($pkgText -notmatch ('"version"\\s*:\\s*"' + [regex]::Escape($TargetVersion) + '"')) {
      Write-Log "WARN: package.json after merge does not report version $TargetVersion"
    } else {
      Write-Log "Verified package.json version $TargetVersion"
    }
  }

  Write-Log 'Relaunching Mason Jar'
  try {
    Start-Process -FilePath $ExePath -WorkingDirectory $InstallRoot
    Write-Log 'Relaunch via Start-Process succeeded'
  } catch {
    Write-Log "Start-Process failed: $($_.Exception.Message); trying cmd start"
    cmd /c start "" "$ExePath"
    Write-Log 'Relaunch via cmd start invoked'
  }
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
        fs_1.default.mkdirSync(path_1.default.dirname(scriptPath), { recursive: true });
        fs_1.default.writeFileSync(scriptPath, ps1, "utf8");
        return scriptPath;
    }
    prepareWindowsApply() {
        if (!this.isPackaged || process.platform !== "win32") {
            return {
                ok: false,
                error: "In-app updates apply only to the packaged Windows app.",
            };
        }
        clearStaleUpdateLock();
        const lockPath = updateLockPath();
        if (fs_1.default.existsSync(lockPath)) {
            return { ok: false, error: "Another update is already in progress." };
        }
        const installRoot = resolveInstallRoot(this.isPackaged);
        if (!installRoot || !this.stagedExtractDir || !this.stagedVersion) {
            return { ok: false, error: "Download and extract an update first." };
        }
        if (!fs_1.default.existsSync(path_1.default.join(this.stagedExtractDir, "masonjar.exe"))) {
            return { ok: false, error: "Staged update is missing masonjar.exe." };
        }
        const scriptPath = this.writeApplyScript(installRoot, this.stagedExtractDir, this.currentVersion, this.stagedVersion);
        fs_1.default.mkdirSync(path_1.default.dirname(lockPath), { recursive: true });
        fs_1.default.writeFileSync(lockPath, JSON.stringify({
            started: new Date().toISOString(),
            version: this.stagedVersion,
        }));
        return { ok: true, scriptPath };
    }
    launchApplyAndQuit(scriptPath, quit) {
        const installRoot = resolveInstallRoot(this.isPackaged);
        appendUpdateLogLine(this.homeDir, `Preparing apply: script=${scriptPath} installRoot=${installRoot || "?"}`);
        appendUpdateLogLine(this.homeDir, `Fallback log path: ${updateFallbackLogPath()}`);
        return new Promise((resolve) => {
            const { command, args } = buildApplySpawnCommand(scriptPath);
            let settled = false;
            const finish = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(result);
            };
            try {
                const child = (0, child_process_1.spawn)(command, args, {
                    detached: true,
                    stdio: "ignore",
                    windowsHide: true,
                });
                child.on("error", (err) => {
                    appendUpdateLogLine(this.homeDir, `Spawn failed: ${err.message}`);
                    finish({ ok: false, error: err.message });
                });
                child.unref();
                if (!child.pid) {
                    appendUpdateLogLine(this.homeDir, "Spawn failed: no PID returned");
                    finish({ ok: false, error: "Failed to start updater process" });
                    return;
                }
                appendUpdateLogLine(this.homeDir, `Updater detached pid=${child.pid}`);
                setTimeout(() => {
                    if (settled) {
                        return;
                    }
                    quit();
                    finish({ ok: true });
                }, 400);
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                appendUpdateLogLine(this.homeDir, `Spawn exception: ${msg}`);
                finish({ ok: false, error: msg });
            }
        });
    }
    runWindowsUpdateNow(onProgress, quit) {
        return __awaiter(this, void 0, void 0, function* () {
            const download = yield this.downloadWindowsUpdate(onProgress);
            if (!download.ok) {
                return download;
            }
            onProgress(100, "Installing update…");
            const prepared = this.prepareWindowsApply();
            if (!prepared.ok) {
                return prepared;
            }
            return this.launchApplyAndQuit(prepared.scriptPath, quit);
        });
    }
}
exports.UpdateManager = UpdateManager;
