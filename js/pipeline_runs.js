"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

function projectModule() {
	return require("./project");
}

var IMAGE_EXT_RE = /\.(tif|tiff|png|jpe?g)$/i;

var OUTPUT_ROLES = [
	"max",
	"slices",
	"predictions",
	"quantification",
	"pkls",
	"dual",
];

var INPUT_ROLES = ["original_scans", "dapi"];

var RUN_STEP_CONFIG = {
	max: {
		stepId: "max",
		outputRole: "max",
		branch: "max",
		inputRoles: ["original_scans"],
	},
	sharpen: {
		stepId: "sharpen",
		outputRole: "max",
		branch: "sharpen",
		inputRoles: ["max"],
	},
	align: {
		stepId: "align",
		outputRole: "slices",
		branch: "align",
		inputRoles: ["dapi"],
	},
	intensity: {
		stepId: "intensity",
		outputRole: "pkls",
		branch: "intensity",
		inputRoles: ["max", "slices"],
	},
	detect: {
		stepId: "detect",
		outputRole: "predictions",
		branch: null,
		inputRoles: ["max"],
	},
	count: {
		stepId: "count",
		outputRole: "quantification",
		branch: "count",
		inputRoles: ["predictions", "slices"],
	},
	collate: {
		stepId: "collate",
		outputRole: "quantification",
		branch: "collate",
		inputRoles: ["quantification"],
	},
	dual: {
		stepId: "dual",
		outputRole: "dual",
		branch: "dual",
		inputRoles: ["pkls"],
	},
};

var STEP_BY_OUTPUT_ROLE = {};
var roleKeys = Object.keys(RUN_STEP_CONFIG);
for (var i = 0; i < roleKeys.length; i++) {
	var sid = roleKeys[i];
	var cfg = RUN_STEP_CONFIG[sid];
	if (!STEP_BY_OUTPUT_ROLE[cfg.outputRole]) {
		STEP_BY_OUTPUT_ROLE[cfg.outputRole] = sid;
	}
}

function isOutputRole(role) {
	return OUTPUT_ROLES.indexOf(role) >= 0;
}

function decToken(num) {
	return String(num).replace(/\./g, "p");
}

function sanitizeSlugPart(s) {
	return String(s || "")
		.replace(/[/\\:*?"<>|]+/g, "_")
		.replace(/\s+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 80);
}

function sliceSpanToken(sortedStems) {
	var seen = {};
	var uniq = [];
	for (var i = 0; i < sortedStems.length; i++) {
		var s = sortedStems[i];
		if (!seen[s]) {
			seen[s] = true;
			uniq.push(s);
		}
	}
	uniq.sort();
	if (!uniq.length) {
		return "noslices";
	}
	if (uniq.length === 1) {
		return sanitizeSlugPart(uniq[0]);
	}
	var first = uniq[0];
	var last = uniq[uniq.length - 1];
	if (uniq.length === 2) {
		return sanitizeSlugPart(first + "-" + last);
	}
	var h = crypto.createHash("sha1").update(uniq.join("|")).digest("hex").slice(0, 4);
	return sanitizeSlugPart(first + "-" + last) + "_h" + h;
}

function shortRefToken(ref) {
	var s = String(ref || "")
		.split(/[/\\]+/)
		.filter(Boolean)
		.join("_");
	if (!s) {
		return "flat";
	}
	if (s.length <= 32) {
		return sanitizeSlugPart(s);
	}
	return (
		sanitizeSlugPart(s.slice(0, 20)) +
		"_h" +
		crypto.createHash("sha1").update(s).digest("hex").slice(0, 6)
	);
}

function listImageSliceStems(dirPath) {
	if (!dirPath || !fs.existsSync(dirPath)) {
		return [];
	}
	var entries;
	try {
		entries = fs.readdirSync(dirPath, { withFileTypes: true });
	} catch (err) {
		return [];
	}
	var stems = [];
	for (var i = 0; i < entries.length; i++) {
		if (!entries[i].isFile()) {
			continue;
		}
		var n = entries[i].name;
		if (IMAGE_EXT_RE.test(n) || n.toLowerCase().indexOf(".ome.") !== -1) {
			var stem = path.parse(n).name;
			if (/\.ome$/i.test(stem)) {
				stem = path.parse(stem).name;
			}
			var dot = stem.indexOf(".");
			stems.push(dot >= 0 ? stem.slice(0, dot) : stem);
		}
	}
	stems.sort();
	return stems;
}

function buildDetectRunSlug(options) {
	var c = options.confidence;
	var t = options.tile;
	var a = options.area;
	var e = options.eccentricity;
	var params =
		"c" +
		decToken(c) +
		"_t" +
		String(Math.round(t)) +
		"_a" +
		String(Math.round(a)) +
		"_e" +
		decToken(e);
	var span = sliceSpanToken(options.sortedStems || []);
	var subset = "";
	if (options.subsetCount && options.subsetCount > 0) {
		subset = "_subset_" + String(options.subsetCount);
	}
	return sanitizeSlugPart(span + "_" + params + subset);
}

function buildRunSlug(stepId, context) {
	context = context || {};
	var stems = context.sortedStems || listImageSliceStems(context.inputDir || "");
	var span = sliceSpanToken(stems);
	var subset = "";
	if (context.subsetCount && context.subsetCount > 0) {
		subset = "_sub" + String(context.subsetCount);
	}

	if (stepId === "detect") {
		return buildDetectRunSlug({
			confidence: context.confidence,
			tile: context.tile,
			area: context.area,
			eccentricity: context.eccentricity,
			sortedStems: stems,
			subsetCount: context.subsetCount,
		});
	}
	if (stepId === "max") {
		var flags = "";
		if (context.dendrite) {
			flags += "_dend";
		}
		if (context.tophat) {
			flags += "_tophat";
		}
		return sanitizeSlugPart(span + flags + subset);
	}
	if (stepId === "sharpen") {
		return sanitizeSlugPart(
			span +
				"_r" +
				decToken(context.radius) +
				"_a" +
				decToken(context.amount) +
				(context.equalize ? "_eq" : "") +
				subset,
		);
	}
	if (stepId === "align") {
		var spacing = context.spacing != null ? "_sp" + String(context.spacing) : "";
		var hem = context.whole === false || context.whole === "False" ? "_half" : "_whole";
		var leg = context.legacy === true || context.legacy === "True" ? "_leg" : "";
		return sanitizeSlugPart(span + spacing + hem + leg + subset);
	}
	if (stepId === "intensity") {
		var mode = context.whole === false || context.whole === "False" ? "_hemi" : "_whole";
		var dapi = context.useDapi ? "_dapi" : "";
		return sanitizeSlugPart(span + mode + dapi + subset);
	}
	if (stepId === "count") {
		var predRef = shortRefToken(context.predictionRunRel);
		var sliceRef = shortRefToken(context.slicesRunRel);
		var layer = context.layerinfo ? "_layers" : "";
		return sanitizeSlugPart(
			"p_" + predRef + "_s_" + sliceRef + layer + subset,
		);
	}
	if (stepId === "collate") {
		return sanitizeSlugPart("from_" + shortRefToken(context.sourceRunRel) + subset);
	}
	if (stepId === "dual") {
		return sanitizeSlugPart(
			"pkls_" + shortRefToken(context.pklsRunRel) + "_" + span + subset,
		);
	}
	return sanitizeSlugPart(span + subset);
}

function resolveRunLeaf(roleBaseAbs, branch, slug, flat) {
	if (!roleBaseAbs) {
		return "";
	}
	if (flat || !branch || !slug) {
		return roleBaseAbs;
	}
	return path.join(roleBaseAbs, branch, slug);
}

function normalizeRelPath(rel) {
	return String(rel || "")
		.split(/[/\\]+/)
		.filter(Boolean)
		.join("/");
}

function getActiveRunsMap() {
	if (!projectModule().isActive()) {
		return {};
	}
	var proc = projectModule().getProject().processing || projectModule().defaultProcessing();
	if (!proc.active_runs) {
		proc.active_runs = defaultActiveRuns();
	}
	return proc.active_runs;
}

function defaultActiveRuns() {
	var map = {};
	for (var i = 0; i < OUTPUT_ROLES.length; i++) {
		map[OUTPUT_ROLES[i]] = "";
	}
	return map;
}

function migrateActiveRuns(processing) {
	if (!processing) {
		return defaultActiveRuns();
	}
	var runs = Object.assign(defaultActiveRuns(), processing.active_runs || {});
	if (!runs.predictions && processing.active_prediction_run) {
		runs.predictions = normalizeRelPath(processing.active_prediction_run);
	}
	return runs;
}

function getActiveRunRelForRole(role) {
	if (!isOutputRole(role)) {
		return "";
	}
	var runs = getActiveRunsMap();
	return normalizeRelPath(runs[role] || "");
}

function getActiveRunRel(stepId) {
	var cfg = RUN_STEP_CONFIG[stepId];
	if (!cfg) {
		return "";
	}
	return getActiveRunRelForRole(cfg.outputRole);
}

function setActiveRunRel(stepId, rel) {
	if (!projectModule().isActive()) {
		return false;
	}
	var cfg = RUN_STEP_CONFIG[stepId];
	if (!cfg) {
		return false;
	}
	return setActiveRunRelForRole(cfg.outputRole, rel);
}

function setActiveRunRelForRole(role, rel) {
	if (!projectModule().isActive() || !isOutputRole(role)) {
		return false;
	}
	var proj = projectModule().getProject();
	if (!proj.processing) {
		proj.processing = projectModule().defaultProcessing();
	}
	if (!proj.processing.active_runs) {
		proj.processing.active_runs = migrateActiveRuns(proj.processing);
	}
	proj.processing.active_runs[role] = normalizeRelPath(rel);
	if (role === "predictions") {
		proj.processing.active_prediction_run = proj.processing.active_runs[role];
	}
	projectModule().saveProjectJson();
	return true;
}

function resolveRoleBaseAbs(role) {
	return projectModule().resolveRolePath(role) || "";
}

function resolveActiveRunLeafAbs(role) {
	var base = resolveRoleBaseAbs(role);
	if (!base) {
		return "";
	}
	var rel = getActiveRunRelForRole(role);
	if (!rel) {
		return base;
	}
	return path.join(base, rel.split("/").join(path.sep));
}

function resolveRoleLeafAbs(stepId) {
	var cfg = RUN_STEP_CONFIG[stepId];
	if (!cfg) {
		return "";
	}
	return resolveActiveRunLeafAbs(cfg.outputRole);
}

function resolveInputLeafAbs(role) {
	if (INPUT_ROLES.indexOf(role) >= 0) {
		return resolveRoleBaseAbs(role);
	}
	return resolveActiveRunLeafAbs(role);
}

function resolveActiveBranchLeafAbs(role, branch) {
	var base = resolveRoleBaseAbs(role);
	if (!base || !branch) {
		return base;
	}
	var activeRel = getActiveRunRelForRole(role);
	if (activeRel) {
		var parts = activeRel.split("/");
		if (parts[0] === branch) {
			return path.join(base, activeRel.split("/").join(path.sep));
		}
	}
	var stepId = STEP_BY_OUTPUT_ROLE[role];
	var runs = discoverOutputRuns(base, stepId, 2);
	for (var i = 0; i < runs.length; i++) {
		var rel = runs[i].rel;
		if (rel === branch || rel.indexOf(branch + "/") === 0) {
			return path.join(base, rel.split("/").join(path.sep));
		}
	}
	var branchDir = path.join(base, branch);
	if (fs.existsSync(branchDir) && hasRunMarkers(branchDir, stepId)) {
		return branchDir;
	}
	if (hasRunMarkers(base, stepId)) {
		return base;
	}
	return base;
}

function resolveInputLeafAbsForStep(stepId, inputRole) {
	if (INPUT_ROLES.indexOf(inputRole) >= 0) {
		return resolveRoleBaseAbs(inputRole);
	}
	if (stepId === "sharpen" && inputRole === "max") {
		return resolveActiveBranchLeafAbs("max", "max");
	}
	if (stepId === "collate" && inputRole === "quantification") {
		return resolveActiveBranchLeafAbs("quantification", "count");
	}
	return resolveActiveRunLeafAbs(inputRole);
}

function hasRunMarkers(dirPath, stepId) {
	if (!dirPath || !fs.existsSync(dirPath)) {
		return false;
	}
	if (fs.existsSync(path.join(dirPath, "run_manifest.json"))) {
		return true;
	}
	var entries;
	try {
		entries = fs.readdirSync(dirPath);
	} catch (err) {
		return false;
	}
	for (var i = 0; i < entries.length; i++) {
		var n = entries[i];
		if (stepId === "align" && /^annotation_.*\.pkl$/i.test(n)) {
			return true;
		}
		if (stepId === "detect" && /^predictions_.*\.pkl$/i.test(n)) {
			return true;
		}
		if (
			(stepId === "max" || stepId === "sharpen") &&
			(IMAGE_EXT_RE.test(n) || n.toLowerCase().indexOf(".ome.") !== -1)
		) {
			return true;
		}
		if (stepId === "intensity" && /\.pkl$/i.test(n) && n.indexOf("_") >= 0) {
			return true;
		}
		if (stepId === "count" && n === "count_results.csv") {
			return true;
		}
		if (stepId === "collate" && n === "count_results.csv") {
			return true;
		}
		if (stepId === "dual" && /_dual\.tif$/i.test(n)) {
			return true;
		}
	}
	return false;
}

function discoverOutputRuns(roleDir, stepId, maxDepth) {
	maxDepth = maxDepth == null ? 2 : maxDepth;
	var cfg = RUN_STEP_CONFIG[stepId];
	if (!cfg || !roleDir || !fs.existsSync(roleDir)) {
		return [];
	}
	var branch = cfg.branch;
	var found = {};

	function recordLeaf(absDir) {
		var rel = path.relative(roleDir, absDir).split(path.sep).join("/");
		var mt = 0;
		try {
			var st = fs.statSync(absDir);
			mt = st.mtimeMs;
		} catch (err) {}
		if (!found[rel] || mt > found[rel].mtime) {
			found[rel] = { rel: rel, label: rel || "(flat — role root)", mtime: mt };
		}
	}

	function walk(dir, depth, relParts) {
		if (!dir || depth > maxDepth) {
			return;
		}
		if (hasRunMarkers(dir, stepId)) {
			recordLeaf(dir);
		}
		if (depth >= maxDepth) {
			return;
		}
		var entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			return;
		}
		for (var i = 0; i < entries.length; i++) {
			if (!entries[i].isDirectory()) {
				continue;
			}
			var name = entries[i].name;
			if (name === ".masonjar" || name === ".belljar") {
				continue;
			}
			walk(path.join(dir, name), depth + 1, relParts.concat(name));
		}
	}

	if (branch) {
		var branchDir = path.join(roleDir, branch);
		if (fs.existsSync(branchDir)) {
			walk(branchDir, 0, [branch]);
		}
	}
	walk(roleDir, 0, []);

	var keys = Object.keys(found).sort(function (a, b) {
		return found[b].mtime - found[a].mtime;
	});
	return keys.map(function (k) {
		return found[k];
	});
}

function listRunChoicesForRole(role) {
	var stepId = STEP_BY_OUTPUT_ROLE[role];
	if (!stepId) {
		return [];
	}
	var base = resolveRoleBaseAbs(role);
	if (!base) {
		return [];
	}
	return discoverOutputRuns(base, stepId, 2);
}

function ensureDefaultActiveRunForRole(role) {
	if (!projectModule().isActive() || !isOutputRole(role)) {
		return;
	}
	if (getActiveRunRelForRole(role)) {
		return;
	}
	var choices = listRunChoicesForRole(role);
	if (choices.length) {
		setActiveRunRelForRole(role, choices[0].rel);
	}
}

function buildRunsCatalog(bundleRoot, roles) {
	var catalog = { generated_at: new Date().toISOString(), roles: {} };
	for (var i = 0; i < OUTPUT_ROLES.length; i++) {
		var role = OUTPUT_ROLES[i];
		var stepId = STEP_BY_OUTPUT_ROLE[role];
		var rel = roles[role] || projectModule().CANONICAL_ROLES[role];
		var dir = path.isAbsolute(rel) ? rel : path.join(bundleRoot, rel);
		catalog.roles[role] = discoverOutputRuns(dir, stepId, 2);
	}
	return catalog;
}

function writeRunsCatalog(bundleRoot, metaDirPath, roles) {
	var catalog = buildRunsCatalog(bundleRoot, roles);
	var outPath = path.join(metaDirPath, "runs_catalog.json");
	fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2), "utf8");
	return outPath;
}

function computeFinalOutputPath(stepId, context) {
	context = context || {};
	var cfg = RUN_STEP_CONFIG[stepId];
	if (!cfg) {
		return "";
	}
	var outBase = context.outBase || resolveRoleBaseAbs(cfg.outputRole);
	var flat = !!context.flat;
	var branch = context.branch != null ? context.branch : cfg.branch;
	var slug = context.slug || buildRunSlug(stepId, context);
	return resolveRunLeaf(outBase, branch, slug, flat);
}

function relFromRoleBase(stepId, finalOutAbs) {
	var cfg = RUN_STEP_CONFIG[stepId];
	if (!cfg || !finalOutAbs) {
		return "";
	}
	var base = resolveRoleBaseAbs(cfg.outputRole);
	if (!base) {
		return "";
	}
	return normalizeRelPath(path.relative(base, finalOutAbs));
}

module.exports = {
	RUN_STEP_CONFIG: RUN_STEP_CONFIG,
	OUTPUT_ROLES: OUTPUT_ROLES,
	INPUT_ROLES: INPUT_ROLES,
	isOutputRole: isOutputRole,
	sanitizeSlugPart: sanitizeSlugPart,
	sliceSpanToken: sliceSpanToken,
	buildDetectRunSlug: buildDetectRunSlug,
	buildRunSlug: buildRunSlug,
	resolveRunLeaf: resolveRunLeaf,
	discoverOutputRuns: discoverOutputRuns,
	defaultActiveRuns: defaultActiveRuns,
	migrateActiveRuns: migrateActiveRuns,
	getActiveRunRel: getActiveRunRel,
	getActiveRunRelForRole: getActiveRunRelForRole,
	setActiveRunRel: setActiveRunRel,
	setActiveRunRelForRole: setActiveRunRelForRole,
	resolveRoleBaseAbs: resolveRoleBaseAbs,
	resolveActiveRunLeafAbs: resolveActiveRunLeafAbs,
	resolveRoleLeafAbs: resolveRoleLeafAbs,
	resolveInputLeafAbs: resolveInputLeafAbs,
	resolveInputLeafAbsForStep: resolveInputLeafAbsForStep,
	resolveActiveBranchLeafAbs: resolveActiveBranchLeafAbs,
	listRunChoicesForRole: listRunChoicesForRole,
	listImageSliceStems: listImageSliceStems,
	ensureDefaultActiveRunForRole: ensureDefaultActiveRunForRole,
	buildRunsCatalog: buildRunsCatalog,
	writeRunsCatalog: writeRunsCatalog,
	computeFinalOutputPath: computeFinalOutputPath,
	relFromRoleBase: relFromRoleBase,
	hasRunMarkers: hasRunMarkers,
};
