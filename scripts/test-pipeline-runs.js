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

var tests = [
	testBuildRunSlugStability,
	testResolveRunLeaf,
	testDiscoverOutputRuns,
	testMigrateActivePredictionRun,
	testActiveRunScoping,
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
