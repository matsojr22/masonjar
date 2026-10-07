"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function git(repoRoot, args) {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

/**
 * Refuse a locked release when the private key file is missing.
 * When the key is present, write gitignored release_lock.secret.js for the pack.
 */
function prepareReleaseLock(repoRoot, options) {
	const opts = options || {};
	const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
	const secretJson = path.join(repoRoot, "development", "secrets", "release_lock.json");
	const secretJs = path.join(repoRoot, "release_lock.secret.js");
	if (pkg.masonjarReleaseLock && !fs.existsSync(secretJson)) {
		return {
			ok: false,
			error:
				"masonjarReleaseLock is set but development/secrets/release_lock.json is missing.",
		};
	}
	if (!opts.skipGit) {
		let tracked = "";
		try {
			tracked = git(repoRoot, ["ls-files"]);
		} catch (_err) {
			return { ok: false, error: "git ls-files failed while checking the release lock." };
		}
		if (tracked.split(/\r?\n/).indexOf("release_lock.secret.js") >= 0) {
			return {
				ok: false,
				error: "release_lock.secret.js is tracked in the public repo.",
			};
		}
		try {
			git(repoRoot, ["check-ignore", "-q", "--", "release_lock.secret.js"]);
		} catch (_err) {
			return { ok: false, error: "release_lock.secret.js is not gitignored." };
		}
		if (fs.existsSync(secretJson)) {
			const material = JSON.parse(fs.readFileSync(secretJson, "utf8"));
			const keys = [material.current].concat(material.previous || []);
			for (const rec of keys) {
				if (!rec || !rec.key) {
					continue;
				}
				try {
					git(repoRoot, ["grep", "-F", "-q", "--", rec.key]);
					return {
						ok: false,
						error: "A release lock key is tracked in the public repo.",
					};
				} catch (err) {
					if (!err || err.status !== 1) {
						return { ok: false, error: "git grep failed while checking the release lock." };
					}
				}
			}
		}
	}
	if (!pkg.masonjarReleaseLock) {
		return { ok: true, wrote: false };
	}
	const material = JSON.parse(fs.readFileSync(secretJson, "utf8"));
	if (!material.current || !material.current.key || !material.current.id) {
		return { ok: false, error: "release lock file has no current key." };
	}
	fs.writeFileSync(
		secretJs,
		"module.exports = " + JSON.stringify(material) + ";\n",
		"utf8",
	);
	return { ok: true, wrote: true };
}

module.exports = {
	prepareReleaseLock: prepareReleaseLock,
};
