"use strict";

var assert = require("assert");
var alignIpc = require("../js/align_ipc");

function testClassifyDone() {
	assert.strictEqual(alignIpc.classifyAlignStdoutMessage("Done!"), "done");
}

function testClassifyViewerClosed() {
	assert.strictEqual(
		alignIpc.classifyAlignStdoutMessage("Viewer closed"),
		"viewer_closed",
	);
}

function testClassifyProgress() {
	assert.strictEqual(
		alignIpc.classifyAlignStdoutMessage("Awaiting fine tuning..."),
		"other",
	);
}

function testAlignResultPayloads() {
	assert.deepStrictEqual(alignIpc.alignResultPayloadForKind("done"), {
		cancelled: false,
	});
	assert.deepStrictEqual(alignIpc.alignResultPayloadForKind("viewer_closed"), {
		cancelled: true,
	});
}

function testSideEffects() {
	assert.strictEqual(alignIpc.shouldApplyAlignRunSideEffects(null), true);
	assert.strictEqual(alignIpc.shouldApplyAlignRunSideEffects({ cancelled: false }), true);
	assert.strictEqual(alignIpc.shouldApplyAlignRunSideEffects({ cancelled: true }), false);
}

testClassifyViewerClosed();
testClassifyProgress();
testAlignResultPayloads();
testViewerToolHelpers();
testSideEffects();
console.log("test-align-ipc.js: OK");

function testViewerToolHelpers() {
	assert.strictEqual(
		alignIpc.classifyViewerToolStdoutMessage("Viewer closed"),
		"viewer_closed",
	);
	assert.deepStrictEqual(
		alignIpc.viewerToolResultPayloadForKind("viewer_closed"),
		{ cancelled: true },
	);
	assert.strictEqual(alignIpc.shouldApplyViewerToolSideEffects({ cancelled: true }), false);
}
