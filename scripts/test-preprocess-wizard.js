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

testViewportRoi();
testParsePreviewJson();
console.log("test-preprocess-wizard: ok");
