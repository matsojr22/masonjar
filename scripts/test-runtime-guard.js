"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const installer = require(path.join(repoRoot, "runtime_guard_install.js"));

function assert(cond, msg) {
	if (!cond) {
		throw new Error(msg);
	}
}

function testSitePackagesWriter() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-guard-"));
	try {
		const benv = path.join(tmp, "benv");
		const site =
			process.platform === "win32"
				? path.join(benv, "Lib", "site-packages")
				: path.join(benv, "lib", "python3.10", "site-packages");
		fs.mkdirSync(site, { recursive: true });
		assert(installer.sitePackagesDir(benv) === site, "site-packages path");
		const source = path.join(repoRoot, "py", "masonjar_runtime_guard.py");
		const wrote = installer.installRuntimeGuard({
			benv: benv,
			guardSourcePath: source,
			electronPrefixes: ["C:/src/masonjar/node_modules/electron"],
		});
		assert(wrote, "guard install");
		assert(fs.existsSync(path.join(site, "sitecustomize.py")), "sitecustomize.py");
		assert(
			fs.existsSync(path.join(site, "masonjar_runtime_guard.py")),
			"guard module copied",
		);
		const text = fs.readFileSync(path.join(site, "sitecustomize.py"), "utf8");
		assert(text.indexOf("enforce_or_exit") >= 0, "sitecustomize calls the guard");
		assert(
			text.indexOf("node_modules") >= 0,
			"checkout electron prefix is embedded",
		);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function testAncestorAllow() {
	const py = [
		"import sys",
		"sys.path.insert(0, sys.argv[1])",
		"import masonjar_runtime_guard as g",
		"prefix = r'C:\\src\\masonjar\\node_modules\\electron'",
		"assert g.access_allowed([r'C:\\Apps\\Mason Jar\\masonjar.exe'])",
		"assert g.access_allowed([prefix + r'\\dist\\electron.exe'], [prefix])",
		"assert not g.access_allowed([r'C:\\PFA\\PFA Jar.exe'])",
		"assert not g.access_allowed([r'C:\\other\\electron.exe'], [prefix])",
		"assert not g.access_allowed([r'C:\\PFA\\PFA Jar.exe'], runtime_key='stolen')",
		"print('ok')",
	].join("\n");
	const pyDir = path.join(repoRoot, "py");
	const attempts = [
		["py", ["-3", "-c", py, pyDir]],
		["python", ["-c", py, pyDir]],
	];
	for (const attempt of attempts) {
		const result = spawnSync(attempt[0], attempt[1], { encoding: "utf8" });
		if (result.status === 0) {
			assert(result.stdout.indexOf("ok") >= 0, "ancestor checks");
			return;
		}
	}
	throw new Error("python is required to check the runtime guard");
}

testSitePackagesWriter();
testAncestorAllow();
console.log("test-runtime-guard: ok");
