"use strict";

var fs = require("fs");
var path = require("path");

var DEPRECATED_WARNING =
	"Use of deprecated tools detected on this project. Potential for corrupted data is HIGH!";

var OP_LABELS = {
	tissue_cleanup: "tissue edge cleanup",
	dapi_cleanup: "DAPI cleanup",
	orient: "orient",
};

function normalizeRel(rel) {
	return String(rel || "")
		.replace(/\\/g, "/")
		.replace(/^\/+/, "");
}

function classifyRel(rel) {
	var parts = normalizeRel(rel).split("/").filter(Boolean);
	if (parts[0] === "data" && parts[1] === "counting" && parts[2] === "00_dapi") {
		return "dapi";
	}
	if (parts[0] === "data" && parts[1] === "counting" && parts[2] === "_previews") {
		return "previews";
	}
	if (
		parts[0] === "data" &&
		parts[1] === "counting" &&
		parts[2] === "03_max" &&
		parts.length >= 5
	) {
		return "max:" + parts.slice(3, parts.length - 1).join("/");
	}
	return null;
}

function emptyLedger() {
	return { targets: {} };
}

function readLedger(bundleRoot) {
	if (!bundleRoot) {
		return emptyLedger();
	}
	var file = path.join(bundleRoot, ".masonjar", "image_operations.json");
	if (!fs.existsSync(file)) {
		return emptyLedger();
	}
	try {
		var data = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!data || typeof data !== "object" || !data.targets || typeof data.targets !== "object") {
			return emptyLedger();
		}
		return data;
	} catch (err) {
		return emptyLedger();
	}
}

function cloneLedger(ledger) {
	var copy = emptyLedger();
	var targets = (ledger && ledger.targets) || {};
	Object.keys(targets).forEach(function (key) {
		var ops = (targets[key] && targets[key].ops) || [];
		copy.targets[key] = { ops: ops.slice() };
	});
	return copy;
}

function hasTissueOp(ops) {
	return (ops || []).some(function (op) {
		return op && op.op === "tissue_cleanup";
	});
}

function synthesizeTissue(bundleRoot, ledger) {
	var copy = cloneLedger(ledger);
	if (!bundleRoot) {
		return copy;
	}
	var manifestPath = path.join(bundleRoot, ".masonjar", "tissue_cleanup_manifest.json");
	if (!fs.existsSync(manifestPath)) {
		return copy;
	}
	var manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	} catch (err) {
		return copy;
	}
	var slices = (manifest && manifest.slices) || {};
	var grouped = {};
	Object.keys(slices).forEach(function (sliceId) {
		var files = (slices[sliceId] && slices[sliceId].files_touched) || [];
		files.forEach(function (rel) {
			var key = classifyRel(rel);
			if (!key) {
				return;
			}
			if (!grouped[key]) {
				grouped[key] = { files: 0, slices: {} };
			}
			grouped[key].files += 1;
			grouped[key].slices[sliceId] = true;
		});
	});
	Object.keys(grouped).forEach(function (key) {
		var entry = copy.targets[key] || { ops: [] };
		if (hasTissueOp(entry.ops)) {
			copy.targets[key] = entry;
			return;
		}
		entry.ops = entry.ops.concat([
			{
				op: "tissue_cleanup",
				slices: Object.keys(grouped[key].slices).length,
				files: grouped[key].files,
				deprecated: false,
			},
		]);
		copy.targets[key] = entry;
	});
	return copy;
}

function displayLedger(bundleRoot) {
	return synthesizeTissue(bundleRoot, readLedger(bundleRoot));
}

function opsFor(ledger, key) {
	var entry = ledger && ledger.targets && ledger.targets[key];
	var ops = (entry && entry.ops) || [];
	return ops.filter(function (op) {
		return op && op.op;
	});
}

function formatOp(op) {
	var name = OP_LABELS[op.op] || String(op.op);
	if (op.slices) {
		return name + ", " + op.slices + " slices";
	}
	return name;
}

function notesFor(ledger, key) {
	return opsFor(ledger, key).map(function (op) {
		return {
			text: formatOp(op),
			deprecated: op.deprecated === true,
		};
	});
}

function hasDeprecated(ledger) {
	var targets = (ledger && ledger.targets) || {};
	return Object.keys(targets).some(function (key) {
		return opsFor(ledger, key).some(function (op) {
			return op.deprecated === true;
		});
	});
}

function hasAnyOps(ledger) {
	var targets = (ledger && ledger.targets) || {};
	return Object.keys(targets).some(function (key) {
		return opsFor(ledger, key).length > 0;
	});
}

function maxKeyForRel(rel) {
	var clean = normalizeRel(rel).replace(/\/+$/, "");
	if (!clean) {
		return null;
	}
	return "max:" + clean;
}

module.exports = {
	DEPRECATED_WARNING: DEPRECATED_WARNING,
	classifyRel: classifyRel,
	displayLedger: displayLedger,
	formatOp: formatOp,
	hasAnyOps: hasAnyOps,
	hasDeprecated: hasDeprecated,
	maxKeyForRel: maxKeyForRel,
	notesFor: notesFor,
	readLedger: readLedger,
};
