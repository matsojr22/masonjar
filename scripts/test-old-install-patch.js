"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const patcher = require(path.join(repoRoot, "old_install_patch.js"));
const forceUpdate = require(path.join(repoRoot, "masonjar_force_update.js"));

function assert(cond, msg) {
	if (!cond) {
		throw new Error(msg);
	}
}

function testVersions() {
	assert(forceUpdate.isNewerVersion("8.0.2", "8.0.1"), "8.0.2 is newer");
	assert(!forceUpdate.isNewerVersion("8.0.1", "8.0.1"), "equal is not newer");
	assert(!forceUpdate.isNewerVersion("6.0.0", "8.0.1"), "no downgrade");
	assert(patcher.isBelowMandatoryUpdate("6.0.13"), "6.0.13 is before mandatory");
	assert(!patcher.isBelowMandatoryUpdate("6.0.14"), "6.0.14 already forces update");
	assert(!patcher.isBelowMandatoryUpdate("8.0.1"), "current is not armed");
	const asset = forceUpdate.pickWindowsZip(
		[
			{ name: "notes.txt", browser_download_url: "https://example/n" },
			{
				name: "masonjar-win32-x64-8.0.2.zip",
				browser_download_url: "https://example/z",
			},
		],
		"8.0.2",
	);
	assert(asset && asset.name.indexOf("8.0.2") >= 0, "picks windows zip");
}

function makeInstall(root, version, name, productName, mainJs) {
	const appDir = path.join(root, "resources", "app");
	fs.mkdirSync(appDir, { recursive: true });
	fs.writeFileSync(path.join(root, "masonjar.exe"), "", "utf8");
	fs.writeFileSync(
		path.join(appDir, "package.json"),
		JSON.stringify({
			name: name,
			productName: productName,
			version: version,
		}),
		"utf8",
	);
	fs.writeFileSync(path.join(appDir, "main.js"), mainJs || "console.log('old');\n", "utf8");
}

function testIdentityAndArm() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-old-install-"));
	const bootstrap = path.join(tmp, "masonjar_force_update.js");
	fs.writeFileSync(bootstrap, "module.exports = {};\n", "utf8");
	try {
		const oldRoot = path.join(tmp, "Downloads", "masonjar-win32-x64");
		makeInstall(oldRoot, "5.4.0", "masonjar", "Mason Jar");
		const currentRoot = path.join(tmp, "Desktop", "current");
		makeInstall(currentRoot, "8.0.2", "masonjar", "Mason Jar");
		const pfaRoot = path.join(tmp, "Documents", "pfa");
		makeInstall(pfaRoot, "1.0.1", "pfajar", "PFA Jar");
		const mandatoryRoot = path.join(tmp, "Documents", "nested", "mandatory");
		makeInstall(mandatoryRoot, "6.0.14", "masonjar", "Mason Jar");

		const oldId = patcher.readInstallIdentity(oldRoot);
		assert(oldId && oldId.version === "5.4.0", "reads version");
		assert(
			patcher.shouldArmInstall(oldId, currentRoot, "console.log('old');\n"),
			"old mason jar is armed",
		);
		assert(
			!patcher.shouldArmInstall(
				patcher.readInstallIdentity(currentRoot),
				currentRoot,
				"",
			),
			"running install is skipped",
		);
		assert(
			!patcher.shouldArmInstall(patcher.readInstallIdentity(pfaRoot), null, ""),
			"pfajar is skipped",
		);
		assert(
			!patcher.shouldArmInstall(
				patcher.readInstallIdentity(mandatoryRoot),
				null,
				"",
			),
			"6.0.14 is skipped",
		);

		const found = patcher.findMasonJarInstalls([
			path.join(tmp, "Desktop"),
			path.join(tmp, "Downloads"),
			path.join(tmp, "Documents"),
		]);
		assert(found.length === 4, "finds four install folders, got " + found.length);

		assert(patcher.armInstall(oldRoot, bootstrap), "first arm writes bootstrap");
		const mainJs = fs.readFileSync(
			path.join(oldRoot, "resources", "app", "main.js"),
			"utf8",
		);
		assert(mainJs.indexOf(patcher.BOOTSTRAP_MARKER) === 0, "marker is first");
		assert(
			fs.existsSync(path.join(oldRoot, "resources", "app", "main.js.bak-force-update")),
			"backup kept",
		);
		assert(
			fs.existsSync(path.join(oldRoot, "resources", "app", "masonjar_force_update.js")),
			"bootstrap copied",
		);
		assert(!patcher.armInstall(oldRoot, bootstrap), "second arm is a no-op");
		assert(
			!patcher.shouldArmInstall(oldId, null, mainJs),
			"already armed is skipped",
		);
		assert(patcher.tracePathForVersion("8.0.2"), "8.0.2 writes a trace path");
		assert(!patcher.tracePathForVersion("8.0.3"), "later versions do not trace");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

testVersions();
testIdentityAndArm();
console.log("test-old-install-patch: ok");
