"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var helpers = require("./test-helpers");

helpers.ensureLocalStorage();

var bundleSlicePaths = require("../js/bundle_slice_paths");

function makeBundle() {
	var bundle = helpers.tmpDir("mj-tcp-");
	var sliceId = "M528_s001";
	var sharpen = path.join(
		bundle,
		"data/counting/03_max/somata/sharpen/run_a",
		sliceId + ".tif",
	);
	var tophat = path.join(
		bundle,
		"data/counting/03_max/somata/tophat/top10_run",
		sliceId + ".tif",
	);
	for (var p of [sharpen, tophat]) {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "tif");
	}
	return { bundle: bundle, sliceId: sliceId };
}

function testPathsIncludeSharpenTophat() {
	var fx = makeBundle();
	try {
		var paths = bundleSlicePaths.pathsForSlice(fx.bundle, fx.sliceId, {
			channels: [{ role: "signal_somata", keep: true }],
		});
		var joined = paths.join("|");
		assert.ok(joined.indexOf("sharpen") >= 0, "expected sharpen path");
		assert.ok(joined.indexOf("tophat") >= 0, "expected tophat path");
	} finally {
		helpers.rmDir(fx.bundle);
	}
}

testPathsIncludeSharpenTophat();
console.log("test-tissue-cleanup-paths: ok");
