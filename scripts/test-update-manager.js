"use strict";

const path = require("path");

const repoRoot = path.join(__dirname, "..");
const updateManager = require(path.join(repoRoot, "update_manager.js"));

function assert(cond, msg) {
	if (!cond) {
		throw new Error(msg);
	}
}

function testPickWindowsZipAsset() {
	const assets = [
		{
			name: "masonjar-win32-x64-6.0.0.zip",
			browser_download_url: "https://example.com/a.zip",
			size: 100,
		},
		{ name: "checksums.txt", browser_download_url: "https://example.com/c", size: 1 },
	];
	const picked = updateManager.pickWindowsZipAsset(assets, "6.0.0");
	assert(picked && picked.name === "masonjar-win32-x64-6.0.0.zip", "exact zip name");
	const fallback = updateManager.pickWindowsZipAsset(
		[{ name: "masonjar-win32-x64-6.0.1.zip", browser_download_url: "u", size: 1 }],
		"6.0.0",
	);
	assert(fallback && fallback.name.includes("masonjar-win32-x64"), "fallback zip");
}

function testCompareUpdateAvailable() {
	assert(updateManager.compareUpdateAvailable("5.0.10", "6.0.0"), "6 > 5");
	assert(!updateManager.compareUpdateAvailable("6.0.0", "6.0.0"), "equal");
	assert(!updateManager.compareUpdateAvailable("6.1.0", "6.0.0"), "no downgrade");
}

function testPickBestRelease() {
	const releases = [
		{
			tag_name: "v5.0.10",
			html_url: "https://github.com/a/r5",
			body: "",
			prerelease: false,
			draft: false,
			assets: [],
		},
		{
			tag_name: "v6.0.0-beta.1",
			html_url: "https://github.com/a/r6b",
			body: "",
			prerelease: true,
			draft: false,
			assets: [],
		},
		{
			tag_name: "v6.0.0",
			html_url: "https://github.com/a/r6",
			body: "",
			prerelease: false,
			draft: false,
			assets: [],
		},
		{
			tag_name: "v7.0.0-draft",
			html_url: "https://github.com/a/rd",
			body: "",
			prerelease: false,
			draft: true,
			assets: [],
		},
	];
	const best = updateManager.pickBestRelease(releases);
	assert(best && best.tag_name === "v6.0.0", "highest non-draft semver");
}

function testBuildCheckResult() {
	const release = {
		tag_name: "v6.0.0",
		html_url: "https://github.com/a/r6",
		body: "What's new\n\nMore text",
		prerelease: true,
		draft: false,
		assets: [
			{
				name: "masonjar-win32-x64-6.0.0.zip",
				browser_download_url: "https://example.com/a.zip",
				size: 100,
			},
		],
	};
	const result = updateManager.buildCheckResult("5.0.10", release);
	assert(result.updateAvailable, "update available");
	assert(result.latest === "6.0.0", "latest version");
	assert(result.isPrerelease, "prerelease flag");
	assert(result.windowsAsset != null, "windows asset");
	assert(
		result.releaseNotesExcerpt.indexOf("What's new") === 0,
		"notes excerpt first paragraph",
	);
}

function testReleaseNotesExcerpt() {
	const excerpt = updateManager.releaseNotesExcerpt("Line one\n\nLine two");
	assert(excerpt === "Line one", "first paragraph only");
}

function testExpectedWindowsZipName() {
	assert(
		updateManager.expectedWindowsZipName("6.0.0") ===
			"masonjar-win32-x64-6.0.0.zip",
		"zip naming",
	);
}

function testUpdatePreferencesRoundTrip() {
	const os = require("os");
	const fs = require("fs");
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mj-update-prefs-"));
	try {
		const loaded = updateManager.loadUpdatePreferences(tmpHome);
		assert(!loaded.allow_prerelease, "default prerelease off");
		assert(!loaded.keep_version_backups, "default backups off");
		const saved = updateManager.saveUpdatePreferences(tmpHome, {
			allow_prerelease: true,
			keep_version_backups: true,
		});
		assert(saved.allow_prerelease, "saved prerelease on");
		assert(saved.keep_version_backups, "saved backups on");
		const again = updateManager.loadUpdatePreferences(tmpHome);
		assert(again.allow_prerelease, "read back prerelease on");
		assert(again.keep_version_backups, "read back backups on");
		const partial = updateManager.saveUpdatePreferences(tmpHome, {
			allow_prerelease: false,
		});
		assert(!partial.allow_prerelease, "prerelease cleared");
		assert(partial.keep_version_backups, "backups preserved on partial save");
	} finally {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
}

function testBuildApplySpawnCommand() {
	const spec = updateManager.buildApplySpawnCommand("C:\\Temp\\apply-update.ps1");
	assert(spec.command === "cmd.exe", "cmd breakaway launcher");
	assert(spec.args[0] === "/c", "cmd /c");
	assert(spec.args.includes("start"), "start breakaway");
	assert(spec.args.includes("/b"), "start /b");
	assert(spec.args.includes("powershell.exe"), "powershell after start");
	assert(spec.args.includes("-File"), "file arg");
	assert(spec.args.includes("-WindowStyle"), "hidden window");
	assert(
		spec.args[spec.args.length - 1] === "C:\\Temp\\apply-update.ps1",
		"script path last arg",
	);
}

function testAppendUpdateLogLine() {
	const os = require("os");
	const fs = require("fs");
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mj-update-log-"));
	try {
		updateManager.appendUpdateLogLine(tmpHome, "test line");
		const logPath = updateManager.updateLogPath(tmpHome);
		assert(fs.existsSync(logPath), "log file created");
		const text = fs.readFileSync(logPath, "utf8");
		assert(text.indexOf("test line") >= 0, "log content");
	} finally {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
}

function testUpdateLockLifecycle() {
	const os = require("os");
	const fs = require("fs");
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mj-update-lock-"));
	const staging = path.join(tmpHome, "staging");
	fs.mkdirSync(staging, { recursive: true });
	fs.writeFileSync(path.join(staging, "masonjar.exe"), "");
	const lockPath = updateManager.updateLockPath();
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	try {
		const mgr = new updateManager.UpdateManager(tmpHome, "6.0.3", true);
		mgr.stagedExtractDir = staging;
		mgr.stagedVersion = "6.0.4";
		if (process.platform === "win32") {
			const prepared = mgr.prepareWindowsApply();
			assert(prepared.ok, "prepare without pre-write lock");
			assert(!fs.existsSync(lockPath), "prepare does not write lock");
		}

		updateManager.writeUpdateLock("6.0.4", {
			installRoot: "C:\\Apps\\masonjar",
		});
		assert(fs.existsSync(lockPath), "writeUpdateLock creates lock");
		const payload = updateManager.readUpdateLock();
		assert(payload && payload.version === "6.0.4", "readUpdateLock version");
		assert(
			payload.installRoot === "C:\\Apps\\masonjar",
			"readUpdateLock installRoot",
		);
		updateManager.releaseUpdateLock();
		assert(!fs.existsSync(lockPath), "releaseUpdateLock clears lock");

		// Fresh lock with no live apply is not "active" (no invisible timer).
		updateManager.writeUpdateLock("6.0.4");
		assert(
			!updateManager.isActiveUpdateLock("C:\\Apps\\masonjar"),
			"fresh lock without apply is not active",
		);

		updateManager.writeUpdateLock("6.0.4");
		const staleTime = Date.now() - updateManager.UPDATE_LOCK_STALE_MS - 1000;
		fs.utimesSync(lockPath, staleTime / 1000, staleTime / 1000);
		assert(updateManager.clearStaleUpdateLock(), "clearStaleUpdateLock");
		assert(!fs.existsSync(lockPath), "stale lock removed");

		// Fresh lock without applyPid must NOT be cleared as orphan (Settings open).
		updateManager.writeUpdateLock("6.0.4");
		const freshTime = Date.now() - 5000;
		fs.utimesSync(lockPath, freshTime / 1000, freshTime / 1000);
		assert(
			!updateManager.clearOrphanUpdateLock(),
			"fresh lock without dead applyPid is not orphan-cleared",
		);
		assert(fs.existsSync(lockPath), "fresh lock still present");

		// Dead applyPid + age past handoff window → clear orphan.
		updateManager.writeUpdateLock("6.0.4", { applyPid: 2147483000 });
		const orphanTime = Date.now() - 120_000;
		fs.utimesSync(lockPath, orphanTime / 1000, orphanTime / 1000);
		assert(
			updateManager.clearOrphanUpdateLock(),
			"clearOrphanUpdateLock for dead applyPid",
		);
		assert(!fs.existsSync(lockPath), "orphan lock removed");
	} finally {
		updateManager.releaseUpdateLock();
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
}

function testApplyScriptContent() {
	const os = require("os");
	const fs = require("fs");
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mj-update-script-"));
	const installRoot = path.join(tmpHome, "install");
	const staging = path.join(tmpHome, "staging");
	fs.mkdirSync(installRoot, { recursive: true });
	fs.mkdirSync(staging, { recursive: true });
	fs.writeFileSync(path.join(staging, "masonjar.exe"), "");
	try {
		const mgr = new updateManager.UpdateManager(tmpHome, "6.0.0", true);
		const scriptPath = mgr.writeApplyScript(
			installRoot,
			staging,
			"6.0.0",
			"6.0.2",
			false,
		);
		const ps1 = fs.readFileSync(scriptPath, "utf8");
		assert(ps1.indexOf("Win32_Process") >= 0, "CIM process wait");
		assert(ps1.indexOf("Merge-WithRetries") >= 0, "merge retries");
		assert(ps1.indexOf(".Path -eq") < 0, "no Get-Process Path filter");
		assert(ps1.indexOf("FallbackLogPath") >= 0, "fallback log");
		assert(ps1.indexOf("Assert-UpdatePaths") >= 0, "path preflight");
		assert(
			ps1.indexOf("still running after waiting 5 minutes") >= 0,
			"fail-closed wait",
		);
		assert(
			ps1.indexOf("Released update.lock before relaunch") >= 0,
			"clears lock before relaunch",
		);
		assert(ps1.indexOf("$KeepBackup = $false") >= 0, "backup off by default");
		assert(ps1.indexOf("$CleanInstall = $false") >= 0, "clean install off by default");
		assert(
			ps1.indexOf("$CleanInstall = $true") < 0,
			"default script does not clean-replace",
		);
		assert(
			ps1.indexOf("Skipping version backup") >= 0,
			"skip backup log when off",
		);
		assert(ps1.indexOf("Register-ApplyLock") >= 0, "lock rewrite helper");
		assert(ps1.indexOf("applyPid = $PID") >= 0, "lock uses PowerShell PID");
		assert(
			ps1.indexOf("Apply update process started pid=$PID") >= 0,
			"early survival log",
		);
		assert(ps1.indexOf("-PassThru") >= 0, "elevation PassThru");
		assert(
			ps1.indexOf("Elevated apply failed or was cancelled") >= 0,
			"elevation exit-code check",
		);
		assert(
			ps1.indexOf("Apply update failed:") >= 0,
			"clear failure logging",
		);
		assert(
			ps1.indexOf("resources\\app\\package.json") >= 0 ||
				ps1.indexOf("resources\\\\app\\\\package.json") >= 0,
			"verifies Electron resources/app/package.json",
		);
		assert(
			ps1.indexOf("Join-Path $InstallRoot 'resources") >= 0,
			"resolves app package.json via Join-Path",
		);
		assert(
			ps1.indexOf("checked resources") >= 0,
			"missing-pkg error mentions both candidate paths",
		);
		// Must not hard-code only installRoot/package.json as the sole verify path.
		assert(
			!/\$PkgPath = '[^']*package\.json'/.test(ps1) ||
				ps1.indexOf("resources") >= 0,
			"does not sole-bind root package.json as PkgPath",
		);

		const withBackup = mgr.writeApplyScript(
			installRoot,
			staging,
			"6.0.0",
			"6.0.2",
			true,
		);
		const ps1b = fs.readFileSync(withBackup, "utf8");
		assert(ps1b.indexOf("$KeepBackup = $true") >= 0, "backup on when requested");
		assert(ps1b.indexOf("Backing up to") >= 0, "backup robocopy path");
		assert(ps1b.indexOf("$CleanInstall = $false") >= 0, "backup script still merges");

		const cleanScript = mgr.writeApplyScript(
			installRoot,
			staging,
			"6.0.0",
			"8.0.0",
			false,
			true,
			0,
			1,
		);
		const ps1c = fs.readFileSync(cleanScript, "utf8");
		assert(ps1c.indexOf("$CleanInstall = $true") >= 0, "clean install flag on");
		assert(ps1c.indexOf("$InstalledEpoch = 0") >= 0, "installed epoch 0");
		assert(ps1c.indexOf("$StagedEpoch = 1") >= 0, "staged epoch 1");
		assert(
			ps1c.indexOf("replacing install folder") >= 0,
			"clean install log line",
		);
		assert(ps1c.indexOf(".clean-aside") >= 0, "aside folder name");
		assert(ps1c.indexOf("Move-Item") >= 0, "moves install children aside");
		assert(
			ps1c.indexOf("restoring previous install folder") >= 0,
			"restores aside on failure",
		);
		assert(ps1c.indexOf("/XJ") >= 0, "clean copy skips junctions");
		assert(ps1c.indexOf("Merge-WithRetries") >= 0, "merge path remains for other updates");

		const cleanBackup = mgr.writeApplyScript(
			installRoot,
			staging,
			"6.0.0",
			"8.0.0",
			true,
			true,
			0,
			1,
		);
		const ps1d = fs.readFileSync(cleanBackup, "utf8");
		assert(
			ps1d.indexOf("Keeping previous install as") >= 0,
			"clean install keeps aside as version backup",
		);
	} finally {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
}

function testCleanInstallEpoch() {
	const os = require("os");
	const fs = require("fs");
	assert(updateManager.normalizeCleanInstallEpoch(undefined) === 0, "missing is 0");
	assert(updateManager.normalizeCleanInstallEpoch(0) === 0, "zero is 0");
	assert(updateManager.normalizeCleanInstallEpoch(-3) === 0, "negative is 0");
	assert(updateManager.normalizeCleanInstallEpoch(1.9) === 1, "floor positive");
	assert(updateManager.normalizeCleanInstallEpoch("2") === 2, "numeric string");
	assert(updateManager.normalizeCleanInstallEpoch("nope") === 0, "bad string is 0");
	assert(
		updateManager.cleanInstallEpochFromPackage({}) === 0,
		"missing field is 0",
	);
	assert(
		updateManager.cleanInstallEpochFromPackage({ masonjarCleanInstallEpoch: 4 }) === 4,
		"reads field",
	);
	assert(!updateManager.shouldCleanInstall(0, 0), "equal epochs do not wipe");
	assert(!updateManager.shouldCleanInstall(1, 1), "same flag does not wipe");
	assert(updateManager.shouldCleanInstall(0, 1), "missing install epoch wipes once");
	assert(updateManager.shouldCleanInstall(1, 2), "greater epoch wipes");
	assert(!updateManager.shouldCleanInstall(2, 1), "older staged epoch does not wipe");

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-update-epoch-"));
	const installRoot = path.join(tmp, "install");
	const appPkg = path.join(installRoot, "resources", "app", "package.json");
	const rootPkg = path.join(installRoot, "package.json");
	fs.mkdirSync(path.dirname(appPkg), { recursive: true });
	try {
		assert(
			updateManager.readInstallCleanInstallEpoch(installRoot) === 0,
			"no package.json is epoch 0",
		);
		fs.writeFileSync(
			rootPkg,
			JSON.stringify({ version: "7.0.0", masonjarCleanInstallEpoch: 5 }),
		);
		assert(
			updateManager.readInstallCleanInstallEpoch(installRoot) === 5,
			"root shim used when app package.json is absent",
		);
		fs.writeFileSync(
			appPkg,
			JSON.stringify({ version: "7.0.0", masonjarCleanInstallEpoch: 2 }),
		);
		assert(
			updateManager.readInstallCleanInstallEpoch(installRoot) === 2,
			"resources/app/package.json wins over root shim",
		);
		fs.writeFileSync(appPkg, JSON.stringify({ version: "7.0.0" }));
		assert(
			updateManager.readInstallCleanInstallEpoch(installRoot) === 0,
			"present app package.json without the field is 0",
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function testVersionBackupHelpers() {
	const os = require("os");
	const fs = require("fs");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-update-bak-"));
	const installRoot = path.join(tmp, "masonjar-win32-x64-6.0.16");
	fs.mkdirSync(installRoot, { recursive: true });
	const bak1 = `${installRoot}.backup-6.0.15`;
	const bak2 = `${installRoot}.backup-6.0.14`;
	const decoy = path.join(tmp, "other.backup-6.0.15");
	fs.mkdirSync(bak1, { recursive: true });
	fs.mkdirSync(bak2, { recursive: true });
	fs.mkdirSync(decoy, { recursive: true });
	try {
		const listed = updateManager.listInstallVersionBackups(installRoot);
		assert(listed.length === 2, "lists two matching backups");
		assert(
			listed.every(function (p) {
				return p.indexOf("masonjar-win32-x64-6.0.16.backup-") >= 0;
			}),
			"only same install basename backups",
		);
		const del = updateManager.deleteInstallVersionBackups(installRoot);
		assert(del.ok, "delete ok");
		assert(del.deleted.length === 2, "deleted both");
		assert(
			updateManager.listInstallVersionBackups(installRoot).length === 0,
			"none left",
		);
		assert(fs.existsSync(decoy), "unrelated decoy kept");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function writePruneFixture(root, epoch) {
	const fs = require("fs");
	const path = require("path");
	fs.mkdirSync(path.join(root, "resources", "app"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "resources", "app", "package.json"),
		JSON.stringify({ version: "7.9.0", masonjarCleanInstallEpoch: epoch }),
	);
	fs.writeFileSync(path.join(root, "masonjar.exe"), "exe");
	fs.mkdirSync(path.join(root, "py"), { recursive: true });
	fs.writeFileSync(path.join(root, "py", "keep.py"), "keep");
	fs.writeFileSync(path.join(root, "py", "ancient.py"), "old");
	fs.mkdirSync(path.join(root, "oldtool"), { recursive: true });
	fs.writeFileSync(path.join(root, "oldtool", "dev.js"), "dev");
}

function testCleanInstallPrune() {
	const os = require("os");
	const fs = require("fs");
	const path = require("path");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-clean-prune-"));
	const installRoot = path.join(tmp, "install");
	const homeDir = path.join(tmp, "home");
	fs.mkdirSync(homeDir, { recursive: true });
	try {
		writePruneFixture(installRoot, 1);
		const missing = updateManager.runPackagedCleanInstallPrune({
			isPackaged: true,
			platform: "win32",
			installRoot: installRoot,
			homeDir: homeDir,
		});
		assert(missing.reason === "manifest-missing", "missing manifest skips");
		assert(!missing.markerWritten, "missing manifest does not set marker");
		assert(fs.existsSync(path.join(installRoot, "py", "ancient.py")), "extras kept without manifest");
		assert(
			updateManager.readCleanInstallEpochMarker(homeDir) === 0,
			"marker still 0",
		);

		fs.writeFileSync(
			path.join(installRoot, "clean-install-manifest.json"),
			JSON.stringify({
				files: [
					"masonjar.exe",
					"resources/app/package.json",
					"py",
					"py/keep.py",
					"clean-install-manifest.json",
				],
			}),
		);
		const pruned = updateManager.runPackagedCleanInstallPrune({
			isPackaged: true,
			platform: "win32",
			installRoot: installRoot,
			homeDir: homeDir,
		});
		assert(pruned.ran && pruned.markerWritten, "higher epoch prunes and marks");
		assert(!fs.existsSync(path.join(installRoot, "py", "ancient.py")), "ancient script removed");
		assert(!fs.existsSync(path.join(installRoot, "oldtool")), "empty leftover folder removed");
		assert(fs.existsSync(path.join(installRoot, "py", "keep.py")), "manifest file kept");
		assert(fs.existsSync(path.join(installRoot, "masonjar.exe")), "exe kept");
		assert(updateManager.readCleanInstallEpochMarker(homeDir) === 1, "marker is 1");

		fs.writeFileSync(path.join(installRoot, "py", "later.py"), "later");
		const again = updateManager.runPackagedCleanInstallPrune({
			isPackaged: true,
			platform: "win32",
			installRoot: installRoot,
			homeDir: homeDir,
		});
		assert(again.reason === "epoch-not-higher", "equal epoch does not prune");
		assert(fs.existsSync(path.join(installRoot, "py", "later.py")), "later file kept");

		const dev = updateManager.runPackagedCleanInstallPrune({
			isPackaged: false,
			platform: "win32",
			installRoot: installRoot,
			homeDir: homeDir,
		});
		assert(dev.reason === "not-packaged-windows", "unpackaged skipped");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function testCleanInstallManifestWriter() {
	const os = require("os");
	const fs = require("fs");
	const path = require("path");
	const buildRelease = require("./build-release");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-clean-manifest-"));
	try {
		const appFolder = path.join(tmp, "masonjar-win32-x64");
		fs.mkdirSync(path.join(appFolder, "resources", "app"), { recursive: true });
		fs.writeFileSync(path.join(appFolder, "masonjar.exe"), "exe");
		fs.writeFileSync(
			path.join(appFolder, "resources", "app", "package.json"),
			"{}",
		);
		buildRelease.writeCleanInstallManifest(appFolder);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(appFolder, "clean-install-manifest.json"), "utf8"),
		);
		assert(Array.isArray(manifest.files), "manifest files array");
		assert(manifest.files.indexOf("masonjar.exe") >= 0, "lists exe");
		assert(
			manifest.files.indexOf("resources/app/package.json") >= 0,
			"lists package.json",
		);
		assert(
			manifest.files.indexOf("clean-install-manifest.json") >= 0,
			"lists itself",
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function testIsMandatoryUpdateRequired() {
	const stableNewer = updateManager.buildCheckResult("6.0.13", {
		tag_name: "v6.0.14",
		html_url: "https://github.com/a/r",
		body: "",
		prerelease: false,
		draft: false,
		assets: [],
	});
	assert(
		updateManager.isMandatoryUpdateRequired("6.0.13", stableNewer),
		"stable newer requires mandatory update",
	);
	assert(
		!updateManager.isMandatoryUpdateRequired("6.0.14", stableNewer),
		"equal version not mandatory",
	);
	const prerelease = updateManager.buildCheckResult("6.0.13", {
		tag_name: "v6.0.14-beta",
		html_url: "https://github.com/a/r",
		body: "",
		prerelease: true,
		draft: false,
		assets: [],
	});
	assert(
		!updateManager.isMandatoryUpdateRequired("6.0.13", prerelease),
		"prerelease not mandatory",
	);
	const withError = Object.assign({}, stableNewer, { error: "offline" });
	assert(
		!updateManager.isMandatoryUpdateRequired("6.0.13", withError),
		"error skips mandatory",
	);
}

function testCountOtherMasonJarInstancesFromList() {
	const root = "C:\\Apps\\masonjar-win32-x64";
	const list = [
		{
			pid: 100,
			exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
			commandLine: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
		},
		{
			pid: 200,
			exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
			commandLine: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
		},
		{
			pid: 300,
			exePath: "D:\\Other\\masonjar.exe",
			commandLine: "D:\\Other\\masonjar.exe",
		},
	];
	assert(
		updateManager.countOtherMasonJarInstancesFromList(list, 100, root) === 1,
		"counts same-install-root excluding self",
	);
	assert(
		updateManager.countOtherMasonJarInstancesFromList(list, 100, null) === 2,
		"without install root counts all other mains",
	);
	assert(
		updateManager.countOtherMasonJarInstancesFromList(list, 100, root) === 1,
		"ignores different install root",
	);

	const withHelpers = [
		{
			pid: 100,
			exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
			commandLine: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
		},
		{
			pid: 101,
			exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
			commandLine:
				"C:\\Apps\\masonjar-win32-x64\\masonjar.exe --type=renderer --foo",
		},
		{
			pid: 102,
			exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
			commandLine:
				"C:\\Apps\\masonjar-win32-x64\\masonjar.exe --type=gpu-process",
		},
		{
			pid: 200,
			exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
			commandLine: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
		},
	];
	assert(
		updateManager.countOtherMasonJarInstancesFromList(withHelpers, 100, root) ===
			1,
		"ignores Electron --type= helpers; counts second main",
	);
	assert(
		updateManager.countOtherMasonJarInstancesFromList(
			[
				{
					pid: 100,
					exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
					commandLine: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe",
				},
				{ pid: 101, exePath: "", commandLine: "" },
			],
			100,
			root,
		) === 0,
		"empty path/cmdline does not count as peer",
	);
	assert(
		updateManager.isElectronHelperProcess({
			pid: 1,
			exePath: "x",
			commandLine: "masonjar.exe --type=utility",
		}),
		"detects --type= helper",
	);
}

function run() {
	testPickWindowsZipAsset();
	testCompareUpdateAvailable();
	testPickBestRelease();
	testBuildCheckResult();
	testReleaseNotesExcerpt();
	testExpectedWindowsZipName();
	testUpdatePreferencesRoundTrip();
	testBuildApplySpawnCommand();
	testAppendUpdateLogLine();
	testUpdateLockLifecycle();
	testApplyScriptContent();
	testCleanInstallEpoch();
	testCleanInstallPrune();
	testCleanInstallManifestWriter();
	testVersionBackupHelpers();
	testIsMandatoryUpdateRequired();
	testCountOtherMasonJarInstancesFromList();
	console.log("test-update-manager: ok");
}

run();
