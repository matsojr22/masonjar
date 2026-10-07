"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const ioFairshare = require(path.join(repoRoot, "io_fairshare.js"));

function assert(cond, msg) {
	if (!cond) {
		throw new Error(msg);
	}
}

function testParseLinkSpeed() {
	assert(ioFairshare.parseLinkSpeedText("1 Gbps") === 1000, "1 Gbps");
	assert(ioFairshare.parseLinkSpeedText("100 Mbps") === 100, "100 Mbps");
	assert(ioFairshare.parseLinkSpeedText("2.5 Gbps") === 2500, "2.5 Gbps");
}

function testComputeJobLimit() {
	const shared = {
		enabled: true,
		link_mbps: 1000,
		headroom: 0.85,
		min_mbps_per_job: 25,
		max_mbps_per_job: "auto",
		small_file_bytes: 262144,
		stale_seconds: 30,
	};
	assert(
		ioFairshare.computeJobLimitMbps(shared, 1000, 1) === 850,
		"single job gets full budget",
	);
	assert(
		ioFairshare.computeJobLimitMbps(shared, 1000, 4) === 212.5,
		"four jobs split budget",
	);
	const floor = ioFairshare.computeJobLimitMbps(shared, 1000, 100);
	assert(floor === 25, "many jobs hit floor");
}

function testCoordinatorPaths() {
	const dir = ioFairshare.defaultCoordinatorDir();
	assert(typeof dir === "string" && dir.length > 0, "coordinator dir");
}

function testRegistryStale() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-"));
	const reg = path.join(tmp, "registry");
	fs.mkdirSync(reg, { recursive: true });
	const stale = {
		job_id: "stale",
		pid: 1,
		user: "test",
		hostname: "test",
		label: "max",
		started_at: new Date().toISOString(),
		last_heartbeat: new Date(Date.now() - 120000).toISOString(),
	};
	fs.writeFileSync(path.join(reg, "stale.json"), JSON.stringify(stale));
	fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ stale_seconds: 30 }));
	const entries = ioFairshare.listRegistryEntries(tmp, 30);
	assert(entries.length === 0, "stale registry removed");
	fs.rmSync(tmp, { recursive: true, force: true });
}

function testNormalizeNasPathPrefix() {
	if (process.platform === "win32") {
		assert(
			ioFairshare.normalizeNasPathPrefix("Z:\\Lab\\Projects\\M528") === "Z:\\",
			"drive subfolder to root",
		);
		assert(
			ioFairshare.normalizeNasPathPrefix("\\\\nas01\\share\\lab\\data") ===
				"\\\\nas01\\share",
			"UNC to share root",
		);
	} else if (process.platform === "darwin") {
		assert(
			ioFairshare.normalizeNasPathPrefix("/Volumes/NAS/lab/data") ===
				"/Volumes/NAS",
			"volume root",
		);
	}
}

function testMergeNasPathPrefixes() {
	if (process.platform === "win32") {
		var merged = ioFairshare.mergeNasPathPrefixes(["Z:\\"], ["z:\\", "Z:/"]);
		assert(merged.length === 1, "dedupe drive letter");
		merged = ioFairshare.mergeNasPathPrefixes(
			["\\\\nas\\share"],
			["\\\\nas\\share\\sub"],
		);
		assert(merged.length === 1, "dedupe UNC share");
	} else if (process.platform === "darwin") {
		var mergedDarwin = ioFairshare.mergeNasPathPrefixes(
			["/Volumes/NAS"],
			["/Volumes/NAS/lab/data"],
		);
		assert(mergedDarwin.length === 1, "dedupe volume root");
	}
}

function testWriteJsonAtomicHeartbeatRewrite() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-write-"));
	const reg = path.join(tmp, "registry");
	fs.mkdirSync(reg, { recursive: true });
	const filePath = path.join(reg, "job-heartbeat.json");
	const entry = {
		job_id: "job-heartbeat",
		pid: process.pid,
		last_heartbeat: new Date().toISOString(),
	};
	for (var i = 0; i < 12; i++) {
		entry.last_heartbeat = new Date().toISOString();
		ioFairshare.writeJsonAtomic(filePath, entry);
	}
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	assert(parsed.job_id === "job-heartbeat", "heartbeat rewrite keeps job_id");
	fs.rmSync(tmp, { recursive: true, force: true });
}

function testTouchJobMissingIsNoop() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-touch-"));
	fs.mkdirSync(path.join(tmp, "registry"), { recursive: true });
	ioFairshare.touchJob(tmp, "missing-job-id");
	fs.rmSync(tmp, { recursive: true, force: true });
}

function testStatusIncludesNasPrefixes() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-status-"));
	fs.mkdirSync(path.join(tmp, "registry"), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, "config.json"),
		JSON.stringify({ nas_path_prefixes: ["Z:\\"], stale_seconds: 30 }),
	);
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-home-"));
	const status = ioFairshare.getIoFairshareStatus(tmp, home);
	assert(Array.isArray(status.nas_path_prefixes), "nas_path_prefixes array");
	if (process.platform === "win32") {
		assert(status.nas_path_prefixes.indexOf("Z:\\") >= 0, "reads Z: prefix");
	}
	assert(status.shared_config_path.indexOf("config.json") >= 0, "config path");
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
}

function testFormatFairshareTitleSuffix() {
	const disabled = ioFairshare.formatFairshareTitleSuffix({ enabled: false });
	assert(disabled === "", "disabled returns empty suffix");

	const enabled = ioFairshare.formatFairshareTitleSuffix({
		enabled: true,
		active_jobs: 3,
		limit_mbps: 85.4,
		local_throttled_mbps_1m: 0,
	});
	assert(enabled.indexOf("3 jobs") >= 0, "shows job count");
	assert(enabled.indexOf("~85 Mbps") >= 0, "shows limit");
	assert(enabled.indexOf("NAS") < 0, "omits NAS when idle");

	const withNas = ioFairshare.formatFairshareTitleSuffix({
		enabled: true,
		active_jobs: 1,
		limit_mbps: 100,
		local_throttled_mbps_1m: 12.3,
	});
	assert(withNas.indexOf("NAS 12 Mbps") >= 0, "shows NAS throughput");
}

function testLocalThrottledMbpsAggregation() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-throttle-"));
	const reg = path.join(tmp, "registry");
	fs.mkdirSync(reg, { recursive: true });
	fs.writeFileSync(
		path.join(tmp, "config.json"),
		JSON.stringify({ stale_seconds: 30 }),
	);
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-home2-"));
	const instanceId = "test-instance-abc";
	ioFairshare.setAppInstanceId(instanceId);
	const now = new Date().toISOString();
	const mkEntry = function (jobId, rate, instId) {
		return {
			job_id: jobId,
			pid: process.pid,
			user: "test",
			hostname: "test",
			label: "max",
			started_at: now,
			last_heartbeat: now,
			app_instance_id: instId,
			throttled_mbps_1m: rate,
		};
	};
	fs.writeFileSync(
		path.join(reg, "a.json"),
		JSON.stringify(mkEntry("a", 10, instanceId)),
	);
	fs.writeFileSync(
		path.join(reg, "b.json"),
		JSON.stringify(mkEntry("b", 5.5, instanceId)),
	);
	fs.writeFileSync(
		path.join(reg, "c.json"),
		JSON.stringify(mkEntry("c", 99, "other-instance")),
	);
	const status = ioFairshare.getIoFairshareStatus(tmp, home);
	assert(
		Math.abs(status.local_throttled_mbps_1m - 15.5) < 0.01,
		"sums instance-scoped NAS rates",
	);
	ioFairshare.setAppInstanceId("");
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
}

function testProjectIndexNodeJobTracking() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-idx-"));
	fs.mkdirSync(path.join(tmp, "registry"), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, "config.json"),
		JSON.stringify({ enabled: true, stale_seconds: 30 }),
	);
	const jobId = ioFairshare.newJobId();
	ioFairshare.beginNodeJobTracking(tmp, jobId, "project_index");
	const live = ioFairshare.listRegistryEntries(tmp, 30);
	assert(live.length === 1, "project_index registry entry present");
	assert(live[0].label === "project_index", "label is project_index");
	assert(live[0].job_id === jobId, "job id matches");
	ioFairshare.endNodeJobTracking(tmp, jobId);
	const after = ioFairshare.listRegistryEntries(tmp, 30);
	assert(after.length === 0, "project_index registry entry cleared");
	fs.rmSync(tmp, { recursive: true, force: true });
}

function freshJob(id, ageMs) {
	return {
		job_id: id,
		pid: 1,
		user: "test",
		hostname: "test",
		label: "max",
		started_at: new Date().toISOString(),
		last_heartbeat: new Date(Date.now() - ageMs).toISOString(),
	};
}

function testPreviousKeyRegistryRestamp() {
	const rl = require(path.join(repoRoot, "release_lock.js"));
	const oldKey = {
		id: "old",
		key: crypto.randomBytes(32).toString("base64"),
	};
	const newKey = {
		id: "new",
		key: crypto.randomBytes(32).toString("base64"),
	};
	const oldMat = { current: oldKey, previous: [] };
	const rotated = { current: newKey, previous: [oldKey] };
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-rot-"));
	const reg = path.join(tmp, "registry");
	fs.mkdirSync(reg, { recursive: true });
	const fresh = freshJob("job1", 0);
	const stamped = rl.stampRegistryEntry(Object.assign({}, fresh), oldMat);
	fs.writeFileSync(path.join(reg, "job1.json"), JSON.stringify(stamped));
	fs.writeFileSync(
		path.join(reg, "other.json"),
		JSON.stringify(Object.assign({}, freshJob("other", 0), { masonjar_hmac: "not-ours" })),
	);
	const live = ioFairshare.listRegistryEntries(tmp, 30, rotated);
	assert(live.length === 1 && live[0].job_id === "job1", "previous-key row counts after restamp");
	const onDisk = JSON.parse(fs.readFileSync(path.join(reg, "job1.json"), "utf8"));
	assert(rl.registryEntryTrusted(onDisk, rotated), "file rewritten with the current key");
	assert(fs.existsSync(path.join(reg, "other.json")), "unknown hmac is left in place");
	const again = ioFairshare.listRegistryEntries(tmp, 30, rotated);
	assert(again.length === 1, "second read still counts the restamped row");
	fs.rmSync(tmp, { recursive: true, force: true });
}

function testPeerShadows() {
	const prev = process.env.MASONJAR_IO_PEER_REGISTRY;
	const ours = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-ours-"));
	const peer = fs.mkdtempSync(path.join(os.tmpdir(), "mj-io-peer-"));
	try {
		process.env.MASONJAR_IO_PEER_REGISTRY = peer;
		fs.mkdirSync(path.join(ours, "registry"), { recursive: true });
		fs.writeFileSync(
			path.join(ours, "config.json"),
			JSON.stringify({
				enabled: true,
				link_mbps: 1000,
				headroom: 0.85,
				min_mbps_per_job: 25,
				max_mbps_per_job: "auto",
				stale_seconds: 30,
			}),
		);
		fs.writeFileSync(
			path.join(ours, "registry", "ours.json"),
			JSON.stringify(freshJob("ours", 0)),
		);
		fs.writeFileSync(
			path.join(ours, "registry", "mj-shadow-copy.json"),
			JSON.stringify(freshJob("mj-shadow-copy", 0)),
		);
		fs.writeFileSync(path.join(peer, "theirs.json"), JSON.stringify(freshJob("theirs", 0)));
		fs.writeFileSync(path.join(peer, "old.json"), JSON.stringify(freshJob("old", 120000)));
		fs.writeFileSync(
			path.join(peer, "mj-shadow-leftover.json"),
			JSON.stringify(freshJob("mj-shadow-leftover", 0)),
		);
		const status = ioFairshare.getIoFairshareStatus(ours, path.join(ours, "home"));
		assert(status.active_jobs === 2, "ours plus their live job, got " + status.active_jobs);
		assert(fs.existsSync(path.join(peer, "mj-shadow-ours.json")), "shadow written");
		assert(!fs.existsSync(path.join(peer, "mj-shadow-leftover.json")), "old shadow removed");
		assert(fs.existsSync(path.join(peer, "theirs.json")), "their job file kept");
		assert(!fs.existsSync(path.join(peer, "config.json")), "their config is untouched");
		const onlyOurs = ioFairshare.listRegistryEntries(ours, 30);
		assert(onlyOurs.length === 1 && onlyOurs[0].job_id === "ours", "shadow files are not our jobs");
	} finally {
		if (prev == null) {
			delete process.env.MASONJAR_IO_PEER_REGISTRY;
		} else {
			process.env.MASONJAR_IO_PEER_REGISTRY = prev;
		}
		fs.rmSync(ours, { recursive: true, force: true });
		fs.rmSync(peer, { recursive: true, force: true });
	}
}

function main() {
	testParseLinkSpeed();
	testComputeJobLimit();
	testCoordinatorPaths();
	testRegistryStale();
	testNormalizeNasPathPrefix();
	testMergeNasPathPrefixes();
	testWriteJsonAtomicHeartbeatRewrite();
	testTouchJobMissingIsNoop();
	testStatusIncludesNasPrefixes();
	testFormatFairshareTitleSuffix();
	testLocalThrottledMbpsAggregation();
	testProjectIndexNodeJobTracking();
	testPreviousKeyRegistryRestamp();
	testPeerShadows();
	console.log("test-io-fairshare: ok");
}

main();
