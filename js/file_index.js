"use strict";

var fs = require("fs");
var path = require("path");
var { ipcRenderer } = require("electron");
var homeDir = require("./home_dir");
var pipelineRuns = require("./pipeline_runs");

var FILE_INDEX_VERSION = 2;
var MANIFEST_V2 = 2;

var SCAN_ROLES = [
	"dapi",
	"slices",
	"max",
	"predictions",
	"quantification",
	"pkls",
	"dual",
];

var INPUT_MATCH_ROLES = ["dapi", "max", "slices"];

/** Steps that require a successful align warp; others (align retry, dapi_cleanup, …) may run. */
var STEPS_BLOCKED_BY_ALIGN_FAILURE = {
	count: true,
	intensity: true,
	dual: true,
	collate: true,
	adjust: true,
};

var FLAT_INDEX_ROLES = ["original_scans", "dapi"];

var STEP_OUTPUT = {
	max: { role: "max", step: "max" },
	sharpen: { role: "max", step: "sharpen" },
	tophat: { role: "max", step: "tophat" },
	align: { role: "slices", step: "align" },
	intensity: { role: "pkls", step: "intensity" },
	detect: { role: "predictions", step: "detect" },
	count: { role: "quantification", step: "count" },
	collate: { role: "quantification", step: "collate" },
	dual: { role: "dual", step: "dual" },
};

var IMAGE_EXT_RE = /\.(tif|tiff|png|jpe?g)$/i;

function resolveEnvPython() {
	var home = homeDir.masonHomePath();
	if (process.platform === "win32") {
		return path.join(home, "benv", "Scripts", "python.exe");
	}
	return path.join(home, "benv", "bin", "python3");
}

function sliceIdFromFilename(filename) {
	var stem = path.parse(filename).name;
	if (stem.toLowerCase().endsWith(".ome")) {
		stem = path.parse(stem).name;
	}
	var dot = stem.indexOf(".");
	return dot >= 0 ? stem.slice(0, dot) : stem;
}

function sliceStemFromPredictionPklBasename(basename) {
	var stem = basename.replace(/\.pkl$/i, "");
	if (/^predictions_/i.test(stem)) {
		stem = stem.replace(/^predictions_/i, "");
	}
	return sliceIdFromFilename(stem + ".pkl");
}

function sliceStemFromAnnotationPklBasename(basename) {
	var stem = basename.replace(/\.pkl$/i, "");
	var lower = stem.toLowerCase();
	if (lower.startsWith("annotation_")) {
		stem = stem.slice(11);
	} else if (lower.startsWith("annotations_")) {
		stem = stem.slice(12);
	}
	return sliceIdFromFilename(stem + ".pkl");
}

/**
 * Align outputs under a single directory leaf (no sibling run merge).
 */
function listSlicesRoleFilePaths(absDir, maxDepth) {
	maxDepth = maxDepth == null ? 0 : maxDepth;
	var images = [];
	var pkls = [];
	function walk(dir, depth) {
		if (!dir || !fs.existsSync(dir) || depth > maxDepth) {
			return;
		}
		var entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			return;
		}
		for (var i = 0; i < entries.length; i++) {
			var ent = entries[i];
			var full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full, depth + 1);
				continue;
			}
			if (!ent.isFile()) {
				continue;
			}
			if (/\.pkl$/i.test(ent.name) && !/^predictions_/i.test(ent.name)) {
				pkls.push(full);
			} else if (
				IMAGE_EXT_RE.test(ent.name) ||
				ent.name.toLowerCase().indexOf(".ome.") !== -1
			) {
				images.push(full);
			}
		}
	}
	walk(absDir, 0);
	return { images: images, pkls: pkls };
}

function listPredictionPklRecords(absDir, bundleRoot, maxDepth) {
	maxDepth = maxDepth == null ? 2 : maxDepth;
	var records = [];
	function walk(dir, depth) {
		if (!dir || !fs.existsSync(dir) || depth > maxDepth) {
			return;
		}
		var entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			return;
		}
		for (var i = 0; i < entries.length; i++) {
			var ent = entries[i];
			var full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full, depth + 1);
				continue;
			}
			if (!/^predictions_.*\.pkl$/i.test(ent.name)) {
				continue;
			}
			var st = fs.statSync(full);
			var sliceId = sliceStemFromPredictionPklBasename(ent.name);
			var relPath = path.relative(bundleRoot, full).split(path.sep).join("/");
			records.push({
				sliceId: sliceId,
				role: "predictions",
				relPath: relPath,
				basename: ent.name,
				size: st.size,
				mtime: st.mtime.toISOString(),
				metadata: {},
				orientation: { aspectRatio: null, landscape: null, exifOrientation: null },
				outputs: {},
			});
		}
	}
	walk(absDir, 0);
	return records;
}

function listImageFiles(dir) {
	if (!dir || !fs.existsSync(dir)) {
		return [];
	}
	var out = [];
	var entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		return [];
	}
	for (var i = 0; i < entries.length; i++) {
		if (!entries[i].isFile()) {
			continue;
		}
		var name = entries[i].name;
		if (IMAGE_EXT_RE.test(name) || name.toLowerCase().indexOf(".ome.") !== -1) {
			out.push(path.join(dir, name));
		}
	}
	return out;
}

function orientationFromMeta(meta) {
	var w = meta && meta.width;
	var h = meta && meta.height;
	if (!w || !h) {
		return { aspectRatio: null, landscape: null, exifOrientation: null };
	}
	return {
		aspectRatio: w / h,
		landscape: w > h,
		exifOrientation: null,
	};
}

var METADATA_BATCH_SIZE = 40;

function fetchMetadataBatchChunk(filePaths) {
	if (!ipcRenderer || typeof ipcRenderer.on !== "function") {
		return Promise.resolve({});
	}
	return new Promise(function (resolve) {
		var reqId =
			"meta_" + Date.now() + "_" + Math.random().toString(36).slice(2);
		function onResult(_event, payload) {
			if (!payload || payload.reqId !== reqId) {
				return;
			}
			ipcRenderer.removeListener("indexMetadataResult", onResult);
			resolve(payload.map || {});
		}
		ipcRenderer.on("indexMetadataResult", onResult);
		try {
			ipcRenderer.send("runIndexMetadata", { reqId: reqId, paths: filePaths });
		} catch (err) {
			ipcRenderer.removeListener("indexMetadataResult", onResult);
			resolve({});
		}
	});
}

function fetchMetadataBatch(filePaths, appRoot) {
	if (!filePaths.length) {
		return Promise.resolve({});
	}
	var batches = [];
	for (var b = 0; b < filePaths.length; b += METADATA_BATCH_SIZE) {
		batches.push(filePaths.slice(b, b + METADATA_BATCH_SIZE));
	}
	return batches.reduce(function (chain, batch) {
		return chain.then(function (map) {
			return fetchMetadataBatchChunk(batch).then(function (chunkMap) {
				for (var key in chunkMap) {
					if (Object.prototype.hasOwnProperty.call(chunkMap, key)) {
						map[key] = chunkMap[key];
					}
				}
				return map;
			});
		});
	}, Promise.resolve({}));
}

function scanImageFiles(dir, options) {
	options = options || {};
	return scanImageFilesFromPaths(listImageFiles(dir), options.metadataMap || {});
}

function scanImageFilesFromPaths(filePaths, metaMap) {
	var records = [];
	for (var i = 0; i < filePaths.length; i++) {
		var abs = filePaths[i];
		var st = fs.statSync(abs);
		var meta = metaMap[abs] || {};
		records.push({
			basename: path.basename(abs),
			absPath: abs,
			size: st.size,
			mtime: st.mtime.toISOString(),
			metadata: meta,
			orientation: orientationFromMeta(meta),
		});
	}
	return records;
}

function resolveIndexLeafDir(bundleRoot, roles, role, activeRuns) {
	var rel = roles[role];
	if (!rel) {
		return "";
	}
	var base = path.isAbsolute(rel) ? rel : path.join(bundleRoot, rel);
	if (FLAT_INDEX_ROLES.indexOf(role) >= 0) {
		return base;
	}
	var activeRel = (activeRuns && activeRuns[role]) || "";
	if (activeRel) {
		return path.join(base, activeRel.split("/").join(path.sep));
	}
	var stepId = null;
	var cfgKeys = Object.keys(pipelineRuns.RUN_STEP_CONFIG);
	for (var i = 0; i < cfgKeys.length; i++) {
		if (pipelineRuns.RUN_STEP_CONFIG[cfgKeys[i]].outputRole === role) {
			stepId = cfgKeys[i];
			break;
		}
	}
	if (stepId && pipelineRuns.hasRunMarkers(base, stepId)) {
		return base;
	}
	return base;
}

function resolveOutputLeafDir(bundleRoot, stepId, roles, activeRuns) {
	var cfg = STEP_OUTPUT[stepId];
	if (!cfg) {
		return "";
	}
	return resolveIndexLeafDir(bundleRoot, roles, cfg.role, activeRuns);
}

function sliceImageExistsInDir(dir, sliceId) {
	if (!dir || !fs.existsSync(dir)) {
		return false;
	}
	var imgs = listImageFiles(dir);
	for (var im = 0; im < imgs.length; im++) {
		if (sliceIdFromFilename(path.basename(imgs[im])) === sliceId) {
			return true;
		}
	}
	return false;
}

function scanPreprocessStepLeaves(maxBase, stepId, sliceId) {
	if (!maxBase || !fs.existsSync(maxBase)) {
		return false;
	}
	var flatStep = path.join(maxBase, stepId);
	if (fs.existsSync(flatStep)) {
		var flatRuns;
		try {
			flatRuns = fs.readdirSync(flatStep, { withFileTypes: true });
		} catch (_err) {
			flatRuns = [];
		}
		for (var fr = 0; fr < flatRuns.length; fr++) {
			if (!flatRuns[fr].isDirectory()) {
				continue;
			}
			if (sliceImageExistsInDir(path.join(flatStep, flatRuns[fr].name), sliceId)) {
				return true;
			}
		}
	}
	var branches;
	try {
		branches = fs.readdirSync(maxBase, { withFileTypes: true });
	} catch (_err2) {
		return false;
	}
	for (var b = 0; b < branches.length; b++) {
		if (!branches[b].isDirectory()) {
			continue;
		}
		if (branches[b].name === stepId || branches[b].name === "max" || branches[b].name === "sharpen" || branches[b].name === "tophat") {
			continue;
		}
		var stepDir = path.join(maxBase, branches[b].name, stepId);
		if (!fs.existsSync(stepDir)) {
			continue;
		}
		var runs;
		try {
			runs = fs.readdirSync(stepDir, { withFileTypes: true });
		} catch (_err3) {
			continue;
		}
		for (var r = 0; r < runs.length; r++) {
			if (!runs[r].isDirectory()) {
				continue;
			}
			if (sliceImageExistsInDir(path.join(stepDir, runs[r].name), sliceId)) {
				return true;
			}
		}
	}
	return false;
}

function preprocessOutputExistsForSlice(bundleRoot, stepId, sliceId, roles, activeRuns) {
	var maxRel = roles.max;
	if (!maxRel) {
		return false;
	}
	var maxBase = path.isAbsolute(maxRel) ? maxRel : path.join(bundleRoot, maxRel);
	var activeRel = (activeRuns && activeRuns.max) || "";
	if (activeRel && activeRel.indexOf("/" + stepId + "/") >= 0) {
		var activeLeaf = path.join(maxBase, activeRel.split("/").join(path.sep));
		if (sliceImageExistsInDir(activeLeaf, sliceId)) {
			return true;
		}
	}
	return scanPreprocessStepLeaves(maxBase, stepId, sliceId);
}

function outputExistsForSlice(bundleRoot, stepId, sliceId, roles, activeRuns) {
	var cfg = STEP_OUTPUT[stepId];
	if (!cfg) {
		return false;
	}
	activeRuns = activeRuns || null;
	var activeRel = activeRuns && activeRuns[cfg.role] ? String(activeRuns[cfg.role]) : "";
	var indexed = indexedSliceOnLeaf(bundleRoot, cfg.role, activeRel, sliceId);
	if (indexed != null) {
		return indexed;
	}
	var dir = resolveOutputLeafDir(bundleRoot, stepId, roles, activeRuns);
	if (!dir || !fs.existsSync(dir)) {
		return false;
	}
	if (stepId === "align") {
		var candidates = [
			"Annotation_" + sliceId + ".pkl",
			"annotations_" + sliceId + ".pkl",
			sliceId + ".pkl",
		];
		for (var c = 0; c < candidates.length; c++) {
			if (fs.existsSync(path.join(dir, candidates[c]))) {
				return true;
			}
		}
		var entries = fs.readdirSync(dir);
		for (var e = 0; e < entries.length; e++) {
			if (!/\.pkl$/i.test(entries[e])) {
				continue;
			}
			var stem = entries[e].replace(/\.pkl$/i, "");
			if (/^annotation_/i.test(stem)) {
				stem = stem.replace(/^annotation_/i, "");
			} else if (/^annotations_/i.test(stem)) {
				stem = stem.replace(/^annotations_/i, "");
			}
			if (sliceIdFromFilename(stem) === sliceId) {
				return true;
			}
		}
		return false;
	}
	if (stepId === "intensity") {
		var prefix = sliceId + "_";
		var pkls = fs.readdirSync(dir);
		for (var p = 0; p < pkls.length; p++) {
			if (pkls[p].indexOf(prefix) === 0 && /\.pkl$/i.test(pkls[p])) {
				return true;
			}
		}
		return false;
	}
	if (stepId === "detect") {
		return predictionPklExistsForSlice(dir, sliceId);
	}
	if (stepId === "max") {
		var imgs = listImageFiles(dir);
		for (var im = 0; im < imgs.length; im++) {
			if (sliceIdFromFilename(path.basename(imgs[im])) === sliceId) {
				return true;
			}
		}
		return false;
	}
	if (stepId === "sharpen" || stepId === "tophat") {
		return preprocessOutputExistsForSlice(
			bundleRoot,
			stepId,
			sliceId,
			roles,
			activeRuns,
		);
	}
	if (stepId === "count" || stepId === "collate") {
		return fs.existsSync(path.join(dir, "count_results.csv"));
	}
	if (stepId === "dual") {
		var duals = fs.readdirSync(dir);
		for (var d = 0; d < duals.length; d++) {
			if (duals[d].indexOf(sliceId + "_") === 0 && /_dual\.tif$/i.test(duals[d])) {
				return true;
			}
		}
		return false;
	}
	return false;
}

function predictionPklExistsForSlice(predLeafDir, sliceId) {
	if (!predLeafDir || !sliceId || !fs.existsSync(predLeafDir)) {
		return false;
	}
	var direct = path.join(predLeafDir, "Predictions_" + sliceId + ".pkl");
	if (fs.existsSync(direct)) {
		return true;
	}
	try {
		var entries = fs.readdirSync(predLeafDir);
		for (var i = 0; i < entries.length; i++) {
			if (!/^predictions_.*\.pkl$/i.test(entries[i])) {
				continue;
			}
			if (sliceStemFromPredictionPklBasename(entries[i]) === sliceId) {
				return true;
			}
		}
	} catch (err) {
		return false;
	}
	return false;
}

function resolvePredictionsScan(predBaseDir, maxDepth) {
	maxDepth = maxDepth == null ? 2 : maxDepth;
	var result = {
		resolvedPath: predBaseDir || "",
		warning: "",
		candidates: [],
	};
	if (!predBaseDir || !fs.existsSync(predBaseDir)) {
		return result;
	}
	function hasTopLevelPredictions(dir) {
		try {
			var e = fs.readdirSync(dir);
			for (var i = 0; i < e.length; i++) {
				if (/^predictions_.*\.pkl$/i.test(e[i])) {
					return true;
				}
			}
		} catch (err) {}
		return false;
	}
	if (hasTopLevelPredictions(predBaseDir)) {
		result.resolvedPath = predBaseDir;
		return result;
	}
	function walk(dir, depth) {
		if (!dir || depth > maxDepth) {
			return;
		}
		var entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			return;
		}
		for (var j = 0; j < entries.length; j++) {
			if (!entries[j].isDirectory()) {
				continue;
			}
			var sub = path.join(dir, entries[j].name);
			if (hasTopLevelPredictions(sub)) {
				var mt = 0;
				try {
					var files = fs.readdirSync(sub);
					for (var k = 0; k < files.length; k++) {
						if (/^predictions_.*\.pkl$/i.test(files[k])) {
							var st = fs.statSync(path.join(sub, files[k]));
							if (st.mtimeMs > mt) {
								mt = st.mtimeMs;
							}
						}
					}
				} catch (err2) {}
				result.candidates.push({ path: sub, mtime: mt });
			}
			walk(sub, depth + 1);
		}
	}
	walk(predBaseDir, 0);
	if (!result.candidates.length) {
		result.resolvedPath = predBaseDir;
		return result;
	}
	result.candidates.sort(function (a, b) {
		return b.mtime - a.mtime;
	});
	result.resolvedPath = result.candidates[0].path;
	if (result.candidates.length > 1) {
		result.warning =
			"Multiple nested prediction outputs found under predictions; using the most recently modified folder. Choose predictions and slices on the Count page if needed.";
	}
	return result;
}

function compareDimensions(recordsByRole, sliceId) {
	var issues = [];
	var dims = {};
	var roleKeys = Object.keys(recordsByRole);
	for (var r = 0; r < roleKeys.length; r++) {
		var role = roleKeys[r];
		var rec = recordsByRole[role];
		if (!rec || !rec.metadata || !rec.metadata.width || !rec.metadata.height) {
			continue;
		}
		dims[role] = rec.metadata;
	}
	var rolesWithDims = Object.keys(dims);
	if (rolesWithDims.length < 2) {
		return issues;
	}
	var base = dims[rolesWithDims[0]];
	for (var i = 1; i < rolesWithDims.length; i++) {
		var otherRole = rolesWithDims[i];
		var other = dims[otherRole];
		var bw = base.width;
		var bh = base.height;
		var ow = other.width;
		var oh = other.height;
		var baseAr = bw / bh;
		var otherAr = ow / oh;
		if (Math.abs(baseAr - otherAr) < 0.02 && (bw !== ow || bh !== oh)) {
			issues.push({
				sliceId: sliceId,
				severity: "warning",
				code: "resolution_mismatch",
				message:
					rolesWithDims[0] +
					" and " +
					otherRole +
					" for " +
					sliceId +
					" differ in resolution (" +
					bw +
					"×" +
					bh +
					" vs " +
					ow +
					"×" +
					oh +
					")—processing will resize; verify this is intended.",
			});
		}
		if (
			Math.abs(baseAr - 1 / otherAr) < 0.05 &&
			Math.abs(baseAr - otherAr) > 0.15
		) {
			issues.push({
				sliceId: sliceId,
				severity: "warning",
				code: "orientation_swap",
				message:
					"Possible orientation mismatch: " +
					rolesWithDims[0] +
					" is " +
					bw +
					"×" +
					bh +
					" but " +
					otherRole +
					" is " +
					ow +
					"×" +
					oh +
					".",
			});
		}
		if (baseAr > 4 || baseAr < 0.25) {
			issues.push({
				sliceId: sliceId,
				severity: "info",
				code: "extreme_aspect",
				message: "Unusual aspect ratio for " + sliceId + "; confirm section orientation.",
			});
		}
	}
	return issues;
}

function computeMatchReport(index, activeRoles, options) {
	activeRoles = activeRoles || INPUT_MATCH_ROLES;
	options = options || {};
	var bySlice = {};
	var orphansByRole = {};
	for (var r = 0; r < activeRoles.length; r++) {
		orphansByRole[activeRoles[r]] = [];
	}
	for (var i = 0; i < (index.files || []).length; i++) {
		var rec = index.files[i];
		if (activeRoles.indexOf(rec.role) < 0) {
			continue;
		}
		if (!fileOnActiveLeaf(rec, options.activeRuns)) {
			continue;
		}
		if (!bySlice[rec.sliceId]) {
			bySlice[rec.sliceId] = { sliceId: rec.sliceId, roles: {} };
		}
		bySlice[rec.sliceId].roles[rec.role] = rec;
	}
	var matchedSliceIds = [];
	var qualityIssues = [];
	var sliceKeys = Object.keys(bySlice).sort();
	for (var s = 0; s < sliceKeys.length; s++) {
		var sid = sliceKeys[s];
		var entry = bySlice[sid];
		var present = activeRoles.filter(function (role) {
			return !!entry.roles[role];
		});
		if (present.length >= 2) {
			matchedSliceIds.push(sid);
			var dimIssues = compareDimensions(entry.roles, sid);
			qualityIssues = qualityIssues.concat(dimIssues);
		} else if (present.length === 1) {
			orphansByRole[present[0]].push(sid);
		} else {
			for (var o = 0; o < present.length; o++) {
				orphansByRole[present[o]].push(sid);
			}
		}
	}
	for (var or = 0; or < activeRoles.length; or++) {
		var role = activeRoles[or];
		var roleSlices = Object.keys(bySlice).filter(function (k) {
			return bySlice[k].roles[role] && activeRoles.filter(function (ar) {
				return bySlice[k].roles[ar];
			}).length < 2;
		});
		for (var rs = 0; rs < roleSlices.length; rs++) {
			var onlyRole = bySlice[roleSlices[rs]].roles[role];
			if (onlyRole && orphansByRole[role].indexOf(roleSlices[rs]) < 0) {
				var hasOther = false;
				for (var ar2 = 0; ar2 < activeRoles.length; ar2++) {
					if (
						activeRoles[ar2] !== role &&
						bySlice[roleSlices[rs]].roles[activeRoles[ar2]]
					) {
						hasOther = true;
					}
				}
				if (!hasOther) {
					orphansByRole[role].push(roleSlices[rs]);
				}
			}
		}
	}
	var pairwiseCounts = {};
	for (var pi = 0; pi < activeRoles.length; pi++) {
		for (var pj = pi + 1; pj < activeRoles.length; pj++) {
			var a = activeRoles[pi];
			var b = activeRoles[pj];
			var key = a + "+" + b;
			pairwiseCounts[key] = 0;
			for (var m = 0; m < matchedSliceIds.length; m++) {
				var mid = matchedSliceIds[m];
				if (bySlice[mid].roles[a] && bySlice[mid].roles[b]) {
					pairwiseCounts[key]++;
				}
			}
		}
	}
	return {
		matchedSliceIds: matchedSliceIds,
		orphansByRole: orphansByRole,
		pairwiseCounts: pairwiseCounts,
		qualityIssues: qualityIssues,
		bySlice: bySlice,
	};
}

function buildManifestV2(bundleRoot, index, report) {
	return {
		version: MANIFEST_V2,
		generated_at: new Date().toISOString(),
		matched_count: report.matchedSliceIds.length,
		orphans_by_role: report.orphansByRole,
		quality_summary: {
			issue_count: report.qualityIssues.length,
			codes: report.qualityIssues.map(function (q) {
				return q.code;
			}),
		},
		slices: report.matchedSliceIds.map(function (sid) {
			var files = {};
			var sliceEntry = report.bySlice[sid];
			if (sliceEntry) {
				var roles = Object.keys(sliceEntry.roles);
				for (var i = 0; i < roles.length; i++) {
					files[roles[i]] = sliceEntry.roles[roles[i]].relPath;
				}
			}
			return { sliceId: sid, files: files };
		}),
	};
}

function buildPreviewIndexFromSources(sources, options) {
	options = options || {};
	var files = [];
	var pathsForMeta = [];
	var roleKeys = Object.keys(sources || {});
	for (var r = 0; r < roleKeys.length; r++) {
		var role = roleKeys[r];
		var src = sources[role];
		if (!src || !fs.existsSync(src)) {
			continue;
		}
		var st = fs.statSync(src);
		var dir = st.isDirectory() ? src : path.dirname(src);
		var imgs = listImageFiles(dir);
		for (var f = 0; f < imgs.length; f++) {
			pathsForMeta.push(imgs[f]);
		}
	}
	return fetchMetadataBatch(pathsForMeta, options.appRoot).then(function (metaMap) {
		for (var ri = 0; ri < roleKeys.length; ri++) {
			var scanRole = roleKeys[ri];
			var scanSrc = sources[scanRole];
			if (!scanSrc || !fs.existsSync(scanSrc)) {
				continue;
			}
			var st2 = fs.statSync(scanSrc);
			var scanDir = st2.isDirectory() ? scanSrc : path.dirname(scanSrc);
			var scanned = scanImageFiles(scanDir, { metadataMap: metaMap });
			for (var si = 0; si < scanned.length; si++) {
				var row = scanned[si];
				files.push({
					sliceId: sliceIdFromFilename(row.basename),
					role: scanRole,
					relPath: row.absPath,
					basename: row.basename,
					size: row.size,
					mtime: row.mtime,
					metadata: row.metadata,
					orientation: row.orientation,
					outputs: {},
				});
			}
		}
		return {
			version: FILE_INDEX_VERSION,
			generated_at: new Date().toISOString(),
			files: files,
			preview: true,
		};
	});
}

function fileOnActiveLeaf(rec, activeRuns) {
	if (!activeRuns || !rec || !rec.leafRel) {
		return true;
	}
	var active = String(activeRuns[rec.role] || "").replace(/\\/g, "/");
	if (!active) {
		return true;
	}
	return String(rec.leafRel).replace(/\\/g, "/") === active;
}

function listImageFilesRecursive(dir, maxDepth) {
	var out = [];
	function walk(current, depth) {
		if (!current || depth > maxDepth) {
			return;
		}
		var entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch (_err) {
			return;
		}
		for (var i = 0; i < entries.length; i++) {
			var full = path.join(current, entries[i].name);
			if (entries[i].isDirectory()) {
				if (entries[i].name === ".masonjar" || entries[i].name === ".belljar") {
					continue;
				}
				walk(full, depth + 1);
				continue;
			}
			if (!entries[i].isFile()) {
				continue;
			}
			var name = entries[i].name;
			if (IMAGE_EXT_RE.test(name) || name.toLowerCase().indexOf(".ome.") !== -1) {
				out.push(full);
			}
		}
	}
	walk(dir, 0);
	return out;
}

function leafIdentity(role, leafRel) {
	var rel = String(leafRel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	var parts = rel ? rel.split("/") : [];
	var kind = "";
	var signalBranch = "";
	var slug = parts.length ? parts[parts.length - 1] : "";
	if (role === "max") {
		var maxKinds = ["max", "sharpen", "tophat", "basic"];
		for (var i = 0; i < parts.length; i++) {
			if (maxKinds.indexOf(parts[i]) >= 0) {
				kind = parts[i];
				signalBranch = i > 0 ? parts[0] : "";
				break;
			}
		}
		if (!kind && parts.length) {
			kind = parts[0];
		}
	} else if (parts.length >= 2) {
		kind = parts[0];
		signalBranch = parts[0];
	} else {
		kind = parts[0] || role;
	}
	return { kind: kind, signalBranch: signalBranch, slug: slug };
}

var LEAF_PARAM_KEYS = [
	"radius",
	"amount",
	"equalize",
	"confidence",
	"tile",
	"area",
	"eccentricity",
	"intensity_min",
	"source_kind",
	"source_run_rel",
	"input_dataset_rel",
	"signal_branch",
];

function readLeafManifest(absDir) {
	var mf = path.join(absDir, "run_manifest.json");
	if (!fs.existsSync(mf)) {
		mf = path.join(absDir, "qc_scout_manifest.json");
	}
	if (!fs.existsSync(mf)) {
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(mf, "utf8"));
	} catch (_err) {
		return null;
	}
}

function parametersFromManifest(manifest) {
	var params = {};
	if (!manifest) {
		return params;
	}
	for (var i = 0; i < LEAF_PARAM_KEYS.length; i++) {
		var key = LEAF_PARAM_KEYS[i];
		if (manifest[key] != null && manifest[key] !== "") {
			params[key] = manifest[key];
		}
	}
	return params;
}

function sourceLeafFromManifest(manifest) {
	if (!manifest) {
		return "";
	}
	var stored = String(manifest.input_dataset_rel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (stored && stored.split("/").indexOf("..") < 0) {
		return stored;
	}
	var input = String(manifest.input_dir || "").replace(/\\/g, "/");
	var marker = "03_max/";
	var idx = input.toLowerCase().lastIndexOf(marker);
	if (idx < 0) {
		return "";
	}
	var suffix = input.slice(idx + marker.length).replace(/^\/+|\/+$/g, "");
	if (!suffix || suffix.split("/").indexOf("..") >= 0) {
		return "";
	}
	return suffix;
}

function discoverQcScoutLeaves(predBase) {
	var found = [];
	function walk(dir, relParts, depth) {
		if (!dir || depth > 4 || !fs.existsSync(dir)) {
			return;
		}
		var entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (_err) {
			return;
		}
		for (var i = 0; i < entries.length; i++) {
			if (!entries[i].isDirectory()) {
				continue;
			}
			var name = entries[i].name;
			var nextRel = relParts.concat(name);
			var full = path.join(dir, name);
			if (name === "qc_scout") {
				var kids;
				try {
					kids = fs.readdirSync(full, { withFileTypes: true });
				} catch (_e2) {
					kids = [];
				}
				var direct = false;
				for (var k = 0; k < kids.length; k++) {
					if (kids[k].isDirectory()) {
						var child = path.join(full, kids[k].name);
						if (pipelineRuns.hasRunMarkers(child, "detect")) {
							found.push({
								rel: nextRel.concat(kids[k].name).join("/"),
								abs: child,
							});
						}
					} else if (/^predictions_.*\.pkl$/i.test(kids[k].name)) {
						direct = true;
					}
				}
				if (direct) {
					found.push({ rel: nextRel.join("/"), abs: full });
				}
				continue;
			}
			walk(full, nextRel, depth + 1);
		}
	}
	walk(predBase, [], 0);
	return found;
}

function collectIndexLeaves(bundleRoot, roles) {
	var leaves = [];
	for (var i = 0; i < OUTPUT_ROLES_FOR_INDEX.length; i++) {
		var role = OUTPUT_ROLES_FOR_INDEX[i];
		var rel = roles[role];
		if (!rel) {
			continue;
		}
		var base = path.isAbsolute(rel) ? rel : path.join(bundleRoot, rel);
		var stepId = null;
		var cfgKeys = Object.keys(pipelineRuns.RUN_STEP_CONFIG);
		for (var c = 0; c < cfgKeys.length; c++) {
			if (pipelineRuns.RUN_STEP_CONFIG[cfgKeys[c]].outputRole === role) {
				stepId = cfgKeys[c];
				break;
			}
		}
		if (!stepId || !fs.existsSync(base)) {
			continue;
		}
		var discovered = pipelineRuns.discoverOutputRuns(
			base,
			stepId,
			pipelineRuns.discoveryMaxDepth(stepId),
		);
		for (var d = 0; d < discovered.length; d++) {
			var item = discovered[d];
			if (!item.rel) {
				continue;
			}
			var ident = leafIdentity(role, item.rel);
			leaves.push({
				role: role,
				leafRel: item.rel,
				abs: path.join(base, item.rel.split("/").join(path.sep)),
				qcScout: false,
				kind: ident.kind,
				signalBranch: ident.signalBranch,
				slug: ident.slug,
				mtime: item.mtime || 0,
			});
		}
		if (role === "predictions") {
			var scouts = discoverQcScoutLeaves(base);
			for (var s = 0; s < scouts.length; s++) {
				var scoutIdent = leafIdentity(role, scouts[s].rel);
				leaves.push({
					role: role,
					leafRel: scouts[s].rel,
					abs: scouts[s].abs,
					qcScout: true,
					kind: "detect",
					signalBranch: scoutIdent.signalBranch,
					slug: scoutIdent.slug,
					mtime: 0,
				});
			}
		}
	}
	return leaves;
}

var OUTPUT_ROLES_FOR_INDEX = [
	"max",
	"slices",
	"predictions",
	"quantification",
	"pkls",
	"dual",
];

function filesInLeafDir(absDir, role) {
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
		if (!entries[i].isFile()) {
			continue;
		}
		var name = entries[i].name;
		var image =
			role !== "slices" &&
			(IMAGE_EXT_RE.test(name) || name.toLowerCase().indexOf(".ome.") !== -1);
		var prediction = role === "predictions" && /^predictions_.*\.pkl$/i.test(name);
		var annotation = role === "slices" && /\.pkl$/i.test(name) && !/^predictions_/i.test(name);
		var intensity = role === "pkls" && /\.pkl$/i.test(name);
		var countCsv = role === "quantification" && name === "count_results.csv";
		var dual = role === "dual" && /_dual\.tif$/i.test(name);
		if (image || prediction || annotation || intensity || countCsv || dual) {
			out.push(path.join(absDir, name));
		}
	}
	return out;
}

function sliceIdForIndexedFile(role, basename) {
	if (role === "predictions") {
		return sliceStemFromPredictionPklBasename(basename);
	}
	if (role === "slices" && /\.pkl$/i.test(basename)) {
		return sliceStemFromAnnotationPklBasename(basename);
	}
	if (role === "quantification") {
		return "";
	}
	return sliceIdFromFilename(basename);
}

function buildFileIndex(bundleRoot, roles, options) {
	options = options || {};
	roles = roles || {};
	var leaves = collectIndexLeaves(bundleRoot, roles);
	var flatRoles = ["dapi", "original_scans"];
	var pathsForMeta = [];
	var flatFiles = [];
	for (var fr = 0; fr < flatRoles.length; fr++) {
		var flatRole = flatRoles[fr];
		var flatRel = roles[flatRole];
		if (!flatRel) {
			continue;
		}
		var flatBase = path.isAbsolute(flatRel) ? flatRel : path.join(bundleRoot, flatRel);
		var flatImgs =
			flatRole === "original_scans"
				? listImageFilesRecursive(flatBase, 4)
				: listImageFiles(flatBase);
		for (var fi = 0; fi < flatImgs.length; fi++) {
			pathsForMeta.push(flatImgs[fi]);
			var parentRel = path
				.relative(flatBase, path.dirname(flatImgs[fi]))
				.split(path.sep)
				.join("/");
			if (parentRel === ".") {
				parentRel = "";
			}
			flatFiles.push({
				role: flatRole,
				abs: flatImgs[fi],
				leafRel: parentRel,
			});
		}
	}
	var previewDir = path.join(bundleRoot, "data", "counting", "_previews");
	if (fs.existsSync(previewDir)) {
		var previews = listImageFiles(previewDir);
		for (var pv = 0; pv < previews.length; pv++) {
			pathsForMeta.push(previews[pv]);
			flatFiles.push({ role: "previews", abs: previews[pv], leafRel: "" });
		}
	}
	for (var li = 0; li < leaves.length; li++) {
		var leafFiles = filesInLeafDir(leaves[li].abs, leaves[li].role);
		for (var lf = 0; lf < leafFiles.length; lf++) {
			if (IMAGE_EXT_RE.test(leafFiles[lf]) || leafFiles[lf].toLowerCase().indexOf(".ome.") !== -1) {
				pathsForMeta.push(leafFiles[lf]);
			}
		}
	}
	return fetchMetadataBatch(pathsForMeta, options.appRoot).then(function (metaMap) {
		var files = [];
		var leafRecords = [];
		for (var n = 0; n < leaves.length; n++) {
			var leaf = leaves[n];
			var manifest = readLeafManifest(leaf.abs);
			var params = parametersFromManifest(manifest);
			var sourceLeafRel = sourceLeafFromManifest(manifest);
			var sectionFiles = {};
			var absFiles = filesInLeafDir(leaf.abs, leaf.role);
			for (var a = 0; a < absFiles.length; a++) {
				var abs = absFiles[a];
				var baseName = path.basename(abs);
				var sliceId = sliceIdForIndexedFile(leaf.role, baseName);
				var st;
				try {
					st = fs.statSync(abs);
				} catch (_st) {
					continue;
				}
				var relPath = path.relative(bundleRoot, abs).split(path.sep).join("/");
				var meta = metaMap[abs] || {};
				files.push({
					sliceId: sliceId,
					role: leaf.role,
					leafRel: leaf.leafRel,
					relPath: relPath,
					basename: baseName,
					size: st.size,
					mtime: st.mtime.toISOString(),
					metadata: meta,
					orientation: orientationFromMeta(meta),
					outputs: {},
					qcScout: !!leaf.qcScout,
				});
				if (sliceId && !sectionFiles[sliceId]) {
					sectionFiles[sliceId] = relPath;
				}
			}
			leafRecords.push({
				role: leaf.role,
				leafRel: leaf.leafRel,
				kind: leaf.kind,
				signalBranch: params.signal_branch || leaf.signalBranch,
				slug: leaf.slug,
				qcScout: !!leaf.qcScout,
				parameters: params,
				sourceLeafRel: sourceLeafRel,
				files: sectionFiles,
				mtime: leaf.mtime || 0,
			});
		}
		for (var ff = 0; ff < flatFiles.length; ff++) {
			var flat = flatFiles[ff];
			var flatSt;
			try {
				flatSt = fs.statSync(flat.abs);
			} catch (_fst) {
				continue;
			}
			var flatBaseName = path.basename(flat.abs);
			var flatRelPath = path.relative(bundleRoot, flat.abs).split(path.sep).join("/");
			var flatMeta = metaMap[flat.abs] || {};
			files.push({
				sliceId: sliceIdFromFilename(flatBaseName),
				role: flat.role,
				leafRel: flat.leafRel,
				relPath: flatRelPath,
				basename: flatBaseName,
				size: flatSt.size,
				mtime: flatSt.mtime.toISOString(),
				metadata: flatMeta,
				orientation: orientationFromMeta(flatMeta),
				outputs: {},
			});
		}
		return {
			version: FILE_INDEX_VERSION,
			generated_at: new Date().toISOString(),
			bundle_root: bundleRoot,
			files: files,
			leaves: leafRecords,
		};
	});
}

function writeFileIndex(bundleRoot, metaDirPath, index) {
	var indexPath = path.join(metaDirPath, "file_index.json");
	fs.mkdirSync(path.dirname(indexPath), { recursive: true });
	fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
	return indexPath;
}

function readFileIndex(bundleRoot, metaDirPath) {
	var indexPath = path.join(metaDirPath, "file_index.json");
	if (!fs.existsSync(indexPath)) {
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(indexPath, "utf8"));
	} catch (err) {
		return null;
	}
}

function getProcessingSliceIds(bundleRoot, projectData, index, report, options) {
	report =
		report ||
		(index ? computeMatchReport(index, INPUT_MATCH_ROLES) : { matchedSliceIds: [] });
	var ids = report.matchedSliceIds.slice();
	var proc = (projectData && projectData.processing) || {};
	if (proc.subset_enabled && proc.slice_ids && proc.slice_ids.length) {
		var subset = {};
		for (var i = 0; i < proc.slice_ids.length; i++) {
			subset[proc.slice_ids[i]] = true;
		}
		ids = ids.filter(function (sid) {
			return subset[sid];
		});
	}
	options = options || {};
	var stepId = options.stepId || "";
	var filterAlignFailures =
		options.filterAlignFailures != null
			? options.filterAlignFailures
			: !stepId || !!STEPS_BLOCKED_BY_ALIGN_FAILURE[stepId];
	if (filterAlignFailures) {
		var alignFailures =
			proc.step_failures && proc.step_failures.align ? proc.step_failures.align : {};
		var failedAlignIds = Object.keys(alignFailures);
		if (failedAlignIds.length) {
			var failedSet = {};
			for (var f = 0; f < failedAlignIds.length; f++) {
				failedSet[failedAlignIds[f]] = true;
			}
			ids = ids.filter(function (sid) {
				return !failedSet[sid];
			});
		}
	}
	return ids;
}

function scanOutputsForStep(bundleRoot, stepId, sliceIds, roles, activeRuns) {
	var out = {};
	for (var i = 0; i < sliceIds.length; i++) {
		var sid = sliceIds[i];
		out[sid] = outputExistsForSlice(bundleRoot, stepId, sid, roles, activeRuns);
	}
	return out;
}

function planRun(bundleRoot, stepId, options) {
	options = options || {};
	var mode = options.mode || "merge";
	var sliceIds = options.sliceIds || [];
	var roles = options.roles || {};
	var activeRuns = options.activeRuns || null;
	var toProcess = [];
	var skipped = [];
	for (var i = 0; i < sliceIds.length; i++) {
		var sid = sliceIds[i];
		var exists = outputExistsForSlice(bundleRoot, stepId, sid, roles, activeRuns);
		if (mode === "overwrite" || !exists) {
			toProcess.push(sid);
		} else {
			skipped.push({ sliceId: sid, reason: "output_exists" });
		}
	}
	return { toProcess: toProcess, skipped: skipped, mode: mode };
}

function writeRunSliceList(metaDirPath, sliceIds) {
	var runPath = path.join(metaDirPath, "run_slice_list.json");
	fs.writeFileSync(
		runPath,
		JSON.stringify({ slice_ids: sliceIds, generated_at: new Date().toISOString() }, null, 2),
		"utf8",
	);
	return runPath;
}

function emptyIndex(bundleRoot) {
	return {
		version: FILE_INDEX_VERSION,
		generated_at: new Date().toISOString(),
		bundle_root: bundleRoot,
		files: [],
		leaves: [],
	};
}

function loadOrEmptyIndex(bundleRoot, metaDirPath) {
	var index = readFileIndex(bundleRoot, metaDirPath);
	if (!index || !Array.isArray(index.files)) {
		index = emptyIndex(bundleRoot);
	}
	if (!Array.isArray(index.leaves)) {
		index.leaves = [];
	}
	index.version = FILE_INDEX_VERSION;
	return index;
}

function indexedSliceOnLeaf(bundleRoot, role, leafRel, sliceId) {
	if (!bundleRoot || !leafRel) {
		return null;
	}
	var index = readFileIndex(bundleRoot, path.join(bundleRoot, ".masonjar"));
	if (!index || index.version < 2 || !Array.isArray(index.files)) {
		return null;
	}
	var wantLeaf = String(leafRel).replace(/\\/g, "/");
	var wantId = String(sliceId || "");
	for (var i = 0; i < index.files.length; i++) {
		var row = index.files[i];
		if (row.role !== role) {
			continue;
		}
		if (String(row.leafRel || "").replace(/\\/g, "/") !== wantLeaf) {
			continue;
		}
		if (row.sliceId === wantId) {
			return true;
		}
	}
	return false;
}

function fileForSlice(index, leafRel, sliceId) {
	if (!index || !leafRel || !sliceId) {
		return null;
	}
	var wantLeaf = String(leafRel).replace(/\\/g, "/");
	var wantId = String(sliceId);
	var fallback = null;
	for (var i = 0; i < (index.files || []).length; i++) {
		var row = index.files[i];
		if (String(row.leafRel || "").replace(/\\/g, "/") !== wantLeaf) {
			continue;
		}
		if (String(row.sliceId || "") !== wantId) {
			continue;
		}
		if (IMAGE_EXT_RE.test(row.basename || "") || String(row.basename || "").toLowerCase().indexOf(".ome.") !== -1) {
			return row;
		}
		fallback = fallback || row;
	}
	return fallback;
}

function leafRecord(index, role, leafRel) {
	if (!index || !leafRel) {
		return null;
	}
	var want = String(leafRel).replace(/\\/g, "/");
	var leaves = index.leaves || [];
	for (var i = 0; i < leaves.length; i++) {
		if (leaves[i].role === role && String(leaves[i].leafRel || "").replace(/\\/g, "/") === want) {
			return leaves[i];
		}
	}
	return null;
}

function saveIndex(bundleRoot, metaDirPath, index) {
	index.version = FILE_INDEX_VERSION;
	index.generated_at = new Date().toISOString();
	index.bundle_root = bundleRoot;
	writeFileIndex(bundleRoot, metaDirPath, index);
	return index;
}

function recordLeaf(bundleRoot, metaDirPath, spec) {
	spec = spec || {};
	var absDir = spec.absDir;
	var role = spec.role;
	var leafRel = String(spec.leafRel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!bundleRoot || !metaDirPath || !absDir || !role || !leafRel) {
		throw new Error("recordLeaf needs a bundle, a leaf directory, a role, and a leaf rel");
	}
	if (!fs.existsSync(absDir)) {
		throw new Error("recordLeaf directory is missing: " + absDir);
	}
	var index = loadOrEmptyIndex(bundleRoot, metaDirPath);
	index.files = (index.files || []).filter(function (row) {
		return !(row.role === role && String(row.leafRel || "").replace(/\\/g, "/") === leafRel);
	});
	index.leaves = (index.leaves || []).filter(function (row) {
		return !(row.role === role && String(row.leafRel || "").replace(/\\/g, "/") === leafRel);
	});
	var manifest = readLeafManifest(absDir);
	var ident = leafIdentity(role, leafRel);
	var params = parametersFromManifest(manifest);
	var sectionFiles = {};
	var absFiles = filesInLeafDir(absDir, role);
	for (var i = 0; i < absFiles.length; i++) {
		var abs = absFiles[i];
		var baseName = path.basename(abs);
		var sliceId = sliceIdForIndexedFile(role, baseName);
		var st = fs.statSync(abs);
		var relPath = path.relative(bundleRoot, abs).split(path.sep).join("/");
		index.files.push({
			sliceId: sliceId,
			role: role,
			leafRel: leafRel,
			relPath: relPath,
			basename: baseName,
			size: st.size,
			mtime: st.mtime.toISOString(),
			metadata: {},
			orientation: { aspectRatio: null, landscape: null, exifOrientation: null },
			outputs: {},
			qcScout: !!spec.qcScout,
		});
		if (sliceId && !sectionFiles[sliceId]) {
			sectionFiles[sliceId] = relPath;
		}
	}
	index.leaves.push({
		role: role,
		leafRel: leafRel,
		kind: ident.kind,
		signalBranch: (params && params.signal_branch) || ident.signalBranch,
		slug: ident.slug,
		qcScout: !!spec.qcScout,
		parameters: params,
		sourceLeafRel: sourceLeafFromManifest(manifest),
		files: sectionFiles,
		mtime: Date.now(),
	});
	return saveIndex(bundleRoot, metaDirPath, index);
}

function updateFiles(bundleRoot, metaDirPath, absPaths) {
	var index = loadOrEmptyIndex(bundleRoot, metaDirPath);
	var byRel = {};
	for (var i = 0; i < index.files.length; i++) {
		byRel[String(index.files[i].relPath || "").replace(/\\/g, "/")] = index.files[i];
	}
	var paths = absPaths || [];
	for (var p = 0; p < paths.length; p++) {
		var abs = paths[p];
		if (!abs || !fs.existsSync(abs)) {
			continue;
		}
		var relPath = path.relative(bundleRoot, abs).split(path.sep).join("/");
		var st = fs.statSync(abs);
		var row = byRel[relPath];
		if (row) {
			row.size = st.size;
			row.mtime = st.mtime.toISOString();
			continue;
		}
		index.files.push({
			sliceId: sliceIdFromFilename(path.basename(abs)),
			role: roleForBundleRel(relPath),
			leafRel: leafRelForBundleRel(relPath),
			relPath: relPath,
			basename: path.basename(abs),
			size: st.size,
			mtime: st.mtime.toISOString(),
			metadata: {},
			orientation: { aspectRatio: null, landscape: null, exifOrientation: null },
			outputs: {},
		});
	}
	return saveIndex(bundleRoot, metaDirPath, index);
}

function roleForBundleRel(relPath) {
	var rel = String(relPath || "").replace(/\\/g, "/");
	if (rel.indexOf("data/counting/03_max/") === 0) {
		return "max";
	}
	if (rel.indexOf("data/counting/05_predictions/") === 0) {
		return "predictions";
	}
	if (rel.indexOf("data/counting/01_slices/") === 0) {
		return "slices";
	}
	if (rel.indexOf("data/counting/00_dapi/") === 0) {
		return "dapi";
	}
	if (rel.indexOf("data/original_scans/") === 0) {
		return "original_scans";
	}
	if (rel.indexOf("data/counting/_previews/") === 0) {
		return "previews";
	}
	if (rel.indexOf("data/counting/06_quantification/") === 0) {
		return "quantification";
	}
	if (rel.indexOf("data/counting/07_pkls/") === 0) {
		return "pkls";
	}
	if (rel.indexOf("data/counting/08_dual/") === 0) {
		return "dual";
	}
	return "";
}

function leafRelForBundleRel(relPath) {
	var rel = String(relPath || "").replace(/\\/g, "/");
	var role = roleForBundleRel(rel);
	var bases = {
		max: "data/counting/03_max/",
		predictions: "data/counting/05_predictions/",
		slices: "data/counting/01_slices/",
		dapi: "data/counting/00_dapi/",
		original_scans: "data/original_scans/",
		previews: "data/counting/_previews/",
		quantification: "data/counting/06_quantification/",
		pkls: "data/counting/07_pkls/",
		dual: "data/counting/08_dual/",
	};
	var base = bases[role];
	if (!base || rel.indexOf(base) !== 0) {
		return "";
	}
	var rest = rel.slice(base.length);
	var slash = rest.lastIndexOf("/");
	return slash >= 0 ? rest.slice(0, slash) : "";
}

function removeLeaf(bundleRoot, metaDirPath, role, leafRel) {
	var want = String(leafRel || "").replace(/\\/g, "/");
	var index = loadOrEmptyIndex(bundleRoot, metaDirPath);
	index.files = (index.files || []).filter(function (row) {
		return !(row.role === role && String(row.leafRel || "").replace(/\\/g, "/") === want);
	});
	index.leaves = (index.leaves || []).filter(function (row) {
		return !(row.role === role && String(row.leafRel || "").replace(/\\/g, "/") === want);
	});
	return saveIndex(bundleRoot, metaDirPath, index);
}

module.exports = {
	FILE_INDEX_VERSION: FILE_INDEX_VERSION,
	MANIFEST_V2: MANIFEST_V2,
	SCAN_ROLES: SCAN_ROLES,
	INPUT_MATCH_ROLES: INPUT_MATCH_ROLES,
	STEPS_BLOCKED_BY_ALIGN_FAILURE: STEPS_BLOCKED_BY_ALIGN_FAILURE,
	STEP_OUTPUT: STEP_OUTPUT,
	sliceIdFromFilename: sliceIdFromFilename,
	sliceStemFromAnnotationPklBasename: sliceStemFromAnnotationPklBasename,
	sliceStemFromPredictionPklBasename: sliceStemFromPredictionPklBasename,
	listSlicesRoleFilePaths: listSlicesRoleFilePaths,
	listImageFiles: listImageFiles,
	scanImageFiles: scanImageFiles,
	buildFileIndex: buildFileIndex,
	computeMatchReport: computeMatchReport,
	buildManifestV2: buildManifestV2,
	writeFileIndex: writeFileIndex,
	readFileIndex: readFileIndex,
	getProcessingSliceIds: getProcessingSliceIds,
	scanOutputsForStep: scanOutputsForStep,
	planRun: planRun,
	outputExistsForSlice: outputExistsForSlice,
	writeRunSliceList: writeRunSliceList,
	buildPreviewIndexFromSources: buildPreviewIndexFromSources,
	predictionPklExistsForSlice: predictionPklExistsForSlice,
	resolvePredictionsScan: resolvePredictionsScan,
	resolveIndexLeafDir: resolveIndexLeafDir,
	resolveOutputLeafDir: resolveOutputLeafDir,
	listPredictionPklRecords: listPredictionPklRecords,
	recordLeaf: recordLeaf,
	updateFiles: updateFiles,
	removeLeaf: removeLeaf,
	fileForSlice: fileForSlice,
	leafRecord: leafRecord,
	sourceLeafFromManifest: sourceLeafFromManifest,
};
