"use strict";

/**
 * Dropped into an old Mason Jar install and required from the top of main.js.
 * Uses only Node builtins. When MASONJAR_FORCE_UPDATE_AUTORUN=1, blocks on a
 * stable-release check and, if a newer Windows zip exists, downloads it and
 * hands replacement to a detached helper, then exits. Any failure returns so
 * the old app still opens.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const GITHUB_LATEST =
	"https://api.github.com/repos/matsojr22/masonjar/releases/latest";

function parseVer(value) {
	const match = String(value || "")
		.replace(/^v/i, "")
		.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `latest` is a higher major.minor.patch than `current`. */
function isNewerVersion(latest, current) {
	const next = parseVer(latest);
	const have = parseVer(current);
	if (!next || !have) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (next[i] > have[i]) {
			return true;
		}
		if (next[i] < have[i]) {
			return false;
		}
	}
	return false;
}

function isBelowMandatoryUpdate(version) {
	return isNewerVersion("6.0.14", version);
}

function pickWindowsZip(assets, version) {
	const list = Array.isArray(assets) ? assets : [];
	const expected = "masonjar-win32-x64-" + String(version || "").replace(/^v/i, "") + ".zip";
	const exact = list.find((asset) => asset && asset.name === expected);
	if (exact && exact.browser_download_url) {
		return exact;
	}
	return (
		list.find(
			(asset) =>
				asset &&
				asset.browser_download_url &&
				/^masonjar-win32-x64-.+\.zip$/i.test(String(asset.name || "")),
		) || null
	);
}

function psSingleQuote(value) {
	return "'" + String(value).replace(/'/g, "''") + "'";
}

function fetchLatestRelease() {
	const command = [
		"$ProgressPreference = 'SilentlyContinue'",
		"$headers = @{ 'User-Agent' = 'MasonJar-ForceUpdate'; 'Accept' = 'application/vnd.github+json' }",
		"$rel = Invoke-RestMethod -Headers $headers -Uri " + psSingleQuote(GITHUB_LATEST),
		"$rel | ConvertTo-Json -Depth 6 -Compress",
	].join("; ");
	const result = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", command],
		{ encoding: "utf8", timeout: 60000, windowsHide: true },
	);
	if (!result || result.status !== 0 || !result.stdout) {
		return null;
	}
	const text = String(result.stdout);
	const start = text.indexOf("{");
	if (start < 0) {
		return null;
	}
	try {
		return JSON.parse(text.slice(start));
	} catch (_err) {
		return null;
	}
}

function downloadZip(url, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const command = [
		"$ProgressPreference = 'SilentlyContinue'",
		"Invoke-WebRequest -Headers @{ 'User-Agent' = 'MasonJar-ForceUpdate' } -Uri " +
			psSingleQuote(url) +
			" -OutFile " +
			psSingleQuote(dest),
	].join("; ");
	const result = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", command],
		{ encoding: "utf8", timeout: 30 * 60 * 1000, windowsHide: true },
	);
	return !!(result && result.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0);
}

function writeApplier(installRoot, zipPath, pid) {
	const tempRoot = path.join(os.tmpdir(), "MasonJar", "force-update");
	fs.mkdirSync(tempRoot, { recursive: true });
	const scriptPath = path.join(tempRoot, "apply-" + String(pid) + ".ps1");
	const logPath = path.join(tempRoot, "apply.log");
	const extractDir = path.join(tempRoot, "extract-" + String(pid));
	const ps = [
		"$ErrorActionPreference = 'Stop'",
		"$InstallRoot = " + psSingleQuote(installRoot),
		"$ZipPath = " + psSingleQuote(zipPath),
		"$ExtractDir = " + psSingleQuote(extractDir),
		"$LogPath = " + psSingleQuote(logPath),
		"$WaitPid = " + String(pid),
		"function Write-ApplyLog([string]$Message) {",
		"  try { Add-Content -LiteralPath $LogPath -Value ('[' + (Get-Date -Format o) + '] ' + $Message) -Encoding UTF8 } catch {}",
		"}",
		"Write-ApplyLog ('waiting for pid ' + $WaitPid)",
		"$deadline = (Get-Date).AddMinutes(5)",
		"while (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {",
		"  if ((Get-Date) -gt $deadline) { Write-ApplyLog 'timeout waiting for exit'; exit 1 }",
		"  Start-Sleep -Milliseconds 400",
		"}",
		"Start-Sleep -Seconds 2",
		"if (Test-Path -LiteralPath $ExtractDir) { Remove-Item -LiteralPath $ExtractDir -Recurse -Force }",
		"New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null",
		"Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force",
		"$exe = Get-ChildItem -LiteralPath $ExtractDir -Filter masonjar.exe -Recurse -File | Select-Object -First 1",
		"if (-not $exe) { Write-ApplyLog 'zip has no masonjar.exe'; exit 1 }",
		"$source = $exe.Directory.FullName",
		"Write-ApplyLog ('robocopy ' + $source + ' -> ' + $InstallRoot)",
		"cmd /c robocopy \"$source\" \"$InstallRoot\" /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP /XJ",
		"$rc = $LASTEXITCODE",
		"if ($rc -ge 8) { Write-ApplyLog ('robocopy failed ' + $rc); exit 1 }",
		"$launch = Join-Path $InstallRoot 'masonjar.exe'",
		"if (-not (Test-Path -LiteralPath $launch)) { Write-ApplyLog 'replaced folder has no masonjar.exe'; exit 1 }",
		"Start-Process -FilePath $launch",
		"Write-ApplyLog 'relaunched'",
	].join("\r\n");
	fs.writeFileSync(scriptPath, ps, "utf8");
	const child = spawn(
		"powershell.exe",
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
		{ detached: true, stdio: "ignore", windowsHide: true },
	);
	child.unref();
}

function installRootFromAppDir(appDir) {
	return path.resolve(appDir, "..", "..");
}

function runForceUpdateBlocking() {
	if (process.platform !== "win32") {
		return;
	}
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
	} catch (_err) {
		return;
	}
	const current = String((pkg && pkg.version) || "");
	const release = fetchLatestRelease();
	if (!release || release.draft || release.prerelease) {
		return;
	}
	const tag = String(release.tag_name || "");
	const latest = tag.replace(/^v/i, "");
	if (!isNewerVersion(latest, current)) {
		return;
	}
	const asset = pickWindowsZip(release.assets, latest);
	if (!asset || !asset.browser_download_url) {
		return;
	}
	const installRoot = installRootFromAppDir(__dirname);
	if (!fs.existsSync(path.join(installRoot, "masonjar.exe"))) {
		return;
	}
	const zipPath = path.join(
		os.tmpdir(),
		"MasonJar",
		"force-update",
		String(asset.name),
	);
	if (!downloadZip(asset.browser_download_url, zipPath)) {
		return;
	}
	writeApplier(installRoot, zipPath, process.pid);
	process.exit(0);
}

if (process.env.MASONJAR_FORCE_UPDATE_AUTORUN === "1") {
	try {
		runForceUpdateBlocking();
	} catch (_err) {
		// Old app continues.
	}
}

module.exports = {
	parseVer,
	isNewerVersion,
	isBelowMandatoryUpdate,
	pickWindowsZip,
	installRootFromAppDir,
};
