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
	testApplyScriptContent();
	console.log("test-update-manager: ok");
}

run();
