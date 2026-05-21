"use strict";

var assert = require("assert");
var path = require("path");
var fs = require("fs");
var helpers = require("./test-helpers");

helpers.ensureLocalStorage();

var pipelineRuns = require("../js/pipeline_runs");
var project = require("../js/project");
var fileIndex = require("../js/file_index");

function testBuildRunSlugStability() {
	var stems = ["M528_s061", "M528_s062"];
	var slug1 = pipelineRuns.buildRunSlug("align", {
		sortedStems: stems,
		spacing: 10,
		whole: "True",
		legacy: "False",
		subsetCount: 2,
	});
	var slug2 = pipelineRuns.buildRunSlug("align", {
		sortedStems: stems,
		spacing: 10,
		whole: "True",
		legacy: "False",
		subsetCount: 2,
	});
	assert.strictEqual(slug1, slug2);
	assert.ok(slug1.indexOf("M528") >= 0);
}

function testResolveRunLeaf() {
	var base = helpers.tmpDir("mj-leaf-");
	var leaf = pipelineRuns.resolveRunLeaf(base, "align", "M528_s061_sp10", false);
	assert.strictEqual(
		leaf,
		path.join(base, "align", "M528_s061_sp10"),
	);
	assert.strictEqual(pipelineRuns.resolveRunLeaf(base, "align", "x", true), base);
	helpers.rmDir(base);
}

function testDiscoverOutputRuns() {
	var base = helpers.tmpDir("mj-disc-");
	var runDir = path.join(base, "align", "M528_s061_sp10");
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "Annotation_M528_s061.pkl"), "x");
	var runs = pipelineRuns.discoverOutputRuns(base, "align", 2);
	assert.ok(runs.length >= 1);
	assert.ok(runs[0].rel.indexOf("align") >= 0);
	helpers.rmDir(base);
}

function testActiveRunScoping() {
	var bundle = helpers.tmpDir("mj-scope-");
	var roles = {
		dapi: "data/counting/00_dapi",
		slices: "data/counting/01_slices",
	};
	var slicesDir = path.join(bundle, roles.slices);
	var nestedA = path.join(slicesDir, "align", "run_a");
	var nestedB = path.join(slicesDir, "align", "run_b");
	fs.mkdirSync(path.join(bundle, roles.dapi), { recursive: true });
	fs.mkdirSync(nestedA, { recursive: true });
	fs.mkdirSync(nestedB, { recursive: true });
	helpers.touchImage(path.join(bundle, roles.dapi), "M528_s027.tif");
	helpers.touchImage(path.join(bundle, roles.dapi), "M528_s028.tif");
	fs.writeFileSync(path.join(nestedA, "Annotation_M528_s027.pkl"), "a");
	fs.writeFileSync(path.join(nestedB, "Annotation_M528_s028.pkl"), "b");

	var activeRuns = pipelineRuns.defaultActiveRuns();
	activeRuns.slices = "align/run_a";

	return fileIndex
		.buildFileIndex(bundle, roles, {
			appRoot: path.join(__dirname, ".."),
			activeRuns: activeRuns,
		})
		.then(function (index) {
			var report = fileIndex.computeMatchReport(index, ["dapi", "slices"]);
			assert.deepStrictEqual(report.matchedSliceIds, ["M528_s027"]);
			assert.ok(report.matchedSliceIds.indexOf("M528_s028") < 0);
			helpers.rmDir(bundle);
		});
}

function testMigrateActivePredictionRun() {
	var runs = pipelineRuns.migrateActiveRuns({
		active_prediction_run: "somata/foo_bar",
	});
	assert.strictEqual(runs.predictions, "somata/foo_bar");
}

function testDedupeBranchRunRel() {
	assert.strictEqual(
		pipelineRuns.dedupeBranchRunRel(
			"intensity/foo/intensity/foo",
			"intensity",
		),
		"intensity/foo",
	);
	assert.strictEqual(
		pipelineRuns.dedupeBranchRunRel(
			"intensity/a/intensity/a/intensity/a",
			"intensity",
		),
		"intensity/a",
	);
	assert.strictEqual(
		pipelineRuns.dedupeBranchRunRel("align/run_a", "align"),
		"align/run_a",
	);
	var runs = pipelineRuns.migrateActiveRuns({
		active_runs: { pkls: "intensity/M465_run/intensity/M465_run" },
	});
	assert.strictEqual(runs.pkls, "intensity/M465_run");
}

function testCollectRunDeleteTargetsDoubled() {
	var bundle = helpers.tmpDir("mj-del-");
	var roles = { pkls: "data/counting/07_pkls" };
	var roleBase = path.join(bundle, roles.pkls);
	var doubled = path.join(roleBase, "intensity", "foo", "intensity", "foo");
	fs.mkdirSync(doubled, { recursive: true });
	fs.writeFileSync(path.join(doubled, "run_manifest.json"), "{}");
	var targets = pipelineRuns.collectRunDeleteTargets(
		bundle,
		roles,
		"pkls",
		"intensity/foo/intensity/foo",
	);
	assert.ok(targets.length >= 1);
	assert.ok(
		targets.some(function (t) {
			return t.abs === doubled;
		}),
	);
	assert.ok(
		pipelineRuns.isSafeRunDeleteTarget(bundle, roleBase, doubled),
		"doubled leaf is safe",
	);
	assert.ok(
		!pipelineRuns.isSafeRunDeleteTarget(bundle, roleBase, roleBase),
		"role base is not deletable",
	);
	helpers.rmDir(bundle);
}

function testRemoveRunForRoleClearsActive() {
	var bundle = helpers.tmpDir("mj-rm-");
	var roles = {
		dapi: project.CANONICAL_ROLES.dapi,
		slices: project.CANONICAL_ROLES.slices,
	};
	var slicesDir = path.join(bundle, roles.slices);
	var runDir = path.join(slicesDir, "align", "stuck_run");
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "run_manifest.json"), '{"status":"pending"}');
	fs.mkdirSync(path.join(bundle, ".masonjar"), { recursive: true });
	project.setActiveProject(bundle, {
		name: "test",
		roles: roles,
		processing: {
			active_runs: Object.assign(pipelineRuns.defaultActiveRuns(), {
				slices: "align/stuck_run",
			}),
		},
	});
	var result = pipelineRuns.removeRunForRole("slices", "align/stuck_run");
	assert.strictEqual(result.ok, true);
	assert.ok(!fs.existsSync(runDir));
	assert.strictEqual(pipelineRuns.getActiveRunRelForRole("slices"), "");
	project.clearActiveProject();
	helpers.rmDir(bundle);
}

var tests = [
	testBuildRunSlugStability,
	testResolveRunLeaf,
	testDiscoverOutputRuns,
	testMigrateActivePredictionRun,
	testDedupeBranchRunRel,
	testActiveRunScoping,
	testCollectRunDeleteTargetsDoubled,
	testRemoveRunForRoleClearsActive,
];

function runAll() {
	var chain = Promise.resolve();
	for (var j = 0; j < tests.length; j++) {
		(function (fn) {
			chain = chain.then(function () {
				var ret = fn();
				return ret && typeof ret.then === "function" ? ret : undefined;
			});
		})(tests[j]);
	}
	return chain.then(function () {
		console.log("test-pipeline-runs.js: OK (" + tests.length + " tests)");
	});
}

runAll().catch(function (err) {
	console.error(err);
	process.exit(1);
});
