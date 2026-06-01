#!/usr/bin/env node
"use strict";

/**
 * Publish Mason Jar release assets to GitHub.
 *
 * Default: upload Windows x64 zip only (primary user platform; faster publish).
 *
 * Usage:
 *   node scripts/publish-release.js              # Windows zip only
 *   node scripts/publish-release.js --all-platforms  # all built artifacts for version
 *   node scripts/publish-release.js --dry-run
 */

const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const REPO = "matsojr22/masonjar";
const OUT_MAKE = path.join(REPO_ROOT, "out", "make");

function readVersion() {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
	);
	return pkg.version;
}

function parseArgs(argv) {
	const opts = { allPlatforms: false, dryRun: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--all-platforms") {
			opts.allPlatforms = true;
		} else if (a === "--dry-run") {
			opts.dryRun = true;
		} else if (a === "--help" || a === "-h") {
			console.log(`Publish Mason Jar GitHub release assets

  node scripts/publish-release.js                 Windows zip only (default)
  node scripts/publish-release.js --all-platforms  Upload every masonjar-* artifact for version
  node scripts/publish-release.js --dry-run       List files only

Requires git credential for github.com (password = PAT) or GH_TOKEN env.
`);
			process.exit(0);
		} else {
			console.error("Unknown option:", a);
			process.exit(1);
		}
	}
	return opts;
}

function getToken() {
	if (process.env.GH_TOKEN) {
		return process.env.GH_TOKEN;
	}
	const r = spawnSync(
		"git",
		["credential", "fill"],
		{
			input: "protocol=https\nhost=github.com\n\n",
			encoding: "utf8",
		},
	);
	if (r.status !== 0) {
		throw new Error("git credential fill failed; run gh auth login or set GH_TOKEN");
	}
	for (const line of (r.stdout || "").split("\n")) {
		if (line.startsWith("password=")) {
			return line.slice("password=".length);
		}
	}
	throw new Error("No GitHub token from git credential");
}

function githubRequest(method, urlPath, token, body, headers) {
	return new Promise((resolve, reject) => {
		const payload = body
			? typeof body === "string" || Buffer.isBuffer(body)
				? body
				: JSON.stringify(body)
			: null;
		const opts = {
			hostname: "api.github.com",
			path: urlPath,
			method,
			headers: Object.assign(
				{
					Authorization: "token " + token,
					Accept: "application/vnd.github+json",
					"User-Agent": "masonjar-publish-release",
				},
				headers || {},
			),
		};
		if (payload && !opts.headers["Content-Type"]) {
			opts.headers["Content-Type"] = "application/json";
			opts.headers["Content-Length"] = Buffer.byteLength(payload);
		}
		const req = https.request(opts, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				if (res.statusCode >= 200 && res.statusCode < 300) {
					try {
						resolve(raw ? JSON.parse(raw) : {});
					} catch (_e) {
						resolve(raw);
					}
					return;
				}
				reject(new Error("HTTP " + res.statusCode + " " + urlPath + ": " + raw.slice(0, 500)));
			});
		});
		req.on("error", reject);
		if (payload) {
			req.write(payload);
		}
		req.end();
	});
}

function uploadAsset(uploadUrlTemplate, token, filePath) {
	return new Promise((resolve, reject) => {
		const name = path.basename(filePath);
		const uploadUrl = new URL(uploadUrlTemplate.replace(/\{.*$/, ""));
		uploadUrl.searchParams.set("name", name);
		const stat = fs.statSync(filePath);
		const sizeMb = Math.round(stat.size / 1024 / 1024);
		console.log("Uploading " + name + " (" + sizeMb + " MB)…");

		const opts = {
			hostname: uploadUrl.hostname,
			path: uploadUrl.pathname + uploadUrl.search,
			method: "POST",
			headers: {
				Authorization: "token " + token,
				"Content-Type": "application/octet-stream",
				"Content-Length": stat.size,
				"User-Agent": "masonjar-publish-release",
			},
		};

		const req = https.request(opts, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				if (res.statusCode >= 200 && res.statusCode < 300) {
					const info = JSON.parse(raw);
					console.log("  OK:", info.browser_download_url || name);
					resolve(info);
					return;
				}
				reject(new Error("Upload failed " + name + ": " + res.statusCode + " " + raw.slice(0, 400)));
			});
		});
		req.on("error", reject);
		const stream = fs.createReadStream(filePath);
		stream.on("error", reject);
		stream.pipe(req);
	});
}

function findArtifacts(version, allPlatforms) {
	const found = [];
	if (!fs.existsSync(OUT_MAKE)) {
		return found;
	}
	const versionNeedle = "-" + version;
	function isArtifact(name, full) {
		if (!/\.(dmg|zip|deb|rpm)$/i.test(name)) {
			return false;
		}
		if (!name.toLowerCase().startsWith("masonjar")) {
			return false;
		}
		if (name.indexOf(versionNeedle) === -1 && name.indexOf(version) === -1) {
			return false;
		}
		if (!allPlatforms) {
			const rel = path.relative(OUT_MAKE, full).replace(/\\/g, "/");
			if (!rel.includes("zip/win32/x64/") || !/\.zip$/i.test(name)) {
				return false;
			}
		}
		return true;
	}
	function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (_e) {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full);
			} else if (ent.isFile() && isArtifact(ent.name, full)) {
				found.push(full);
			}
		}
	}
	walk(OUT_MAKE);
	return [...new Set(found)].sort();
}

function readHandoffSummary(version) {
	const handoffPath = path.join(REPO_ROOT, "docs", "AGENT_HANDOFF.md");
	try {
		const text = fs.readFileSync(handoffPath, "utf8");
		const escaped = version.replace(/\./g, "\\.");
		const re = new RegExp(
			"\\*\\*v" + escaped + "\\*\\* — ([^\n]+)",
			"i",
		);
		const match = text.match(re);
		if (!match) {
			return "";
		}
		let summary = match[1].trim();
		// First sentence is enough for GitHub release blurbs.
		const dot = summary.indexOf(". ");
		if (dot > 0) {
			summary = summary.slice(0, dot + 1);
		}
		// Flatten inline markdown links [`file`](path) → file
		summary = summary.replace(/\[(`[^`]+`)\]\([^)]+\)/g, "$1");
		return summary;
	} catch (_e) {
		return "";
	}
}

function releaseNotes(version, opts) {
	opts = opts || {};
	const allPlatforms = !!opts.allPlatforms;
	const summary = readHandoffSummary(version);
	const lines = ["## Mason Jar v" + version, ""];

	if (summary) {
		lines.push("### What's new", "", summary, "");
	}

	lines.push("### Downloads", "");

	if (allPlatforms) {
		lines.push(
			"| Platform | File |",
			"|----------|------|",
			"| **Windows (x64)** | `masonjar-win32-x64-" +
				version +
				".zip` — unzip and run the app inside the folder |",
			"| **macOS (Apple Silicon)** | `masonjar-" +
				version +
				"-arm64.dmg` |",
			"| **macOS (Intel)** | `masonjar-" + version + "-x64.dmg` |",
			"",
			"On macOS, if Gatekeeper blocks the app, use **right-click → Open** on first launch.",
			"",
		);
	} else {
		lines.push(
			"- **Windows (x64):** `masonjar-win32-x64-" +
				version +
				".zip` — unzip and run the app inside the folder.",
			"",
			"_This upload includes the Windows build only. macOS DMGs are published separately with `--all-platforms`._",
			"",
		);
	}

	lines.push(
		"### Upgrading",
		"",
		"Install over your previous Mason Jar folder or unzip to a new path. User data and models stay under `~/.masonjar` (Windows: `%USERPROFILE%\\.masonjar`).",
		"",
		"### Build from source",
		"",
		"```bash",
		"node scripts/build-release.js",
		"node scripts/publish-release.js --all-platforms",
		"```",
		"",
	);

	return lines.join("\n");
}

async function main() {
	const opts = parseArgs(process.argv);
	const version = readVersion();
	const tag = "v" + version;
	const artifacts = findArtifacts(version, opts.allPlatforms);

	console.log("Publish " + tag + " to " + REPO);
	console.log(
		opts.allPlatforms
			? "Mode: all platforms"
			: "Mode: Windows zip only",
	);

	if (!artifacts.length) {
		console.error(
			"No artifacts found. Run: node scripts/build-release.js" +
				(opts.allPlatforms ? " --all-platforms" : ""),
		);
		process.exit(1);
	}

	for (const a of artifacts) {
		console.log(" ", path.relative(REPO_ROOT, a));
	}

	if (opts.dryRun) {
		console.log("\n(dry-run: no upload)");
		return;
	}

	const token = getToken();
	const base = "/repos/" + REPO;

	let release;
	try {
		release = await githubRequest("GET", base + "/releases/tags/" + tag, token);
	} catch (e) {
		if (String(e.message).indexOf("404") >= 0) {
			release = null;
		} else {
			throw e;
		}
	}

	const notesBody = releaseNotes(version, opts);

	if (!release || !release.id) {
		release = await githubRequest("POST", base + "/releases", token, {
			tag_name: tag,
			name: "Mason Jar v" + version,
			body: notesBody,
			draft: false,
			prerelease: false,
		});
		console.log("Created release id=" + release.id);
	} else {
		await githubRequest("PATCH", base + "/releases/" + release.id, token, {
			name: "Mason Jar v" + version,
			body: notesBody,
		});
		console.log("Updated release notes for id=" + release.id);
		release = await githubRequest("GET", base + "/releases/" + release.id, token);
	}

	const existing = new Set((release.assets || []).map((a) => a.name));

	for (const filePath of artifacts) {
		const name = path.basename(filePath);
		if (existing.has(name)) {
			console.log("Skip existing asset:", name);
			continue;
		}
		let uploadUrl = release.upload_url;
		if (!uploadUrl) {
			throw new Error("Release has no upload_url");
		}
		await uploadAsset(uploadUrl, token, filePath);
		release = await githubRequest("GET", base + "/releases/" + release.id, token);
		existing.add(name);
	}

	console.log("\nRelease URL: https://github.com/" + REPO + "/releases/tag/" + tag);
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
