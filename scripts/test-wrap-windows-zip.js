#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { unzipSync } = require("cross-zip");
const { wrapWindowsReleaseZipFile } = require("./build-release");

function fail(msg) {
	console.error("test-wrap-windows-zip.js: FAIL —", msg);
	process.exit(1);
}

function ok(msg) {
	console.log("test-wrap-windows-zip.js: OK —", msg);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-wrap-test-"));
try {
	const flat = path.join(tmp, "flat");
	fs.mkdirSync(flat, { recursive: true });
	fs.writeFileSync(path.join(flat, "masonjar.exe"), "fake");
	const zipPath = path.join(tmp, "masonjar-win32-x64-9.9.9.zip");
	const flatPs = flat.replace(/'/g, "''");
	const zipPs = zipPath.replace(/'/g, "''");
	const mk = spawnSync(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-Command",
			"Get-ChildItem -LiteralPath '" +
				flatPs +
				"' | Compress-Archive -DestinationPath '" +
				zipPs +
				"' -Force",
		],
		{ stdio: "inherit" },
	);
	if (mk.status !== 0) {
		fail("could not create flat test zip");
	}

	wrapWindowsReleaseZipFile(zipPath, "9.9.9");

	const verifyDir = path.join(tmp, "verify");
	fs.mkdirSync(verifyDir, { recursive: true });
	unzipSync(zipPath, verifyDir);
	const top = fs.readdirSync(verifyDir);
	if (top.length !== 1 || top[0] !== "masonjar-win32-x64") {
		fail("expected single top-level masonjar-win32-x64/, got: " + top.join(", "));
	}
	if (!fs.existsSync(path.join(verifyDir, "masonjar-win32-x64", "masonjar.exe"))) {
		fail("masonjar.exe missing inside wrapper folder");
	}

	ok("Windows release zip wraps app in masonjar-win32-x64/");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
