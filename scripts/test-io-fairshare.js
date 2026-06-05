"use strict";

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

function main() {
	testParseLinkSpeed();
	testComputeJobLimit();
	testCoordinatorPaths();
	testRegistryStale();
	console.log("test-io-fairshare: ok");
}

main();
