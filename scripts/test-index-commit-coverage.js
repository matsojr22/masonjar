"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");

var indexCommit = require("../js/index_commit");

function read(rel) {
	return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

function channelsInMain() {
	var text = read("src/main.ts");
	var found = {};
	var re = /ipcMain\.on\(\s*"(run[A-Za-z0-9]+)"/g;
	var match;
	while ((match = re.exec(text))) {
		found[match[1]] = true;
	}
	return Object.keys(found).sort();
}

function batchStepsInQueue() {
	var text = read("src/batch_queue.ts");
	var found = {};
	var re = /stepId === "([a-z0-9_]+)"/g;
	var match;
	while ((match = re.exec(text))) {
		found[match[1]] = true;
	}
	return Object.keys(found).sort();
}

function testEveryRunChannelIsRegistered() {
	var channels = channelsInMain();
	assert.ok(channels.length > 10, "expected run channels in src/main.ts");
	for (var i = 0; i < channels.length; i++) {
		assert.ok(
			indexCommit.RUN_CHANNEL_COMMIT[channels[i]],
			"missing index commit for " + channels[i],
		);
	}
	var registered = Object.keys(indexCommit.RUN_CHANNEL_COMMIT);
	for (var r = 0; r < registered.length; r++) {
		assert.ok(
			channels.indexOf(registered[r]) >= 0,
			"registry has unknown channel " + registered[r],
		);
	}
}

function testEveryBatchStepIsRegistered() {
	var steps = batchStepsInQueue();
	assert.ok(steps.indexOf("sharpen") >= 0);
	assert.ok(steps.indexOf("detect") >= 0);
	for (var i = 0; i < steps.length; i++) {
		assert.ok(
			indexCommit.BATCH_STEP_COMMIT[steps[i]],
			"missing batch index commit for " + steps[i],
		);
	}
}

testEveryRunChannelIsRegistered();
testEveryBatchStepIsRegistered();
console.log("test-index-commit-coverage: ok");
