"use strict";

var assert = require("assert");
var path = require("path");
var fs = require("fs");
var helpers = require("./test-helpers");

helpers.ensureLocalStorage();

var project = require("../js/project");
var pipelineRun = require("../js/pipeline_run");
var fileIndex = require("../js/file_index");

function matchedIndexFiles() {
	return [
		{
			sliceId: "M528_s061",
			role: "dapi",
			relPath: "data/counting/00_dapi/M528_s061.tif",
			metadata: { width: 512, height: 512 },
		},
		{
			sliceId: "M528_s061",
			role: "max",
			relPath: "data/counting/03_max/M528_s061.tif",
			metadata: { width: 512, height: 512 },
		},
		{
			sliceId: "M528_s062",
			role: "dapi",
			relPath: "data/counting/00_dapi/M528_s062.tif",
			metadata: { width: 512, height: 512 },
		},
		{
			sliceId: "M528_s062",
			role: "max",
			relPath: "data/counting/03_max/M528_s062.tif",
			metadata: { width: 512, height: 512 },
		},
	];
}

function setupBundle() {
	var bundle = helpers.tmpDir("mj-pipe-");
	project.createProject({ bundleRoot: bundle, name: "TestBrain" });
	helpers.writeFileIndex(bundle, matchedIndexFiles());
	return bundle;
}

function testInactiveProject() {
	project.clearActiveProject();
	var result = pipelineRun.preparePipelineRun("align", "merge");
	assert.strictEqual(result.sliceListPath, "");
	assert.deepStrictEqual(result.toProcess, []);
}

function testPrepareMergeAlign() {
	var bundle = setupBundle();
	var slicesDir = path.join(bundle, project.CANONICAL_ROLES.slices);
	fs.mkdirSync(slicesDir, { recursive: true });
	fs.writeFileSync(path.join(slicesDir, "Annotation_M528_s061.pkl"), "x");

	var result = pipelineRun.preparePipelineRun("align", "merge");
	assert.ok(result.summary.indexOf("Processing 1 slice") >= 0);
	assert.deepStrictEqual(result.toProcess, ["M528_s062"]);
	assert.equal(result.skipped.length, 1);
	assert.ok(result.sliceListPath);
	assert.ok(fs.existsSync(result.sliceListPath));
	var list = JSON.parse(fs.readFileSync(result.sliceListPath, "utf8"));
	assert.deepStrictEqual(list.slice_ids, ["M528_s062"]);

	project.clearActiveProject();
	helpers.rmDir(bundle);
}

function testPrepareOverwriteAlign() {
	var bundle = setupBundle();
	var slicesDir = path.join(bundle, project.CANONICAL_ROLES.slices);
	fs.mkdirSync(slicesDir, { recursive: true });
	fs.writeFileSync(path.join(slicesDir, "Annotation_M528_s061.pkl"), "x");

	var result = pipelineRun.preparePipelineRun("align", "overwrite");
	assert.deepStrictEqual(result.toProcess, ["M528_s061", "M528_s062"]);
	assert.equal(result.skipped.length, 0);

	project.clearActiveProject();
	helpers.rmDir(bundle);
}

function testPrepareSubset() {
	var bundle = setupBundle();
	var proj = project.getProject();
	proj.processing.subset_enabled = true;
	proj.processing.slice_ids = ["M528_s061"];
	project.saveProjectJson();

	var result = pipelineRun.preparePipelineRun("align", "overwrite");
	assert.deepStrictEqual(result.toProcess, ["M528_s061"]);

	project.clearActiveProject();
	helpers.rmDir(bundle);
}

function testPrepareNoIndex() {
	var bundle = helpers.tmpDir("mj-pipe-empty-");
	project.createProject({ bundleRoot: bundle, name: "Empty" });
	var result = pipelineRun.preparePipelineRun("align", "merge");
	assert.strictEqual(result.sliceListPath, "");
	assert.deepStrictEqual(result.toProcess, []);

	project.clearActiveProject();
	helpers.rmDir(bundle);
}

function testPlanRunReexport() {
	var bundle = setupBundle();
	var roles = project.getProject().roles;
	var report = fileIndex.computeMatchReport(
		{ files: matchedIndexFiles() },
		fileIndex.INPUT_MATCH_ROLES,
	);
	var ids = fileIndex.getProcessingSliceIds(bundle, project.getProject(), null, report);
	assert.deepStrictEqual(ids, ["M528_s061", "M528_s062"]);

	project.clearActiveProject();
	helpers.rmDir(bundle);
}

var tests = [
	testInactiveProject,
	testPrepareMergeAlign,
	testPrepareOverwriteAlign,
	testPrepareSubset,
	testPrepareNoIndex,
	testPlanRunReexport,
];

for (var i = 0; i < tests.length; i++) {
	tests[i]();
}

console.log("test-pipeline-run.js: OK (" + tests.length + " tests)");
