"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var orientGeometry = require("../js/orient_geometry");
var geometryState = require("../js/geometry_state");

function tempBundle() {
	var root = fs.mkdtempSync(path.join(os.tmpdir(), "mj-geo-state-"));
	var meta = path.join(root, ".masonjar");
	fs.mkdirSync(meta, { recursive: true });
	var prev = path.join(root, "data/counting/_previews");
	fs.mkdirSync(prev, { recursive: true });
	return root;
}

function testHasPendingOps() {
	var czi = {
		geometry: {
			A: { ops: ["rot90"] },
			B: { ops: [] },
		},
	};
	assert.strictEqual(geometryState.hasPendingGeometry(czi, ["A", "B"]), true);
	assert.strictEqual(geometryState.hasPendingGeometry(czi, ["B"]), false);
}

function testInterruptedFromLastResult() {
	var bundle = tempBundle();
	var czi = {
		geometry: { S1: { ops: ["rot90"] } },
		config_fingerprint: "fp1",
	};
	fs.writeFileSync(
		path.join(bundle, ".masonjar", geometryState.META_LAST_RESULT),
		JSON.stringify({
			ok: false,
			changed: 1,
			files_total: 10,
			config_fingerprint: "fp1",
			geometry_hash: geometryState.geometryOnlyHash(czi),
		}),
		"utf8",
	);
	fs.writeFileSync(
		path.join(bundle, ".masonjar", geometryState.META_PROGRESS),
		JSON.stringify({
			config_fingerprint: "fp1",
			geometry_hash: geometryState.geometryOnlyHash(czi),
			completed: 1,
			files_total: 10,
			completed_paths: [],
		}),
		"utf8",
	);
	czi.config_fingerprint = "fp1";
	var st = geometryState.assessGeometryApplyState(bundle, czi, {
		sliceIds: ["S1"],
		previewHealth: { needsRepair: false, canApply: true },
	});
	assert.strictEqual(st.policyState, "interrupted");
	assert.strictEqual(st.allowApply, false);
	assert.strictEqual(st.showRebuildWizard, true);
}

function testFreshPendingAllowsApply() {
	var bundle = tempBundle();
	var czi = {
		geometry: { S1: { ops: ["flipX"] } },
	};
	var st = geometryState.assessGeometryApplyState(bundle, czi, {
		sliceIds: ["S1"],
		previewHealth: { needsRepair: false, canApply: true },
	});
	assert.strictEqual(st.policyState, "healthy");
	assert.strictEqual(st.allowApply, true);
}

function testBuildRepairTargets() {
	var queue = {
		slices: [
			{
				slice_id: "S1",
				pending_ops: ["rot90"],
				confirmed_ops: ["rot90"],
				channels: [
					{
						branch: "dapi",
						rel_path: "data/counting/_previews/S1_dapi.png",
						suggested_strategy: "derivatives_from_original",
					},
				],
			},
		],
	};
	var targets = geometryState.buildRepairTargetsFromQueue(queue);
	assert.strictEqual(targets.length, 1);
	assert.strictEqual(targets[0].slice_id, "S1");
	assert.deepStrictEqual(targets[0].ops, ["rot90"]);
}

function run() {
	testHasPendingOps();
	testInterruptedFromLastResult();
	testFreshPendingAllowsApply();
	testBuildRepairTargets();
	console.log("test-geometry-state: PASS");
}

run();
