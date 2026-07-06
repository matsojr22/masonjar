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
		assert(!loaded.allow_prerelease, "default off");
		const saved = updateManager.saveUpdatePreferences(tmpHome, {
			allow_prerelease: true,
		});
		assert(saved.allow_prerelease, "saved on");
		const again = updateManager.loadUpdatePreferences(tmpHome);
		assert(again.allow_prerelease, "read back on");
	} finally {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	}
}

function testBuildApplySpawnCommand() {
	const spec = updateManager.buildApplySpawnCommand("C:\\Temp\\apply-update.ps1");
	assert(spec.command === "cmd.exe", "cmd spawn");
	assert(spec.args.includes("start"), "start via cmd");
	assert(spec.args.includes("powershell.exe"), "powershell in chain");
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
		const prepared = mgr.prepareWindowsApply();
		assert(prepared.ok, "prepare without pre-write lock");
		assert(!fs.existsSync(lockPath), "prepare does not write lock");

		updateManager.writeUpdateLock("6.0.4");
		assert(fs.existsSync(lockPath), "writeUpdateLock creates lock");
		updateManager.releaseUpdateLock();
		assert(!fs.existsSync(lockPath), "releaseUpdateLock clears lock");

		updateManager.writeUpdateLock("6.0.4");
		const staleTime = Date.now() - updateManager.UPDATE_LOCK_STALE_MS - 1000;
		fs.utimesSync(lockPath, staleTime / 1000, staleTime / 1000);
		assert(updateManager.clearStaleUpdateLock(), "clearStaleUpdateLock");
		assert(!fs.existsSync(lockPath), "stale lock removed");

		updateManager.writeUpdateLock("6.0.4");
		const orphanTime = Date.now() - 5000;
		fs.utimesSync(lockPath, orphanTime / 1000, orphanTime / 1000);
		assert(updateManager.clearOrphanUpdateLock(), "clearOrphanUpdateLock");
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
		);
		const ps1 = fs.readFileSync(scriptPath, "utf8");
		assert(ps1.indexOf("Win32_Process") >= 0, "CIM process wait");
		assert(ps1.indexOf("Merge-WithRetries") >= 0, "merge retries");
		assert(ps1.indexOf(".Path -eq") < 0, "no Get-Process Path filter");
		assert(ps1.indexOf("FallbackLogPath") >= 0, "fallback log");
	} finally {
		fs.rmSync(tmpHome, { recursive: true, force: true });
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
		{ pid: 100, exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe" },
		{ pid: 200, exePath: "C:\\Apps\\masonjar-win32-x64\\masonjar.exe" },
		{ pid: 300, exePath: "D:\\Other\\masonjar.exe" },
	];
	assert(
		updateManager.countOtherMasonJarInstancesFromList(list, 100, root) === 1,
		"counts same-install-root excluding self",
	);
	assert(
		updateManager.countOtherMasonJarInstancesFromList(list, 100, null) === 2,
		"without install root counts all other pids",
	);
	assert(
		updateManager.countOtherMasonJarInstancesFromList(list, 100, root) === 1,
		"ignores different install root",
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
	testIsMandatoryUpdateRequired();
	testCountOtherMasonJarInstancesFromList();
	console.log("test-update-manager: ok");
}

run();
