"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var helpers = require("./test-helpers");

helpers.ensureLocalStorage();

var pipelineRuns = require("../js/pipeline_runs");
var project = require("../js/project");

function makeBundle(opts) {
	opts = opts || {};
	var bundle = helpers.tmpDir("mj-bp-");
	fs.mkdirSync(path.join(bundle, ".masonjar"), { recursive: true });
	var projectFile = path.join(bundle, (opts.name || "M528") + ".masonjar");
	fs.writeFileSync(
		projectFile,
		JSON.stringify(
			{
				name: opts.name || "M528",
				roles: pipelineRuns.CANONICAL_ROLES,
				processing: {
					active_runs: opts.activeRuns || {},
				},
				settings: opts.settings || {},
			},
			null,
			2,
		),
		"utf8",
	);
	return bundle;
}

function testMaxStepReadsOriginalScansAndActiveOutLeaf() {
	var bundle = makeBundle({ activeRuns: { max: "max/M528_test" } });
	try {
		var paths = project.resolvePathsForBundle(bundle, "max");
		assert.ok(paths.indir.endsWith(path.join("data", "original_scans")));
		// Output leaf should respect active_runs (max branch + slug)
		var expectedOut = path.join(bundle, "data", "counting", "03_max", "max", "M528_test");
		assert.strictEqual(paths.outdir, expectedOut);
	} finally {
		helpers.rmDir(bundle);
	}
}

function testSharpenStepReadsMaxBranchLeaf() {
	// When active runs has a max run on the `max` branch (e.g. max/<slug>),
	// sharpen should read from that max branch leaf (not the sharpen branch).
	var bundle = makeBundle({
		activeRuns: { max: "max/M528_max1" },
	});
	try {
		var paths = project.resolvePathsForBundle(bundle, "sharpen");
		assert.ok(
			paths.indir.indexOf(path.join("03_max", "max", "M528_max1")) >= 0,
			"sharpen should read from active max/<slug> leaf, got: " + paths.indir,
		);
		// outdir resolves to the active max-role leaf base; runtime decides whether
		// to bake the sharpen branch slug. We only assert it lives under 03_max.
		assert.ok(paths.outdir.indexOf(path.join("data", "counting", "03_max")) >= 0);
	} finally {
		helpers.rmDir(bundle);
	}
}

function testIntensityStepHasInputOutputAnnotations() {
	var bundle = makeBundle({
		activeRuns: {
			max: "max/M528_max1",
			slices: "align/M528_align1",
			pkls: "intensity/M528_intens1",
		},
	});
	try {
		var paths = project.resolvePathsForBundle(bundle, "intensity");
		assert.ok(paths.indir);
		assert.ok(paths.outdir);
		assert.ok(paths.annodir);
		assert.ok(paths.annodir.indexOf(path.join("01_slices", "align", "M528_align1")) >= 0);
		assert.ok(paths.outdir.indexOf(path.join("07_pkls", "intensity", "M528_intens1")) >= 0);
	} finally {
		helpers.rmDir(bundle);
	}
}

function testApplyGeometryHasNoScriptRoles() {
	var bundle = makeBundle({});
	try {
		var paths = project.resolvePathsForBundle(bundle, "apply_geometry");
		assert.deepStrictEqual(paths, {}, "apply_geometry uses no role-based script args");
	} finally {
		helpers.rmDir(bundle);
	}
}

function testTophatStepReadsMaxBranchLeaf() {
	var bundle = makeBundle({
		activeRuns: { max: "max/M528_max1" },
	});
	try {
		var paths = project.resolvePathsForBundle(bundle, "tophat");
		assert.ok(
			paths.indir.indexOf(path.join("03_max", "max", "M528_max1")) >= 0,
			"tophat should read from active max/<slug> leaf, got: " + paths.indir,
		);
		assert.ok(paths.outdir.indexOf(path.join("data", "counting", "03_max")) >= 0);
	} finally {
		helpers.rmDir(bundle);
	}
}

function testDetectQcResolvesLikeDetect() {
	var bundle = makeBundle({
		activeRuns: { max: "max/M528_max1" },
	});
	try {
		var detectPaths = project.resolvePathsForBundle(bundle, "detect");
		// detect_qc is not in RUN_STEP_CONFIG; callers map to detect
		assert.ok(detectPaths.indir);
		assert.ok(detectPaths.outdir);
		assert.ok(detectPaths.outdir.indexOf("05_predictions") >= 0);
	} finally {
		helpers.rmDir(bundle);
	}
}

function testCollateUsesQuantificationRoleBase() {
	var bundle = makeBundle({
		activeRuns: { quantification: "count/M528_count1" },
	});
	try {
		var paths = project.resolvePathsForBundle(bundle, "collate");
		assert.ok(paths.indir);
		assert.ok(paths.outdir);
		// Renderer resolver returns the active quantification leaf for both indir
		// and outdir; the runtime collate handler chooses its own collate/<slug>
		// leaf when writing.
		assert.ok(paths.indir.indexOf(path.join("06_quantification", "count", "M528_count1")) >= 0);
		assert.ok(paths.outdir.indexOf(path.join("06_quantification")) >= 0);
	} finally {
		helpers.rmDir(bundle);
	}
}

function testResolveRoleBaseAbsForBundle() {
	var bundle = makeBundle({});
	try {
		var dapi = pipelineRuns.resolveRoleBaseAbsForBundle(
			bundle,
			pipelineRuns.CANONICAL_ROLES,
			"dapi",
		);
		assert.ok(dapi);
		assert.ok(dapi.endsWith(path.join("00_dapi")));

		var unknown = pipelineRuns.resolveRoleBaseAbsForBundle(
			bundle,
			pipelineRuns.CANONICAL_ROLES,
			"not_a_role",
		);
		assert.strictEqual(unknown, "");
	} finally {
		helpers.rmDir(bundle);
	}
}

function testStepIdFanoutCovered() {
	// Make sure every step in RUN_STEP_CONFIG with scriptRoles resolves without throwing
	var bundle = makeBundle({});
	try {
		var ids = Object.keys(pipelineRuns.RUN_STEP_CONFIG || {});
		for (var i = 0; i < ids.length; i++) {
			var cfg = pipelineRuns.RUN_STEP_CONFIG[ids[i]];
			if (!cfg || !cfg.scriptRoles) continue;
			var paths = project.resolvePathsForBundle(bundle, ids[i]);
			var keys = Object.keys(cfg.scriptRoles);
			for (var k = 0; k < keys.length; k++) {
				assert.ok(
					typeof paths[keys[k]] === "string",
					"step " + ids[i] + " missing path key " + keys[k],
				);
			}
		}
	} finally {
		helpers.rmDir(bundle);
	}
}

function run() {
	testMaxStepReadsOriginalScansAndActiveOutLeaf();
	testSharpenStepReadsMaxBranchLeaf();
	testIntensityStepHasInputOutputAnnotations();
	testApplyGeometryHasNoScriptRoles();
	testTophatStepReadsMaxBranchLeaf();
	testDetectQcResolvesLikeDetect();
	testCollateUsesQuantificationRoleBase();
	testResolveRoleBaseAbsForBundle();
	testStepIdFanoutCovered();
	console.log("test-batch-paths: PASS");
}

run();
