"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var helpers = require("./test-helpers");

var detectCommon = require("../js/detect_common");

function makeLeaves() {
	var bundle = helpers.tmpDir("mj-detect-src-");
	var maxBase = path.join(bundle, "data", "counting", "03_max");
	var runA = path.join(maxBase, "somata", "max", "runA");
	var runB = path.join(maxBase, "somata", "sharpen", "runB");
	fs.mkdirSync(runA, { recursive: true });
	fs.mkdirSync(runB, { recursive: true });
	return { bundle: bundle, maxBase: maxBase, runA: runA, runB: runB };
}

function catalog() {
	return [
		{ rel: "somata/max/runA" },
		{ rel: "somata/sharpen/runB" },
	];
}

function testCatalogMatchIgnoresOtherLeaf() {
	var leaves = makeLeaves();
	fs.writeFileSync(path.join(leaves.runA, "M466_s005.tif"), "a");
	fs.writeFileSync(path.join(leaves.runB, "M466_s005.tif"), "b");
	var moved =
		"Z:\\lab\\M466_masonjar\\data\\counting\\03_max\\somata\\max\\runA";
	var located = detectCommon.resolveDetectSourceImage({
		sliceId: "M466_s005",
		manifest: { input_dir: moved },
		bundleRoot: leaves.bundle,
		maxBaseAbs: leaves.maxBase,
		catalogRels: catalog(),
	});
	assert.strictEqual(located.image, path.join(leaves.runA, "M466_s005.tif"));
	assert.ok(located.image.indexOf("runB") < 0);
	helpers.rmDir(leaves.bundle);
}

function testDoesNotUseADifferentLeafWhenSliceIsMissing() {
	var leaves = makeLeaves();
	fs.writeFileSync(path.join(leaves.runB, "M466_s005.tif"), "b");
	var moved =
		"Z:\\lab\\M466_masonjar\\data\\counting\\03_max\\somata\\max\\runA";
	var located = detectCommon.resolveDetectSourceImage({
		sliceId: "M466_s005",
		manifest: { input_dir: moved },
		bundleRoot: leaves.bundle,
		maxBaseAbs: leaves.maxBase,
		catalogRels: catalog(),
	});
	assert.strictEqual(located.image, "");
	assert.ok(located.message.indexOf(leaves.runA) >= 0);
	assert.ok(located.message.indexOf("runB") < 0);
	helpers.rmDir(leaves.bundle);
}

function testCaseInsensitiveStem() {
	var leaves = makeLeaves();
	fs.writeFileSync(path.join(leaves.runA, "m466_s005.TIF"), "a");
	var located = detectCommon.resolveDetectSourceImage({
		sliceId: "M466_s005",
		manifest: { input_dir: leaves.runA },
		bundleRoot: leaves.bundle,
		maxBaseAbs: leaves.maxBase,
		catalogRels: catalog(),
	});
	assert.strictEqual(located.image, path.join(leaves.runA, "m466_s005.TIF"));
	helpers.rmDir(leaves.bundle);
}

function testStoredRelBeatsAbsolutePath() {
	var leaves = makeLeaves();
	fs.writeFileSync(path.join(leaves.runA, "M466_s005.tif"), "from-rel");
	fs.writeFileSync(path.join(leaves.runB, "M466_s005.tif"), "from-abs");
	var located = detectCommon.resolveDetectSourceImage({
		sliceId: "M466_s005",
		manifest: {
			input_dir: leaves.runB,
			input_dataset_rel: "somata/max/runA",
		},
		bundleRoot: leaves.bundle,
		maxBaseAbs: leaves.maxBase,
		catalogRels: catalog(),
	});
	assert.strictEqual(located.image, path.join(leaves.runA, "M466_s005.tif"));
	var body = fs.readFileSync(located.image, "utf8");
	assert.strictEqual(body, "from-rel");
	helpers.rmDir(leaves.bundle);
}

function testMissingRecordedFolder() {
	var leaves = makeLeaves();
	var moved = "Z:\\lab\\M466_masonjar\\data\\counting\\03_max\\somata\\max\\gone";
	var located = detectCommon.resolveDetectSourceImage({
		sliceId: "M466_s005",
		manifest: { input_dir: moved },
		bundleRoot: leaves.bundle,
		maxBaseAbs: leaves.maxBase,
		catalogRels: catalog(),
	});
	assert.strictEqual(located.image, "");
	assert.strictEqual(located.recordedExists, false);
	assert.ok(located.message.indexOf("missing") >= 0);
	assert.ok(located.message.indexOf(moved) >= 0);
	helpers.rmDir(leaves.bundle);
}

testCatalogMatchIgnoresOtherLeaf();
testDoesNotUseADifferentLeafWhenSliceIsMissing();
testCaseInsensitiveStem();
testStoredRelBeatsAbsolutePath();
testMissingRecordedFolder();
console.log("test-detect-source-image: ok");
