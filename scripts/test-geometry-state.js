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

function testReapplyStackRisk() {
	var bundle = tempBundle();
	var czi = {
		geometry: {
			S1: { ops: ["rot90"] },
			S2: { ops: [] },
		},
		geometry_applied_at: "2026-01-01T00:00:00.000Z",
	};
	var st = geometryState.assessGeometryApplyState(bundle, czi, {
		sliceIds: ["S1", "S2"],
		previewHealth: { needsRepair: false, canApply: true },
	});
	assert.strictEqual(st.policyState, "interrupted");
	assert.ok(st.signals.indexOf("reapply_stack_risk") >= 0);
	assert.strictEqual(st.allowApply, false);
}

function testPartialPendingSubset() {
	var bundle = tempBundle();
	var cfgPath = path.join(bundle, ".masonjar", "czi_import_config.json");
	fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
	fs.writeFileSync(cfgPath, "{}", "utf8");
	var oldTime = Date.now() - 7 * 24 * 3600 * 1000;
	fs.utimesSync(cfgPath, oldTime / 1000, oldTime / 1000);
	var origDir = path.join(bundle, "data/original_scans/somata");
	fs.mkdirSync(origDir, { recursive: true });
	var tif = path.join(origDir, "S1.tif");
	fs.writeFileSync(tif, "tif");
	fs.utimesSync(tif, Date.now() / 1000, Date.now() / 1000);
	var czi = {
		geometry: {
			S1: { ops: ["rot90"] },
			S2: { ops: [] },
		},
		geometry_applied_at: "2026-01-01T00:00:00.000Z",
	};
	var st = geometryState.assessGeometryApplyState(bundle, czi, {
		sliceIds: ["S1", "S2"],
		previewHealth: { needsRepair: false, canApply: true },
	});
	assert.strictEqual(st.policyState, "interrupted");
	assert.ok(st.signals.indexOf("partial_pending_subset") >= 0);
}

function testLegacyPartialSuspect() {
	var bundle = tempBundle();
	var prev = path.join(bundle, "data/counting/_previews");
	var dapiDir = path.join(bundle, "data/counting/00_dapi");
	fs.mkdirSync(dapiDir, { recursive: true });
	var somataPng = path.join(prev, "S1_somata.png");
	var dapiPng = path.join(dapiDir, "S1.png");
	fs.writeFileSync(somataPng, "png");
	fs.writeFileSync(dapiPng, "png");
	var now = Date.now() / 1000;
	fs.utimesSync(somataPng, now, now);
	fs.utimesSync(dapiPng, now - 120, now - 120);
	var czi = {
		geometry: { S1: { ops: ["rot90"] } },
	};
	var st = geometryState.assessGeometryApplyState(bundle, czi, {
		sliceIds: ["S1"],
		previewHealth: { needsRepair: false, canApply: true },
	});
	assert.strictEqual(st.policyState, "interrupted");
	assert.ok(st.signals.indexOf("legacy_partial_suspect") >= 0);
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

function testWriteCziImportConfigIncludesGeometryHash() {
	var bundle = tempBundle();
	var czi = {
		geometry: { S1: { ops: ["rot90"] } },
		files: [],
	};
	geometryState.writeCziImportConfig(bundle, czi, { apply_source: "test" });
	var cfgPath = path.join(bundle, ".masonjar", "czi_import_config.json");
	var raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
	assert.strictEqual(raw.czi_import.apply_source, "test");
	assert.strictEqual(raw.czi_import.geometry_hash, geometryState.geometryOnlyHash(czi));
	assert.ok(raw.czi_import.config_fingerprint);
}

function testFinalizeGeometryAfterApplyClearsPending() {
	var bundle = tempBundle();
	var czi = {
		geometry: {
			S1: { ops: ["rot90"] },
			S2: { ops: ["flipX"] },
		},
	};
	geometryState.finalizeGeometryAfterApply(bundle, czi, {
		sliceIds: ["S1", "S2"],
		payload: { files_total: 4 },
		applySource: "batch",
	});
	assert.strictEqual(orientGeometry.countNonIdentityGeometry(czi.geometry, ["S1", "S2"]), 0);
	assert.ok(czi.geometry_applied_at);
	assert.strictEqual(czi.geometry_applied_files_total, 4);
	var cfg = JSON.parse(
		fs.readFileSync(path.join(bundle, ".masonjar", "czi_import_config.json"), "utf8"),
	);
	assert.strictEqual(cfg.czi_import.apply_source, "batch");
	assert.strictEqual(cfg.czi_import.geometry_hash, geometryState.geometryOnlyHash(czi));
}

function testReconcileClearsStalePendingAfterSuccessfulApply() {
	var bundle = tempBundle();
	var dapiDir = path.join(bundle, "data/counting/00_dapi");
	fs.mkdirSync(dapiDir, { recursive: true });
	fs.writeFileSync(path.join(dapiDir, "S1.png"), "png");
	var czi = {
		geometry: { S1: { ops: ["rot90"] } },
		geometry_applied_at: "2026-01-01T00:00:00.000Z",
		slice_order: [{ ordinal: 1, sliceId: "S1", path: "", scene_index: 0 }],
	};
	var hash = geometryState.geometryOnlyHash(czi);
	fs.writeFileSync(
		path.join(bundle, ".masonjar", geometryState.META_LAST_RESULT),
		JSON.stringify({ ok: true, geometry_hash: hash, files_total: 2 }),
		"utf8",
	);
	var projectData = { settings: { czi_import: czi } };
	var result = geometryState.reconcileGeometryOnOpen(bundle, projectData);
	assert.strictEqual(result.changed, true);
	assert.strictEqual(geometryState.hasPendingGeometry(czi, ["S1"]), false);
}

function testBatchFinalizeHelperPath() {
	var batchQueuePath = path.join(__dirname, "..", "batch_queue.js");
	assert.ok(fs.existsSync(batchQueuePath), "batch_queue.js must exist for batch finalize wiring");
	var src = fs.readFileSync(batchQueuePath, "utf8");
	assert.ok(src.indexOf("finalizeBatchApplyGeometry") >= 0);
	assert.ok(src.indexOf('path.join(__dirname, "js", "geometry_state")') >= 0);
}

function run() {
	testHasPendingOps();
	testInterruptedFromLastResult();
	testFreshPendingAllowsApply();
	testReapplyStackRisk();
	testPartialPendingSubset();
	testLegacyPartialSuspect();
	testBuildRepairTargets();
	testWriteCziImportConfigIncludesGeometryHash();
	testFinalizeGeometryAfterApplyClearsPending();
	testReconcileClearsStalePendingAfterSuccessfulApply();
	testBatchFinalizeHelperPath();
	console.log("test-geometry-state: PASS");
}

run();
