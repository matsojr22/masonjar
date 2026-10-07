#!/usr/bin/env node
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var imageOps = require("../js/image_operations");

function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function testM581SummaryAndWarning() {
	var root = fs.mkdtempSync(path.join(os.tmpdir(), "mj-ops-"));
	var maxRel = "somata/max/M581-01(1)-M581-01(114)";
	writeJson(path.join(root, ".masonjar", "tissue_cleanup_manifest.json"), {
		ok: true,
		slices: {
			M581_s001: {
				files_touched: [
					"data/counting/00_dapi/M581_s001.png",
					"data/counting/_previews/M581_s001_dapi.png",
					"data/counting/03_max/" + maxRel + "/M581_s001.tif",
				],
			},
			M581_s002: {
				files_touched: [
					"data/counting/00_dapi/M581_s002.png",
					"data/counting/03_max/" + maxRel + "/M581_s002.tif",
				],
			},
		},
	});
	var ledger = imageOps.displayLedger(root);
	var dapi = imageOps.notesFor(ledger, "dapi");
	var maxNotes = imageOps.notesFor(ledger, imageOps.maxKeyForRel(maxRel));
	var seam = imageOps.notesFor(ledger, imageOps.maxKeyForRel("seam/_live_preview"));
	assert.strictEqual(dapi[0].text, "tissue edge cleanup, 2 slices");
	assert.strictEqual(dapi[0].deprecated, false);
	assert.strictEqual(maxNotes[0].text, "tissue edge cleanup, 2 slices");
	assert.strictEqual(seam.length, 0);
	assert.strictEqual(imageOps.hasDeprecated(ledger), false);
}

function testDeprecatedWarningExactAndCziOrientIsNot() {
	var deprecated = {
		targets: {
			dapi: {
				ops: [
					{ op: "tissue_cleanup", slices: 114, files: 117, deprecated: false },
					{ op: "dapi_cleanup", slices: 114, files: 117, deprecated: true },
				],
			},
		},
	};
	assert.strictEqual(imageOps.hasDeprecated(deprecated), true);
	assert.strictEqual(
		imageOps.DEPRECATED_WARNING,
		"Use of deprecated tools detected on this project. Potential for corrupted data is HIGH!",
	);
	var notes = imageOps.notesFor(deprecated, "dapi");
	assert.strictEqual(notes[0].text, "tissue edge cleanup, 114 slices");
	assert.strictEqual(notes[0].deprecated, false);
	assert.strictEqual(notes[1].text, "DAPI cleanup, 114 slices");
	assert.strictEqual(notes[1].deprecated, true);

	var cziOnly = {
		targets: {
			dapi: { ops: [{ op: "orient", slices: 10, files: 40, deprecated: false }] },
			previews: { ops: [{ op: "orient", slices: 10, files: 20, deprecated: false }] },
		},
	};
	assert.strictEqual(imageOps.hasDeprecated(cziOnly), false);
	assert.strictEqual(imageOps.notesFor(cziOnly, "dapi")[0].text, "orient, 10 slices");
}

function testLedgerTissueOpIsNotDuplicatedFromManifest() {
	var root = fs.mkdtempSync(path.join(os.tmpdir(), "mj-ops-"));
	writeJson(path.join(root, ".masonjar", "image_operations.json"), {
		targets: {
			dapi: {
				ops: [{ op: "tissue_cleanup", slices: 114, files: 117, deprecated: false }],
			},
		},
	});
	writeJson(path.join(root, ".masonjar", "tissue_cleanup_manifest.json"), {
		slices: {
			M581_s001: { files_touched: ["data/counting/00_dapi/M581_s001.png"] },
		},
	});
	var notes = imageOps.notesFor(imageOps.displayLedger(root), "dapi");
	assert.strictEqual(notes.length, 1);
	assert.strictEqual(notes[0].text, "tissue edge cleanup, 114 slices");
}

testM581SummaryAndWarning();
testDeprecatedWarningExactAndCziOrientIsNot();
testLedgerTissueOpIsNotDuplicatedFromManifest();
console.log("test-image-operations: ok");
