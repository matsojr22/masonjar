"use strict";

var assert = require("assert");
var preprocessWizard = require("../js/preprocess_wizard");

function testViewportRoi() {
	var state = { scale: 1, panX: -100, panY: -50, viewW: 512, viewH: 512 };
	var roi = preprocessWizard.viewportRoi(state, 2000, 1500);
	assert.ok(roi.w >= 32);
	assert.ok(roi.h >= 32);
	assert.ok(roi.x >= 0);
	assert.ok(roi.y >= 0);
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
testParsePreviewJson();
testNoAutoPreviewOnInteraction();
testApplyDisplayWindow();
console.log("test-preprocess-wizard: ok");
