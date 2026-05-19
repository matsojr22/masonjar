"use strict";

var branding = require("./branding");

var BATCH_PLAN_KEY = "masonjar.batchPlan";
var BATCH_DEFAULTS_KEY = "masonjar.batchDefaults";

/** Pipeline order for heavy compute steps (align/adjust excluded). */
var BATCH_STEP_ORDER = ["max", "sharpen", "detect", "count", "intensity", "dual"];

var STEP_META = {
	max: {
		id: "max",
		label: "Max projection",
		order: 1,
		roles: { indir: "original_scans", outdir: "max" },
	},
	sharpen: {
		id: "sharpen",
		label: "Sharpen",
		order: 2,
		roles: { indir: "max", outdir: "max" },
	},
	detect: {
		id: "detect",
		label: "Cell detection",
		order: 3,
		roles: { indir: "max", outdir: "predictions" },
	},
	count: {
		id: "count",
		label: "Count brain",
		order: 4,
		roles: {
			preddir: "predictions",
			annodir: "slices",
			outdir: "quantification",
		},
		requiresAnnotations: true,
	},
	intensity: {
		id: "intensity",
		label: "Isolate regions",
		order: 5,
		roles: {
			indir: "max",
			annodir: "slices",
			outdir: "pkls",
			dapi: "dapi",
		},
		requiresAnnotations: true,
	},
	dual: {
		id: "dual",
		label: "Dual-channel ROI TIFs",
		order: 6,
		roles: { indir: "pkls", outdir: "dual" },
	},
};

var DEFAULT_PARAMS = {
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
	count: { layerinfo: false },
	intensity: { wholeSlice: true, useDapi: false },
	dual: {},
};

function sortSteps(steps) {
	var orderMap = {};
	for (var i = 0; i < BATCH_STEP_ORDER.length; i++) {
		orderMap[BATCH_STEP_ORDER[i]] = i;
	}
	return (steps || []).slice().sort(function (a, b) {
		return (orderMap[a] ?? 99) - (orderMap[b] ?? 99);
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

module.exports = {
	BATCH_PLAN_KEY: BATCH_PLAN_KEY,
	BATCH_DEFAULTS_KEY: BATCH_DEFAULTS_KEY,
	BATCH_STEP_ORDER: BATCH_STEP_ORDER,
	STEP_META: STEP_META,
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
	PRODUCT_NAME: branding.PRODUCT_NAME,
};
