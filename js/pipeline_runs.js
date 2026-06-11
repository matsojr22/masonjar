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

var CANONICAL_ROLES = {
	original_scans: "data/original_scans",
	dapi: "data/counting/00_dapi",
	slices: "data/counting/01_slices",
	max: "data/counting/03_max",
	predictions: "data/counting/05_predictions",
	quantification: "data/counting/06_quantification",
	pkls: "data/counting/07_pkls",
	dual: "data/counting/08_dual",
};

var RUN_STEP_CONFIG = {
	max: {
		stepId: "max",
		outputRole: "max",
		branch: "max",
		inputRoles: ["original_scans"],
		scriptRoles: { indir: "original_scans", outdir: "max" },
	},
	sharpen: {
		stepId: "sharpen",
		outputRole: "max",
		branch: "sharpen",
		inputRoles: ["max"],
		scriptRoles: { indir: "max", outdir: "max" },
	},
	tophat: {
		stepId: "tophat",
		outputRole: "max",
		branch: "tophat",
		inputRoles: ["max"],
		scriptRoles: { indir: "max", outdir: "max" },
	},
	align: {
		stepId: "align",
		outputRole: "slices",
		branch: "align",
		inputRoles: ["dapi"],
		scriptRoles: { indir: "dapi", outdir: "slices" },
	},
	intensity: {
		stepId: "intensity",
		outputRole: "pkls",
		branch: "intensity",
		inputRoles: ["max", "slices"],
		scriptRoles: {
			indir: "max",
			annodir: "slices",
			outdir: "pkls",
			dapi: "dapi",
		},
	},
	detect: {
		stepId: "detect",
		outputRole: "predictions",
		branch: null,
		inputRoles: ["max"],
		scriptRoles: { indir: "max", outdir: "predictions" },
	},
	count: {
		stepId: "count",
		outputRole: "quantification",
		branch: "count",
		inputRoles: ["predictions", "slices"],
		scriptRoles: {
			preddir: "predictions",
			annodir: "slices",
			outdir: "quantification",
		},
	},
	collate: {
		stepId: "collate",
		outputRole: "quantification",
		branch: "collate",
		inputRoles: ["quantification"],
		scriptRoles: { indir: "quantification", outdir: "quantification" },
	},
	dual: {
		stepId: "dual",
		outputRole: "dual",
		branch: "dual",
		inputRoles: ["pkls"],
		scriptRoles: { indir: "pkls", outdir: "dual" },
	},
	dapi_cleanup: {
		stepId: "dapi_cleanup",
		outputRole: null,
		branch: null,
		inputRoles: ["dapi"],
		scriptRoles: { indir: "dapi", outdir: "dapi" },
	},
	parcellation: {
		stepId: "parcellation",
		outputRole: null,
		branch: null,
		inputRoles: ["slices"],
		scriptRoles: { annodir: "slices" },
	},
	apply_geometry: {
		stepId: "apply_geometry",
		outputRole: null,
		branch: null,
		inputRoles: [],
		scriptRoles: {},
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
		var sharpenSrc = "";
		if (context.sourceKind && context.sourceKind !== "max" && context.sourceRunRel) {
			sharpenSrc = "_from_" + shortRefToken(context.sourceRunRel);
		}
		return sanitizeSlugPart(
			span +
				"_r" +
				decToken(context.radius) +
				"_a" +
				decToken(context.amount) +
				(context.equalize ? "_eq" : "") +
				sharpenSrc +
				subset,
		);
	}
	if (stepId === "tophat") {
		var topPrefix = "top" + String(Math.round(context.radius != null ? context.radius : 10));
		var gammaTok = "";
		if (context.gamma != null && Math.abs(Number(context.gamma) - 1.25) > 0.001) {
			gammaTok = "_g" + decToken(context.gamma);
		}
		var topSrc = "";
		if (context.sourceKind && context.sourceKind !== "max" && context.sourceRunRel) {
			topSrc = "_from_" + shortRefToken(context.sourceRunRel);
		}
		return sanitizeSlugPart(topPrefix + "_" + span + gammaTok + topSrc + subset);
	}
	if (stepId === "align") {
		var spacing = context.spacing != null ? "_sp" + String(context.spacing) : "";
		var layoutTok = "_auto";
		if (context.whole === "False") {
			layoutTok = "_half";
		} else if (context.whole === "True") {
			layoutTok = "_whole";
		}
		var leg = context.legacy === true || context.legacy === "True" ? "_leg" : "";
		return sanitizeSlugPart(span + spacing + layoutTok + leg + subset);
	}
	if (stepId === "intensity") {
		var mode = context.whole === false || context.whole === "False" ? "_hemi" : "_whole";
		var dapi = context.useDapi ? "_dapi" : "";
		var rc =
			context.regionCount && context.regionCount > 0
				? "_r" + String(context.regionCount)
				: "";
		var layers = context.includeLayers ? "_layers" : "";
		return sanitizeSlugPart(span + mode + dapi + rc + layers + subset);
	}
	if (stepId === "count") {
		var predRef = shortRefToken(context.predictionRunRel);
		var sliceRef = shortRefToken(context.slicesRunRel);
		return sanitizeSlugPart(
			"p_" + predRef + "_s_" + sliceRef + subset,
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

function branchForOutputRole(role) {
	var stepId = STEP_BY_OUTPUT_ROLE[role];
	if (!stepId) {
		return "";
	}
	var cfg = RUN_STEP_CONFIG[stepId];
	return cfg && cfg.branch ? cfg.branch : "";
}

/** Collapse ``branch/slug/branch/slug/...`` (repeat while duplicated prefix). */
function dedupeBranchRunRel(rel, branch) {
	rel = normalizeRelPath(rel);
	if (!rel || !branch) {
		return rel;
	}
	var escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	var re = new RegExp("^(" + escaped + "\\/[^/]+)\\/\\1");
	var next = rel;
	do {
		rel = next;
		next = rel.replace(re, "$1");
	} while (next !== rel);
	return rel;
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
	for (var i = 0; i < OUTPUT_ROLES.length; i++) {
		var role = OUTPUT_ROLES[i];
		var branch = branchForOutputRole(role);
		if (branch && runs[role]) {
			runs[role] = dedupeBranchRunRel(runs[role], branch);
		}
	}
	return runs;
}

function getActiveRunRelForRole(role) {
	if (!isOutputRole(role)) {
		return "";
	}
	var runs = getActiveRunsMap();
	var rel = normalizeRelPath(runs[role] || "");
	var branch = branchForOutputRole(role);
	if (branch) {
		rel = dedupeBranchRunRel(rel, branch);
	}
	return rel;
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
	rel = normalizeRelPath(rel);
	var branch = branchForOutputRole(role);
	if (branch) {
		rel = dedupeBranchRunRel(rel, branch);
	}
	proj.processing.active_runs[role] = rel;
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
	if (!projectModule().isActive()) {
		return "";
	}
	var proj = projectModule().getProject();
	var bundleRoot = projectModule().getBundleRoot();
	var roles = (proj && proj.roles) || CANONICAL_ROLES;
	var processing = proj ? proj.processing : null;
	return resolveActiveBranchLeafAbsForBundle(
		bundleRoot,
		roles,
		processing,
		role,
		branch,
	);
}

function resolveInputLeafAbsForStep(stepId, inputRole) {
	if (!projectModule().isActive()) {
		return "";
	}
	var proj = projectModule().getProject();
	var bundleRoot = projectModule().getBundleRoot();
	var roles = (proj && proj.roles) || CANONICAL_ROLES;
	var processing = proj ? proj.processing : null;
	return resolveInputLeafAbsForStepBundle(
		bundleRoot,
		roles,
		processing,
		stepId,
		inputRole,
	);
}

/** Bundle-aware role base directory (does not require an active project). */
function resolveRoleBaseAbsForBundle(bundleRoot, roles, role) {
	if (!bundleRoot || !role) {
		return "";
	}
	var rel = (roles && roles[role]) || CANONICAL_ROLES[role];
	if (!rel) {
		return "";
	}
	return path.isAbsolute(rel) ? rel : path.join(bundleRoot, rel);
}

/** Bundle-aware active run leaf (no `projectModule()`); used by main process. */
function resolveActiveRunLeafAbsForBundle(bundleRoot, roles, processing, role) {
	var base = resolveRoleBaseAbsForBundle(bundleRoot, roles, role);
	if (!base || !isOutputRole(role)) {
		return base;
	}
	var active = migrateActiveRuns(processing || null);
	var rel = (active && active[role]) || "";
	if (!rel) {
		return base;
	}
	return path.join(base, rel.split("/").join(path.sep));
}

/** Bundle-aware branch-preferring leaf (sharpen sees max branch, collate sees count branch). */
function resolveActiveBranchLeafAbsForBundle(
	bundleRoot,
	roles,
	processing,
	role,
	branch,
) {
	var base = resolveRoleBaseAbsForBundle(bundleRoot, roles, role);
	if (!base || !branch) {
		return base;
	}
	var active = migrateActiveRuns(processing || null);
	var activeRel = (active && active[role]) || "";
	if (activeRel) {
		var parts = activeRel.split("/");
		if (parts[0] === branch) {
			return path.join(base, activeRel.split("/").join(path.sep));
		}
	}
	var stepId = STEP_BY_OUTPUT_ROLE[role];
	var runs = discoverOutputRuns(base, stepId, discoveryMaxDepth(stepId));
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

/** Bundle-aware input leaf for a given step; mirrors single-tool runtime. */
function resolveInputLeafAbsForStepBundle(
	bundleRoot,
	roles,
	processing,
	stepId,
	inputRole,
) {
	if (INPUT_ROLES.indexOf(inputRole) >= 0) {
		return resolveRoleBaseAbsForBundle(bundleRoot, roles, inputRole);
	}
	if (stepId === "sharpen" && inputRole === "max") {
		return resolveActiveBranchLeafAbsForBundle(
			bundleRoot,
			roles,
			processing,
			"max",
			"max",
		);
	}
	if (stepId === "collate" && inputRole === "quantification") {
		return resolveActiveBranchLeafAbsForBundle(
			bundleRoot,
			roles,
			processing,
			"quantification",
			"count",
		);
	}
	return resolveActiveRunLeafAbsForBundle(
		bundleRoot,
		roles,
		processing,
		inputRole,
	);
}

/**
 * Resolve every script-arg path for a step (e.g. `{indir, outdir, ...}`) given a bundle.
 * Output role keys map to active-run leaf; input roles map via `resolveInputLeafAbsForStepBundle`.
 */
function resolvePathsForBundleStep(bundleRoot, roles, processing, stepId) {
	var cfg = RUN_STEP_CONFIG[stepId];
	if (!cfg || !cfg.scriptRoles) {
		return {};
	}
	var out = {};
	var keys = Object.keys(cfg.scriptRoles);
	for (var i = 0; i < keys.length; i++) {
		var key = keys[i];
		var role = cfg.scriptRoles[key];
		if (key === "outdir") {
			out[key] = resolveActiveRunLeafAbsForBundle(
				bundleRoot,
				roles,
				processing,
				role,
			);
		} else {
			out[key] = resolveInputLeafAbsForStepBundle(
				bundleRoot,
				roles,
				processing,
				stepId,
				role,
			);
		}
	}
	return out;
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
			(stepId === "max" || stepId === "sharpen" || stepId === "tophat") &&
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

function discoveryMaxDepth(stepId) {
	if (stepId === "max" || stepId === "sharpen" || stepId === "tophat") {
		return 3;
	}
	return 2;
}

function discoverOutputRuns(roleDir, stepId, maxDepth) {
	maxDepth = maxDepth == null ? discoveryMaxDepth(stepId) : maxDepth;
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
	var choices = discoverOutputRuns(base, stepId, discoveryMaxDepth(stepId));
	var active = getActiveRunRelForRole(role);
	if (!active) {
		return choices;
	}
	for (var i = 0; i < choices.length; i++) {
		if (choices[i].rel === active) {
			return choices;
		}
	}
	var leaf = resolveRunLeaf(base, stepId, active, false);
	if (leaf && fs.existsSync(leaf) && hasRunMarkers(leaf, stepId)) {
		choices = choices.slice();
		choices.unshift({
			rel: active,
			label: active,
			mtime: 0,
		});
	}
	return choices;
}

function discoverRunChoicesForBundle(bundleRoot, roles, role) {
	var stepId = STEP_BY_OUTPUT_ROLE[role];
	if (!stepId) {
		return [];
	}
	var base = resolveRoleBaseAbsForBundle(bundleRoot, roles, role);
	if (!base) {
		return [];
	}
	return discoverOutputRuns(base, stepId, discoveryMaxDepth(stepId));
}

function activeRunLeafAbsForBundle(bundleRoot, roles, role, activeRel) {
	var base = resolveRoleBaseAbsForBundle(bundleRoot, roles, role);
	if (!base) {
		return "";
	}
	activeRel = normalizeRelPath(activeRel);
	if (!activeRel) {
		return base;
	}
	return path.join(base, activeRel.split("/").join(path.sep));
}

function isStoredActiveRunValid(bundleRoot, roles, role, activeRel) {
	var stepId = STEP_BY_OUTPUT_ROLE[role];
	if (!stepId) {
		return false;
	}
	var leaf = activeRunLeafAbsForBundle(bundleRoot, roles, role, activeRel);
	if (!leaf || !fs.existsSync(leaf)) {
		return false;
	}
	return hasRunMarkers(leaf, stepId);
}

function reconcileProjectRunsOnOpen(bundleRoot, roles, processing) {
	var runs = migrateActiveRuns(processing || null);
	var changed = false;
	for (var i = 0; i < OUTPUT_ROLES.length; i++) {
		var role = OUTPUT_ROLES[i];
		var choices = discoverRunChoicesForBundle(bundleRoot, roles, role);
		var active = normalizeRelPath(runs[role] || "");
		if (active) {
			if (!isStoredActiveRunValid(bundleRoot, roles, role, active)) {
				runs[role] = "";
				changed = true;
				active = "";
			}
		}
		if (!active && choices.length === 1) {
			var sole = normalizeRelPath(choices[0].rel);
			if (runs[role] !== sole) {
				runs[role] = sole;
				changed = true;
			}
		}
	}
	return { active_runs: runs, changed: changed };
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
		var rel = roles[role] || CANONICAL_ROLES[role];
		var dir = path.isAbsolute(rel) ? rel : path.join(bundleRoot, rel);
		catalog.roles[role] = discoverOutputRuns(dir, stepId, discoveryMaxDepth(stepId));
	}
	return catalog;
}

function writeRunsCatalog(bundleRoot, metaDirPath, roles) {
	var catalog = buildRunsCatalog(bundleRoot, roles);
	var outPath = path.join(metaDirPath, "runs_catalog.json");
	fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2), "utf8");
	return outPath;
}

function runRelVariants(role, rel) {
	rel = normalizeRelPath(rel);
	if (!rel) {
		return [];
	}
	var branch = branchForOutputRole(role);
	var variants = [rel];
	if (branch) {
		var collapsed = dedupeBranchRunRel(rel, branch);
		if (collapsed && variants.indexOf(collapsed) < 0) {
			variants.push(collapsed);
		}
		if (collapsed && collapsed.indexOf(branch + "/") === 0) {
			var inner = collapsed.slice(branch.length + 1);
			var doubled = branch + "/" + inner + "/" + branch + "/" + inner;
			if (variants.indexOf(doubled) < 0) {
				variants.push(doubled);
			}
		}
	}
	return variants;
}

function isPathUnderRoot(rootAbs, targetAbs) {
	var root = path.resolve(rootAbs);
	var target = path.resolve(targetAbs);
	if (target === root) {
		return true;
	}
	var prefix = root + path.sep;
	return target.length > prefix.length && target.slice(0, prefix.length) === prefix;
}

function isSafeRunDeleteTarget(bundleRoot, roleBaseAbs, targetAbs) {
	if (!bundleRoot || !roleBaseAbs || !targetAbs) {
		return false;
	}
	var roleBase = path.resolve(roleBaseAbs);
	var target = path.resolve(targetAbs);
	if (target === roleBase) {
		return false;
	}
	if (!isPathUnderRoot(roleBase, target)) {
		return false;
	}
	return isPathUnderRoot(bundleRoot, target);
}

function collectRunDeleteTargets(bundleRoot, roles, role, rel) {
	rel = normalizeRelPath(rel);
	if (!rel || !bundleRoot || !isOutputRole(role)) {
		return [];
	}
	var roleBaseAbs = resolveRoleBaseAbsForBundle(bundleRoot, roles, role);
	if (!roleBaseAbs || !fs.existsSync(roleBaseAbs)) {
		return [];
	}
	var variants = runRelVariants(role, rel);
	var seen = {};
	var targets = [];
	for (var v = 0; v < variants.length; v++) {
		var variant = variants[v];
		var abs = path.join(roleBaseAbs, variant.split("/").join(path.sep));
		if (seen[abs] || !fs.existsSync(abs)) {
			continue;
		}
		try {
			if (!fs.statSync(abs).isDirectory()) {
				continue;
			}
		} catch (err) {
			continue;
		}
		if (!isSafeRunDeleteTarget(bundleRoot, roleBaseAbs, abs)) {
			continue;
		}
		seen[abs] = true;
		targets.push({
			abs: abs,
			rel: variant,
			relToBundle: path.relative(bundleRoot, abs).split(path.sep).join("/"),
		});
	}
	return targets;
}

function buildRunDeleteConfirmMessage(role, rel, targets) {
	if (!targets.length) {
		return "";
	}
	var lines = [
		"Delete this pipeline output folder from the project bundle?",
		"",
		"Role: " + role,
		"Task: " + rel,
		"",
		"Folder(s) to remove:",
	];
	for (var i = 0; i < targets.length; i++) {
		lines.push("  • " + targets[i].relToBundle);
		lines.push("    " + targets[i].abs);
	}
	lines.push("");
	lines.push("This cannot be undone. Files on disk will be deleted.");
	return lines.join("\n");
}

function activeRunMatchesDeleted(activeRel, deletedRels) {
	activeRel = normalizeRelPath(activeRel);
	if (!activeRel) {
		return false;
	}
	for (var i = 0; i < deletedRels.length; i++) {
		if (normalizeRelPath(deletedRels[i]) === activeRel) {
			return true;
		}
	}
	return false;
}

function pruneEmptyRunParents(roleBaseAbs, deletedAbs, branch) {
	var current = path.resolve(deletedAbs);
	var stopAt = path.resolve(roleBaseAbs);
	if (branch) {
		var branchDir = path.join(stopAt, branch);
		if (fs.existsSync(branchDir)) {
			stopAt = path.resolve(branchDir);
		}
	}
	while (current !== stopAt && isPathUnderRoot(stopAt, current)) {
		var parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		try {
			var entries = fs.readdirSync(parent);
			if (entries.length > 0) {
				break;
			}
			fs.rmdirSync(parent);
		} catch (err) {
			break;
		}
		current = parent;
	}
}

function removeRunForRole(role, rel, options) {
	options = options || {};
	if (!projectModule().isActive() || !isOutputRole(role)) {
		return { ok: false, error: "no active project" };
	}
	rel = normalizeRelPath(rel);
	if (!rel) {
		return { ok: false, error: "cannot delete flat role root" };
	}
	var bundleRoot = options.bundleRoot || projectModule().getBundleRoot();
	var proj = projectModule().getProject();
	var roles = (proj && proj.roles) || CANONICAL_ROLES;
	var targets = collectRunDeleteTargets(bundleRoot, roles, role, rel);
	if (!targets.length) {
		return { ok: false, error: "no deletable run folder found for " + rel };
	}
	var roleBaseAbs = resolveRoleBaseAbsForBundle(bundleRoot, roles, role);
	var stepId = STEP_BY_OUTPUT_ROLE[role];
	var cfg = stepId ? RUN_STEP_CONFIG[stepId] : null;
	var branch = cfg && cfg.branch;
	var deletedRels = [];
	for (var t = 0; t < targets.length; t++) {
		try {
			fs.rmSync(targets[t].abs, { recursive: true, force: true });
			deletedRels.push(targets[t].rel);
			pruneEmptyRunParents(roleBaseAbs, targets[t].abs, branch);
		} catch (err) {
			return {
				ok: false,
				error: String(err.message || err),
				deleted: deletedRels,
			};
		}
	}
	var activeRel = getActiveRunRelForRole(role);
	var variantRels = runRelVariants(role, rel);
	if (activeRunMatchesDeleted(activeRel, variantRels)) {
		var remaining = listRunChoicesForRole(role);
		var nextRel = remaining.length ? remaining[0].rel : "";
		setActiveRunRelForRole(role, nextRel);
	}
	var metaPath = options.metaDirPath;
	if (!metaPath && projectModule().metaDirPath) {
		metaPath = projectModule().metaDirPath(bundleRoot);
	}
	if (metaPath) {
		writeRunsCatalog(bundleRoot, metaPath, roles);
	}
	return { ok: true, deleted: deletedRels, targets: targets };
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
	CANONICAL_ROLES: CANONICAL_ROLES,
	OUTPUT_ROLES: OUTPUT_ROLES,
	INPUT_ROLES: INPUT_ROLES,
	STEP_BY_OUTPUT_ROLE: STEP_BY_OUTPUT_ROLE,
	isOutputRole: isOutputRole,
	sanitizeSlugPart: sanitizeSlugPart,
	sliceSpanToken: sliceSpanToken,
	buildDetectRunSlug: buildDetectRunSlug,
	buildRunSlug: buildRunSlug,
	resolveRunLeaf: resolveRunLeaf,
	dedupeBranchRunRel: dedupeBranchRunRel,
	discoveryMaxDepth: discoveryMaxDepth,
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
	resolveRoleBaseAbsForBundle: resolveRoleBaseAbsForBundle,
	resolveActiveRunLeafAbsForBundle: resolveActiveRunLeafAbsForBundle,
	resolveActiveBranchLeafAbsForBundle: resolveActiveBranchLeafAbsForBundle,
	resolveInputLeafAbsForStepBundle: resolveInputLeafAbsForStepBundle,
	resolvePathsForBundleStep: resolvePathsForBundleStep,
	listRunChoicesForRole: listRunChoicesForRole,
	listImageSliceStems: listImageSliceStems,
	ensureDefaultActiveRunForRole: ensureDefaultActiveRunForRole,
	discoverRunChoicesForBundle: discoverRunChoicesForBundle,
	isStoredActiveRunValid: isStoredActiveRunValid,
	reconcileProjectRunsOnOpen: reconcileProjectRunsOnOpen,
	buildRunsCatalog: buildRunsCatalog,
	writeRunsCatalog: writeRunsCatalog,
	computeFinalOutputPath: computeFinalOutputPath,
	relFromRoleBase: relFromRoleBase,
	hasRunMarkers: hasRunMarkers,
	collectRunDeleteTargets: collectRunDeleteTargets,
	buildRunDeleteConfirmMessage: buildRunDeleteConfirmMessage,
	removeRunForRole: removeRunForRole,
	isSafeRunDeleteTarget: isSafeRunDeleteTarget,
};
