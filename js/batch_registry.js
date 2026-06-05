"use strict";

var branding = require("./branding");

var BATCH_PLAN_KEY = "masonjar.batchPlan";
var BATCH_DEFAULTS_KEY = "masonjar.batchDefaults";

/**
 * Pipeline order for heavy compute steps (align/adjust excluded because they are
 * interactive). Order is the dependency order used by the wizard; the queue itself
 * also respects DEPENDENCY_GRAPH for skip-downstream propagation.
 */
var BATCH_STEP_ORDER = [
	"apply_geometry",
	"dapi_cleanup",
	"parcellation",
	"max",
	"sharpen",
	"detect",
	"intensity",
	"count",
	"dual",
	"collate",
];

var STEP_META = {
	apply_geometry: {
		id: "apply_geometry",
		label: "Apply orientation (rotate/flip)",
		description:
			"Bake the per-slice rotate/flip from CZI import into PNG + TIFF files (00_dapi, _previews, original_scans, 03_max).",
		order: 0,
		roles: {},
		requiresAnnotations: false,
		bundleWide: true,
	},
	dapi_cleanup: {
		id: "dapi_cleanup",
		label: "DAPI cleanup",
		description:
			"Polish DAPI previews (isolate tissue, CLAHE, saturation stretch) in-place with backup.",
		order: 1,
		roles: { indir: "dapi", outdir: "dapi" },
		requiresAnnotations: false,
	},
	parcellation: {
		id: "parcellation",
		label: "Parcellation (CCF rollup)",
		description:
			"Roll annotation borders to a chosen CCF tier on every slice in the active align run (in-place).",
		order: 2,
		roles: { annodir: "slices" },
		requiresAnnotations: true,
		dependsOn: [],
	},
	max: {
		id: "max",
		label: "Max projection",
		description: "Collapse z-stacks under `original_scans/` into a single max projection per slice.",
		order: 3,
		roles: { indir: "original_scans", outdir: "max" },
	},
	sharpen: {
		id: "sharpen",
		label: "Sharpen",
		description: "Unsharp-mask sharpen the active max projections.",
		order: 3,
		roles: { indir: "max", outdir: "max" },
		dependsOn: ["max"],
	},
	detect: {
		id: "detect",
		label: "Cell detection (SAHI)",
		description: "Run cell/nuclei detection on the active max branch.",
		order: 4,
		roles: { indir: "max", outdir: "predictions" },
		dependsOn: ["max"],
	},
	intensity: {
		id: "intensity",
		label: "Isolate regions",
		description:
			"Export ROI PKLs (and optional DAPI ROI) for selected CCF regions.",
		order: 5,
		roles: {
			indir: "max",
			annodir: "slices",
			outdir: "pkls",
			dapi: "dapi",
		},
		requiresAnnotations: true,
		dependsOn: ["max"],
	},
	count: {
		id: "count",
		label: "Count brain",
		description: "Aggregate per-region cell counts from prediction PKLs + alignment.",
		order: 6,
		roles: {
			preddir: "predictions",
			annodir: "slices",
			outdir: "quantification",
		},
		requiresAnnotations: true,
		dependsOn: ["detect"],
	},
	dual: {
		id: "dual",
		label: "Dual-channel ROI TIFs",
		description: "Export DAPI + signal ROIs as hyperstacked TIFFs (requires Isolate Regions).",
		order: 7,
		roles: { indir: "pkls", outdir: "dual" },
		dependsOn: ["intensity"],
	},
	collate: {
		id: "collate",
		label: "Collate counts (whole batch)",
		description:
			"Combine the count_results.csv from every project into one collated report (runs once at the end).",
		order: 8,
		roles: { indir: "quantification", outdir: "quantification" },
		dependsOn: ["count"],
		singleRun: true,
	},
};

var DEPENDENCY_GRAPH = {
	apply_geometry: [
		"dapi_cleanup",
		"parcellation",
		"max",
		"sharpen",
		"detect",
		"count",
		"intensity",
		"dual",
		"collate",
	],
	dapi_cleanup: ["parcellation", "intensity", "dual"],
	parcellation: ["count", "intensity", "dual", "collate"],
	max: ["sharpen", "detect", "intensity", "count", "collate", "dual"],
	sharpen: ["detect", "intensity", "count", "collate", "dual"],
	detect: ["count", "collate"],
	count: ["collate"],
	intensity: ["dual"],
	dual: [],
	collate: [],
};

var DEFAULT_PARAMS = {
	apply_geometry: {},
	dapi_cleanup: {
		isolate: true,
		clahe: false,
		saturation: 5,
		inPlace: true,
		bgValue: "",
	},
	parcellation: {
		tierId: "areas",
		stLevel: null,
		ccfAdvanced: false,
		includedRegionIds: [],
	},
	max: { dendrites: false, cells: false },
	sharpen: { radius: 1, amount: 1, equalize: false },
	detect: {
		confidence: 0.5,
		tile: 640,
		method: "somata",
		area: 200,
		eccentricity: 0.2,
		multichannel: false,
		customModel: "",
	},
	intensity: {
		wholeSlice: true,
		useDapi: false,
		selectedRegionIds: [],
		includeLayers: false,
	},
	count: {},
	dual: {},
	collate: { name: "collated", regions: "" },
};

function sortSteps(steps) {
	var orderMap = {};
	for (var i = 0; i < BATCH_STEP_ORDER.length; i++) {
		orderMap[BATCH_STEP_ORDER[i]] = i;
	}
	return (steps || []).slice().sort(function (a, b) {
		var oa = orderMap[a] == null ? 99 : orderMap[a];
		var ob = orderMap[b] == null ? 99 : orderMap[b];
		return oa - ob;
	});
}

function loadBatchDefaults() {
	try {
		return JSON.parse(localStorage.getItem(BATCH_DEFAULTS_KEY) || "{}");
	} catch (err) {
		return {};
	}
}

function saveBatchDefaults(params) {
	localStorage.setItem(BATCH_DEFAULTS_KEY, JSON.stringify(params || {}));
}

function mergeParams(selectedSteps) {
	var merged = {};
	var saved = loadBatchDefaults();
	for (var i = 0; i < BATCH_STEP_ORDER.length; i++) {
		var id = BATCH_STEP_ORDER[i];
		merged[id] = Object.assign({}, DEFAULT_PARAMS[id], saved[id] || {});
	}
	if (selectedSteps) {
		for (var j = 0; j < selectedSteps.length; j++) {
			var step = selectedSteps[j];
			if (!merged[step]) {
				merged[step] = Object.assign({}, DEFAULT_PARAMS[step] || {});
			}
		}
	}
	return merged;
}

function loadBatchPlan() {
	try {
		return JSON.parse(sessionStorage.getItem(BATCH_PLAN_KEY) || "null");
	} catch (err) {
		return null;
	}
}

function saveBatchPlan(plan) {
	sessionStorage.setItem(BATCH_PLAN_KEY, JSON.stringify(plan));
}

function clearBatchPlan() {
	sessionStorage.removeItem(BATCH_PLAN_KEY);
}

function getStepMeta(stepId) {
	return STEP_META[stepId] || null;
}

function getStepLabel(stepId) {
	var meta = getStepMeta(stepId);
	return meta ? meta.label : stepId;
}

function getStepDependsOn(stepId) {
	var meta = getStepMeta(stepId);
	return (meta && meta.dependsOn) || [];
}

function getDownstreamSteps(stepId) {
	return (DEPENDENCY_GRAPH[stepId] || []).slice();
}

/** Pure helper: given a sequence of jobs and a set of failed (projPath, stepId), return the steps to skip for each project. */
function computeSkipDownstream(plan, failedSet) {
	var skip = {};
	if (!plan || !plan.projects) {
		return skip;
	}
	for (var p = 0; p < plan.projects.length; p++) {
		var proj = plan.projects[p];
		skip[proj.path] = {};
		var failedSteps = failedSet[proj.path] || {};
		var steps = Object.keys(failedSteps);
		for (var s = 0; s < steps.length; s++) {
			var downstream = getDownstreamSteps(steps[s]);
			for (var d = 0; d < downstream.length; d++) {
				skip[proj.path][downstream[d]] = true;
			}
		}
	}
	return skip;
}

/** Validate a plan structurally. Returns array of error messages. */
function validateBatchPlan(plan) {
	var errors = [];
	if (!plan || typeof plan !== "object") {
		errors.push("Plan is missing.");
		return errors;
	}
	if (!Array.isArray(plan.projects) || !plan.projects.length) {
		errors.push("Pick at least one project.");
	}
	if (!Array.isArray(plan.steps) || !plan.steps.length) {
		errors.push("Pick at least one step.");
	}
	if (plan.steps) {
		for (var i = 0; i < plan.steps.length; i++) {
			if (!STEP_META[plan.steps[i]]) {
				errors.push("Unknown step: " + plan.steps[i]);
			}
		}
		if (plan.steps.indexOf("intensity") >= 0) {
			if (
				!plan.intensity ||
				!Array.isArray(plan.intensity.selected_region_ids) ||
				plan.intensity.selected_region_ids.length === 0
			) {
				errors.push("Isolate Regions: pick at least one CCF region.");
			}
		}
		if (plan.steps.indexOf("collate") >= 0 && plan.projects && plan.projects.length < 2) {
			errors.push("Collate needs at least 2 projects.");
		}
	}
	return errors;
}

module.exports = {
	BATCH_PLAN_KEY: BATCH_PLAN_KEY,
	BATCH_DEFAULTS_KEY: BATCH_DEFAULTS_KEY,
	BATCH_STEP_ORDER: BATCH_STEP_ORDER,
	STEP_META: STEP_META,
	DEPENDENCY_GRAPH: DEPENDENCY_GRAPH,
	DEFAULT_PARAMS: DEFAULT_PARAMS,
	sortSteps: sortSteps,
	loadBatchDefaults: loadBatchDefaults,
	saveBatchDefaults: saveBatchDefaults,
	mergeParams: mergeParams,
	loadBatchPlan: loadBatchPlan,
	saveBatchPlan: saveBatchPlan,
	clearBatchPlan: clearBatchPlan,
	getStepMeta: getStepMeta,
	getStepLabel: getStepLabel,
	getStepDependsOn: getStepDependsOn,
	getDownstreamSteps: getDownstreamSteps,
	computeSkipDownstream: computeSkipDownstream,
	validateBatchPlan: validateBatchPlan,
	PRODUCT_NAME: branding.PRODUCT_NAME,
};
