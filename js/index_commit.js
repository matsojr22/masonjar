"use strict";

var fs = require("fs");
var path = require("path");
var fileIndex = require("./file_index");
var pipelineRuns = require("./pipeline_runs");

/**
 * Every ipcMain run channel and every batch step is listed here.
 * action is recordLeaf, updateFiles, recordRoles, or exempt.
 */
var RUN_CHANNEL_COMMIT = {
	runIndexMetadata: { action: "exempt", reason: "read" },
	runMax: { action: "recordLeaf", role: "max" },
	runAdjust: { action: "updateFiles", role: "slices" },
	runAlign: { action: "recordLeaf", role: "slices" },
	runIntensity: { action: "recordLeaf", role: "pkls" },
	runExportDualTif: { action: "recordLeaf", role: "dual" },
	runCount: { action: "recordLeaf", role: "quantification" },
	runCollate: { action: "recordLeaf", role: "quantification" },
	runAnnotationLabelAudit: { action: "exempt", reason: "read" },
	runSharpenPreview: { action: "exempt", reason: "preview" },
	runTophatPreview: { action: "exempt", reason: "preview" },
	runTophat: { action: "recordLeaf", role: "max" },
	runSharpen: { action: "recordLeaf", role: "max" },
	runBasicPreview: { action: "exempt", reason: "preview" },
	runBasic: { action: "recordLeaf", role: "max" },
	runParcellation: { action: "updateFiles", role: "slices" },
	runDapiCleanup: { action: "updateFiles", role: "dapi" },
	runTissueCleanupAuto: { action: "exempt", reason: "preview" },
	runTissueCleanupGuided: { action: "exempt", reason: "preview" },
	runTissueCleanupApply: { action: "updateFiles", role: "max" },
	runDetection: { action: "recordLeaf", role: "predictions" },
	runDetectRaw: { action: "recordLeaf", role: "detect_raw" },
	runDetectDisplayImage: { action: "updateFiles", role: "detect_raw" },
	runDetectIntensityEstimate: { action: "exempt", reason: "preview" },
	runDetectAdjustPreview: { action: "exempt", reason: "preview" },
	runDetectAdjustApply: { action: "updateFiles", role: "predictions" },
	runCziProbe: { action: "exempt", reason: "read" },
	runCziImport: { action: "recordRoles", roles: ["dapi", "original_scans", "max", "previews"] },
	runApplyGeometry: { action: "updateFiles", role: "max" },
	runGeometryFingerprintProbe: { action: "exempt", reason: "read" },
	runBatch: { action: "exempt", reason: "batch-driver" },
};

var BATCH_STEP_COMMIT = {
	max: { action: "recordLeaf", role: "max" },
	sharpen: { action: "recordLeaf", role: "max" },
	tophat: { action: "recordLeaf", role: "max" },
	basic: { action: "recordLeaf", role: "max" },
	detect: { action: "recordLeaf", role: "predictions" },
	detect_qc: { action: "recordLeaf", role: "predictions", qcScout: true },
	count: { action: "recordLeaf", role: "quantification" },
	intensity: { action: "recordLeaf", role: "pkls" },
	dual: { action: "recordLeaf", role: "dual" },
	apply_geometry: { action: "updateFiles", role: "max" },
	parcellation: { action: "updateFiles", role: "slices" },
	collate: { action: "recordLeaf", role: "quantification" },
	dapi_cleanup: { action: "updateFiles", role: "dapi" },
};

function metaDir(bundleRoot) {
	return path.join(bundleRoot, ".masonjar");
}

function leafRelFromOutput(bundleRoot, role, outputAbs) {
	if (!bundleRoot || !outputAbs) {
		return "";
	}
	var roles = pipelineRuns.CANONICAL_ROLES;
	var rel = roles[role];
	if (!rel) {
		var fromBundle = path.relative(bundleRoot, outputAbs).split(path.sep).join("/");
		var slash = fromBundle.lastIndexOf("/");
		return slash >= 0 ? fromBundle.slice(0, slash) : fromBundle;
	}
	var base = path.join(bundleRoot, rel);
	var leaf = path.relative(base, outputAbs).split(path.sep).join("/");
	if (!leaf || leaf.indexOf("..") === 0) {
		return "";
	}
	return leaf;
}

function changedFilesUnder(absDir) {
	var out = [];
	if (!absDir || !fs.existsSync(absDir)) {
		return out;
	}
	var entries;
	try {
		entries = fs.readdirSync(absDir, { withFileTypes: true });
	} catch (_err) {
		return out;
	}
	for (var i = 0; i < entries.length; i++) {
		if (entries[i].isFile()) {
			out.push(path.join(absDir, entries[i].name));
		}
	}
	return out;
}

function commitRecordLeaf(bundleRoot, spec, info) {
	var outputAbs = info.outputAbs || info.leafAbs || "";
	var leafRel = info.leafRel || leafRelFromOutput(bundleRoot, spec.role, outputAbs);
	if (!outputAbs || !leafRel) {
		throw new Error("index commit for " + spec.role + " needs the output directory");
	}
	return fileIndex.recordLeaf(bundleRoot, metaDir(bundleRoot), {
		absDir: outputAbs,
		role: spec.role,
		leafRel: leafRel,
		qcScout: !!(spec.qcScout || info.qcScout),
	});
}

function commitUpdate(bundleRoot, info) {
	var paths = info.absPaths || info.files || [];
	if ((!paths || !paths.length) && info.outputAbs) {
		paths = changedFilesUnder(info.outputAbs);
	}
	if (!paths.length && info.leafAbs) {
		paths = changedFilesUnder(info.leafAbs);
	}
	return fileIndex.updateFiles(bundleRoot, metaDir(bundleRoot), paths);
}

function commitChannel(channel, info) {
	info = info || {};
	var spec = RUN_CHANNEL_COMMIT[channel];
	if (!spec) {
		throw new Error("No index commit is registered for " + channel);
	}
	if (spec.action === "exempt") {
		return { ok: true, exempt: true };
	}
	var bundleRoot = info.bundleRoot;
	if (!bundleRoot) {
		throw new Error(channel + " index commit needs a bundle root");
	}
	if (spec.action === "recordLeaf") {
		commitRecordLeaf(bundleRoot, spec, info);
		return { ok: true };
	}
	if (spec.action === "updateFiles") {
		commitUpdate(bundleRoot, info);
		return { ok: true };
	}
	if (spec.action === "recordRoles") {
		if (info.outputAbs) {
			commitRecordLeaf(bundleRoot, { role: "max" }, info);
		}
		commitUpdate(bundleRoot, info);
		return { ok: true };
	}
	throw new Error("Unknown index commit action for " + channel);
}

function restatIndexedFiles(bundleRoot) {
	var index = fileIndex.readFileIndex(bundleRoot, metaDir(bundleRoot));
	var paths = [];
	var rows = (index && index.files) || [];
	for (var i = 0; i < rows.length; i++) {
		if (!rows[i].relPath) {
			continue;
		}
		paths.push(path.join(bundleRoot, rows[i].relPath.split("/").join(path.sep)));
	}
	return fileIndex.updateFiles(bundleRoot, metaDir(bundleRoot), paths);
}

function commitProjectChannel(channel, leafRel) {
	var project = require("./project");
	if (!project.isActive || !project.isActive()) {
		return { ok: true, skipped: true };
	}
	var bundleRoot = project.getBundleRoot();
	var spec = RUN_CHANNEL_COMMIT[channel];
	if (!spec) {
		throw new Error("No index commit is registered for " + channel);
	}
	if (spec.action === "exempt") {
		return commitChannel(channel, { bundleRoot: bundleRoot });
	}
	if (channel === "runDapiCleanup") {
		commitUpdate(bundleRoot, {
			outputAbs: path.join(bundleRoot, "data", "counting", "00_dapi"),
		});
		return { ok: true };
	}
	if (channel === "runParcellation" || channel === "runAdjust") {
		var slicesRel = pipelineRuns.getActiveRunRelForRole("slices");
		var slicesAbs = slicesRel
			? path.join(bundleRoot, "data", "counting", "01_slices", slicesRel.split("/").join(path.sep))
			: "";
		commitUpdate(bundleRoot, { outputAbs: slicesAbs });
		return { ok: true };
	}
	if (channel === "runDetectAdjustApply") {
		var predRel = leafRel || pipelineRuns.getActiveRunRelForRole("predictions");
		var predAbs = predRel
			? path.join(
					bundleRoot,
					"data",
					"counting",
					"05_predictions",
					predRel.split("/").join(path.sep),
				)
			: "";
		commitUpdate(bundleRoot, { outputAbs: predAbs });
		return { ok: true };
	}
	if (spec.action === "updateFiles" && (channel === "runApplyGeometry" || channel === "runTissueCleanupApply")) {
		restatIndexedFiles(bundleRoot);
		return { ok: true };
	}
	var outputAbs = "";
	if (leafRel && spec.role && pipelineRuns.CANONICAL_ROLES[spec.role]) {
		outputAbs = path.join(
			bundleRoot,
			pipelineRuns.CANONICAL_ROLES[spec.role],
			String(leafRel).split("/").join(path.sep),
		);
	}
	if (spec.action === "recordLeaf" && !outputAbs) {
		throw new Error(channel + " finished without a leaf to record");
	}
	return commitChannel(channel, {
		bundleRoot: bundleRoot,
		leafRel: leafRel || "",
		outputAbs: outputAbs,
	});
}

function commitBatchStep(bundleRoot, stepId, outputAbs, leafRel) {
	var spec = BATCH_STEP_COMMIT[stepId];
	if (!spec) {
		throw new Error("No index commit is registered for batch step " + stepId);
	}
	if (spec.action === "exempt") {
		return { ok: true, exempt: true };
	}
	if (spec.action === "recordLeaf") {
		commitRecordLeaf(
			bundleRoot,
			spec,
			{ outputAbs: outputAbs, leafRel: leafRel, bundleRoot: bundleRoot, qcScout: spec.qcScout },
		);
		return { ok: true };
	}
	if (spec.action === "updateFiles") {
		commitUpdate(bundleRoot, { outputAbs: outputAbs, bundleRoot: bundleRoot });
		return { ok: true };
	}
	throw new Error("Unknown batch index commit action for " + stepId);
}

module.exports = {
	RUN_CHANNEL_COMMIT: RUN_CHANNEL_COMMIT,
	BATCH_STEP_COMMIT: BATCH_STEP_COMMIT,
	commitChannel: commitChannel,
	commitBatchStep: commitBatchStep,
	commitProjectChannel: commitProjectChannel,
	leafRelFromOutput: leafRelFromOutput,
};
