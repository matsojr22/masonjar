"use strict";

var assert = require("assert");
var helpers = require("./test-helpers");

helpers.ensureLocalStorage();

var registry = require("../js/batch_registry");

function testStepOrderIncludesNewSteps() {
	assert.ok(registry.BATCH_STEP_ORDER.indexOf("apply_geometry") >= 0);
	assert.ok(registry.BATCH_STEP_ORDER.indexOf("dapi_cleanup") >= 0);
	assert.ok(registry.BATCH_STEP_ORDER.indexOf("collate") >= 0);
	assert.ok(registry.BATCH_STEP_ORDER.indexOf("max") >= 0);
	assert.ok(registry.BATCH_STEP_ORDER.indexOf("sharpen") >= 0);
	assert.ok(registry.BATCH_STEP_ORDER.indexOf("detect") >= 0);
}

function testStepMetaShape() {
	var keys = Object.keys(registry.STEP_META);
	for (var i = 0; i < keys.length; i++) {
		var meta = registry.STEP_META[keys[i]];
		assert.ok(meta.id, "meta.id missing for " + keys[i]);
		assert.ok(meta.label, "meta.label missing for " + keys[i]);
		assert.ok(typeof meta.order === "number", "meta.order missing for " + keys[i]);
	}
}

function testSortSteps() {
	var sorted = registry.sortSteps([
		"collate",
		"detect",
		"apply_geometry",
		"max",
	]);
	assert.deepStrictEqual(sorted, [
		"apply_geometry",
		"max",
		"detect",
		"collate",
	]);
}

function testDependencyGraphMaxFanout() {
	var downstream = registry.DEPENDENCY_GRAPH.max || [];
	assert.ok(downstream.indexOf("sharpen") >= 0);
	assert.ok(downstream.indexOf("detect") >= 0);
	assert.ok(downstream.indexOf("intensity") >= 0);
	assert.ok(downstream.indexOf("count") >= 0);
	assert.ok(downstream.indexOf("collate") >= 0);
	assert.ok(downstream.indexOf("dual") >= 0);
}

function testGetDownstreamSteps() {
	var downstream = registry.getDownstreamSteps("max");
	assert.ok(downstream.length > 0);
	assert.ok(downstream.indexOf("sharpen") >= 0);
	assert.deepStrictEqual(
		registry.getDownstreamSteps("dual"),
		[],
	);
}

function testComputeSkipDownstream() {
	var plan = {
		projects: [{ path: "/tmp/p1", name: "p1" }],
		steps: ["max", "sharpen", "detect", "count", "collate"],
	};
	// Failure of max for p1 should cascade to all downstream steps for p1.
	var failures = { "/tmp/p1": { max: true } };
	var skipped = registry.computeSkipDownstream(plan, failures);
	assert.ok(skipped["/tmp/p1"], "skip map should have entry for the failed project");
	assert.ok(skipped["/tmp/p1"].sharpen, "sharpen should be skipped after max failure");
	assert.ok(skipped["/tmp/p1"].detect, "detect should be skipped after max failure");
	assert.ok(skipped["/tmp/p1"].count, "count should be skipped after max failure");
	assert.ok(!skipped["/tmp/p1"].max, "max itself should not be in the downstream skip set");
}

function testValidateBatchPlanRequiresProjects() {
	var errors = registry.validateBatchPlan({ projects: [], steps: ["max"] });
	assert.ok(errors.length > 0);
	assert.ok(errors[0].toLowerCase().indexOf("project") >= 0);
}

function testValidateBatchPlanRequiresSteps() {
	var errors = registry.validateBatchPlan({
		projects: [{ path: "/tmp/p1", name: "p1" }],
		steps: [],
	});
	assert.ok(errors.length > 0);
	assert.ok(errors[0].toLowerCase().indexOf("step") >= 0);
}

function testValidateBatchPlanIntensityNeedsRegions() {
	var errors = registry.validateBatchPlan({
		projects: [{ path: "/tmp/p1", name: "p1" }],
		steps: ["intensity"],
		intensity: { selected_region_ids: [] },
	});
	assert.ok(
		errors.some(function (e) {
			return e.toLowerCase().indexOf("region") >= 0;
		}),
	);
}

function testValidateBatchPlanCollateNeedsTwo() {
	var errors = registry.validateBatchPlan({
		projects: [{ path: "/tmp/p1", name: "p1" }],
		steps: ["collate"],
	});
	assert.ok(
		errors.some(function (e) {
			return e.toLowerCase().indexOf("collate") >= 0;
		}),
	);
}

function testDefaultParamsExist() {
	assert.ok(registry.DEFAULT_PARAMS.max);
	assert.ok(registry.DEFAULT_PARAMS.sharpen);
	assert.ok(registry.DEFAULT_PARAMS.detect);
	assert.ok(registry.DEFAULT_PARAMS.intensity);
	assert.ok(registry.DEFAULT_PARAMS.dapi_cleanup);
	assert.ok(registry.DEFAULT_PARAMS.apply_geometry);
	assert.ok(registry.DEFAULT_PARAMS.collate);
}

function run() {
	testStepOrderIncludesNewSteps();
	testStepMetaShape();
	testSortSteps();
	testDependencyGraphMaxFanout();
	testGetDownstreamSteps();
	testComputeSkipDownstream();
	testValidateBatchPlanRequiresProjects();
	testValidateBatchPlanRequiresSteps();
	testValidateBatchPlanIntensityNeedsRegions();
	testValidateBatchPlanCollateNeedsTwo();
	testDefaultParamsExist();
	console.log("test-batch-plan: PASS");
}

run();
