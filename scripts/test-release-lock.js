"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const rl = require(path.join(repoRoot, "release_lock.js"));
const pack = require("./release_lock_pack");

function assert(cond, msg) {
	if (!cond) {
		throw new Error(msg);
	}
}

function keyRec(id) {
	return { id: id, key: crypto.randomBytes(32).toString("base64") };
}

function testRoundTrip() {
	const mat = { current: keyRec("current"), previous: [] };
	const blob = rl.encryptJson(mat.current, { allow_prerelease: true, n: 1 });
	const decoded = rl.decryptJson(mat, blob);
	assert(decoded && decoded.value.allow_prerelease === true, "round trip value");
	assert(decoded.keyId === "current", "round trip key id");
	const wrong = rl.decryptJson({ current: keyRec("other"), previous: [] }, blob);
	assert(wrong === null, "other key cannot decrypt");
}

function testRotationAndDerivedPath() {
	const oldKey = keyRec("old");
	const newKey = keyRec("new");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "mj-lock-"));
	try {
		const oldMat = { current: oldKey, previous: [] };
		rl.writeSettings(home, "io_fairshare", { enabled: false, link_mbps: 50 }, oldMat);
		const oldPath = rl.settingsPath(home, "io_fairshare", oldMat);
		const rotated = { current: newKey, previous: [oldKey] };
		const newPath = rl.settingsPath(home, "io_fairshare", rotated);
		assert(oldPath !== newPath, "derived path changes with the key");
		const value = rl.readSettings(home, "io_fairshare", rotated);
		assert(value && value.enabled === false && value.link_mbps === 50, "previous key still decrypts");
		assert(fs.existsSync(newPath), "rewritten under the current key");
		assert(!fs.existsSync(oldPath), "previous path removed");
		const retired = rl.decryptJson(oldMat, fs.readFileSync(newPath, "utf8"));
		assert(retired === null, "retired key is rejected after rewrite");
		const again = rl.readSettings(home, "io_fairshare", { current: newKey, previous: [] });
		assert(again && again.link_mbps === 50, "current key reads the rewrite");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function testMigrateLeavesPlaintextAndDoesNotOverwrite() {
	const mat = { current: keyRec("a"), previous: [] };
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "mj-lock-mig-"));
	try {
		fs.writeFileSync(
			path.join(home, "update_preferences.json"),
			JSON.stringify({ allow_prerelease: true, keep_version_backups: false }),
			"utf8",
		);
		const copied = rl.migrateHomeSettings(home, mat);
		assert(copied.migrated.indexOf("update_preferences") >= 0, "plaintext is copied once");
		assert(
			fs.existsSync(path.join(home, "update_preferences.json")),
			"plaintext name is left in place",
		);
		const value = rl.readSettings(home, "update_preferences", mat);
		assert(value && value.allow_prerelease === true, "encrypted copy is readable");

		rl.writeSettings(home, "io_fairshare", { enabled: false, link_mbps: 10 }, mat);
		fs.writeFileSync(
			path.join(home, "io_fairshare.json"),
			JSON.stringify({ enabled: true, link_mbps: 1 }),
			"utf8",
		);
		rl.migrateHomeSettings(home, mat);
		const kept = rl.readSettings(home, "io_fairshare", mat);
		assert(kept && kept.enabled === false && kept.link_mbps === 10, "plaintext does not replace ciphertext");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function testPackRefusesMissingSecret() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mj-lock-pack-"));
	try {
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ version: "8.0.2", masonjarReleaseLock: true }),
			"utf8",
		);
		const result = pack.prepareReleaseLock(root, { skipGit: true });
		assert(!result.ok, "locked release without the private key file is refused");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function testPythonHmacMatches() {
	const mat = { current: keyRec("py"), previous: [] };
	const entry = {
		job_id: "abc",
		pid: 4,
		user: "matt",
		hostname: "lab",
		label: "max",
		started_at: "2026-10-07T00:00:00Z",
		last_heartbeat: "2026-10-07T00:00:05Z",
		throttled_bytes_total: 10,
		throttled_mbps_1m: 1.5,
	};
	const expected = rl.registryHmac(mat.current.key, entry);
	const stamped = rl.stampRegistryEntry(Object.assign({}, entry), mat);
	assert(stamped.masonjar_hmac === expected, "stamp matches registryHmac");
	assert(rl.registryEntryTrusted(stamped, mat), "stamped entry is trusted");
	assert(!rl.registryEntryTrusted(entry, mat), "plaintext entry is ignored when a key is set");
	assert(rl.registryEntryTrusted(entry, null), "no key keeps unsigned rows");

	const py = [
		"import json, os, sys",
		"sys.path.insert(0, sys.argv[1])",
		"os.environ['MASONJAR_RELEASE_KEY'] = sys.argv[2]",
		"import io_fairshare",
		"entry = json.loads(sys.argv[3])",
		"io_fairshare._stamp_registry_hmac(entry)",
		"print(entry['masonjar_hmac'])",
	].join("\n");
	const attempts = [
		["py", ["-3", "-c", py, path.join(repoRoot, "py"), mat.current.key, JSON.stringify(entry)]],
		["python", ["-c", py, path.join(repoRoot, "py"), mat.current.key, JSON.stringify(entry)]],
	];
	let ran = false;
	for (const attempt of attempts) {
		const result = spawnSync(attempt[0], attempt[1], { encoding: "utf8" });
		if (result.status === 0) {
			assert(result.stdout.trim() === expected, "python hmac matches node");
			ran = true;
			break;
		}
	}
	assert(ran, "python is required to check registry hmac");
}

function main() {
	testRoundTrip();
	testRotationAndDerivedPath();
	testMigrateLeavesPlaintextAndDoesNotOverwrite();
	testPackRefusesMissingSecret();
	testPythonHmacMatches();
	console.log("test-release-lock: ok");
}

main();
