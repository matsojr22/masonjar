"use strict";

var assert = require("assert");
var path = require("path");
var fs = require("fs");
var preprocessWizard = require("../js/preprocess_wizard");

function testViewportRoi() {
	var state = { scale: 1, panX: -100, panY: -50, viewW: 512, viewH: 512 };
	var roi = preprocessWizard.viewportRoi(state, 2000, 1500);
	assert.ok(roi.w >= 32);
	assert.ok(roi.h >= 32);
	assert.ok(roi.x >= 0);
	assert.ok(roi.y >= 0);
}

function testScaleRoiForFullRes() {
	var roi = { x: 10, y: 20, w: 100, h: 80 };
	var scaled = preprocessWizard.scaleRoiForFullRes(roi, 500, 400, 2000, 1600);
	assert.strictEqual(scaled.x, 40);
	assert.strictEqual(scaled.y, 80);
	assert.strictEqual(scaled.w, 400);
	assert.strictEqual(scaled.h, 320);
	var same = preprocessWizard.scaleRoiForFullRes(roi, 100, 80, 100, 80);
	assert.deepStrictEqual(same, roi);
}

function testResolvePreviewFilterRequest() {
	var previewAbs = "C:\\bundle\\data\\counting\\_previews\\M528_s001_rabies.png";
	var tiffAbs = "C:\\bundle\\data\\counting\\03_max\\rabies\\max\\run\\M528_s001.tif";
	var roi = { x: 10, y: 20, w: 100, h: 80 };

	var onPreview = preprocessWizard.resolvePreviewFilterRequest(
		{
			baseAbs: previewAbs,
			baseNaturalW: 500,
			baseNaturalH: 400,
			fullNaturalW: 10000,
			fullNaturalH: 8000,
		},
		roi,
		tiffAbs,
	);
	assert.strictEqual(onPreview.ready, true);
	assert.strictEqual(onPreview.filterAbs, previewAbs);
	assert.deepStrictEqual(onPreview.roi, roi);

	var onFull = preprocessWizard.resolvePreviewFilterRequest(
		{
			baseAbs: tiffAbs,
			baseNaturalW: 10000,
			baseNaturalH: 8000,
			fullNaturalW: 10000,
			fullNaturalH: 8000,
		},
		roi,
		tiffAbs,
	);
	assert.strictEqual(onFull.ready, true);
	assert.strictEqual(onFull.filterAbs, tiffAbs);
	assert.strictEqual(onFull.roi.x, 10);
	assert.strictEqual(onFull.roi.w, 100);

	var deferred = preprocessWizard.resolvePreviewFilterRequest(
		{
			baseAbs: tiffAbs,
			baseNaturalW: 10000,
			baseNaturalH: 8000,
			fullNaturalW: 0,
			fullNaturalH: 0,
		},
		roi,
		tiffAbs,
	);
	assert.strictEqual(deferred.ready, false);
	assert.strictEqual(deferred.reason, "waiting_for_dimensions");
}

function testAutoStretchImageDataIfFlat() {
	var flat = {
		data: new Uint8ClampedArray([5, 5, 5, 255, 8, 8, 8, 255]),
		width: 2,
		height: 1,
	};
	var out = preprocessWizard.autoStretchImageDataIfFlat(flat);
	assert.ok(out.data[0] < out.data[4]);
	var bright = {
		data: new Uint8ClampedArray([100, 100, 100, 255, 200, 200, 200, 255]),
		width: 2,
		height: 1,
	};
	var unchanged = preprocessWizard.autoStretchImageDataIfFlat(bright);
	assert.strictEqual(unchanged.data[0], 100);
}

function testFindSignalPreviewAbs() {
	var helpers = require("./test-helpers");
	var bundle = helpers.tmpDir("mj-prev-");
	var prevDir = path.join(bundle, "data", "counting", "_previews");
	fs.mkdirSync(prevDir, { recursive: true });
	fs.writeFileSync(path.join(prevDir, "M528_s001_dapi.png"), "dapi");
	fs.writeFileSync(path.join(prevDir, "M528_s001_rabies.png"), "rabies");
	var rabies = preprocessWizard.findSignalPreviewAbs(
		bundle,
		"M528_s001.tif",
		"rabies",
	);
	assert.strictEqual(
		rabies,
		path.join(prevDir, "M528_s001_rabies.png"),
		"signal branch should pick rabies preview not dapi",
	);
	var missing = preprocessWizard.findSignalPreviewAbs(
		bundle,
		"M528_s002.tif",
		"somata",
	);
	assert.strictEqual(missing, "");
	helpers.rmDir(bundle);
}

function testIsProcessableTiffName() {
	assert.strictEqual(preprocessWizard.isProcessableTiffName("a.tif"), true);
	assert.strictEqual(preprocessWizard.isProcessableTiffName("b.ome.tiff"), true);
	assert.strictEqual(preprocessWizard.isProcessableTiffName("c.png"), false);
}

function testParsePreviewJson() {
	var line = 'PREVIEW_JSON:{"ok":true,"previewPath":"/tmp/x.png","width":100,"height":80}';
	var data = preprocessWizard.parsePreviewJsonLine(line);
	assert.strictEqual(data.ok, true);
	assert.strictEqual(data.width, 100);
}

function testNoAutoPreviewOnInteraction() {
	assert.strictEqual(preprocessWizard.shouldSchedulePreviewOnInteraction(), false);
}

function testApplyDisplayWindow() {
	var imgData = {
		data: new Uint8ClampedArray([50, 50, 50, 255, 150, 150, 150, 255, 200, 200, 200, 255]),
		width: 3,
		height: 1,
	};
	var out = preprocessWizard.applyDisplayWindow(imgData, 0, 255);
	assert.strictEqual(out.data[0], 50);
	var stretched = preprocessWizard.applyDisplayWindow(imgData, 100, 200);
	assert.ok(stretched.data[4] > 100);
}

testViewportRoi();
testScaleRoiForFullRes();
testResolvePreviewFilterRequest();
testAutoStretchImageDataIfFlat();
testFindSignalPreviewAbs();
testIsProcessableTiffName();
testParsePreviewJson();
testNoAutoPreviewOnInteraction();
testApplyDisplayWindow();
console.log("test-preprocess-wizard: ok");
