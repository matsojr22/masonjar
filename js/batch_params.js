"use strict";

var registry = require("./batch_registry");
var project = require("./project");

var paramSections = document.getElementById("paramSections");
var preflightEl = document.getElementById("preflightWarnings");
var nextRunBtn = document.getElementById("nextRun");
var saveDefaultsCb = document.getElementById("saveDefaults");

var plan = registry.loadBatchPlan();

if (!plan || !plan.projects || !plan.projects.length || !plan.steps || !plan.steps.length) {
	window.location.href = "./batch_select.html";
}

if (!plan.params) {
	plan.params = registry.mergeParams(plan.steps);
}

function showPreflight() {
	if (!preflightEl) {
		return;
	}
	var warnings = plan.warnings || project.preflightBatchPlan(plan);
	if (!warnings.length) {
		preflightEl.classList.add("d-none");
		return;
	}
	preflightEl.classList.remove("d-none");
	preflightEl.innerHTML =
		"<strong>Warnings</strong><ul class=\"mb-0 ps-3\"><li>" +
		warnings.join("</li><li>") +
		"</li></ul>";
}

function fieldRow(label, inputHtml) {
	return (
		'<div class="mb-2"><label class="form-label small">' +
		label +
		"</label>" +
		inputHtml +
		"</div>"
	);
}

function renderMax(section, params) {
	section.innerHTML =
		fieldRow(
			"Dendrites",
			'<input type="checkbox" class="form-check-input" id="max-dendrites" ' +
				(params.dendrites ? "checked" : "") +
				" />",
		) +
		fieldRow(
			"Cells",
			'<input type="checkbox" class="form-check-input" id="max-cells" ' +
				(params.cells ? "checked" : "") +
				" />",
		);
}

function renderSharpen(section, params) {
	section.innerHTML =
		fieldRow(
			"Radius",
			'<input type="number" step="any" class="form-control form-control-sm" id="sharpen-radius" value="' +
				params.radius +
				'" />',
		) +
		fieldRow(
			"Amount",
			'<input type="number" step="any" class="form-control form-control-sm" id="sharpen-amount" value="' +
				params.amount +
				'" />',
		) +
		fieldRow(
			"Equalize",
			'<input type="checkbox" class="form-check-input" id="sharpen-equalize" ' +
				(params.equalize ? "checked" : "") +
				" />",
		);
}

function renderDetect(section, params) {
	section.innerHTML =
		fieldRow(
			"Confidence (0–1)",
			'<input type="number" step="0.01" min="0" max="1" class="form-control form-control-sm" id="detect-confidence" value="' +
				params.confidence +
				'" />',
		) +
		fieldRow(
			"Tile size",
			'<input type="number" class="form-control form-control-sm" id="detect-tile" value="' +
				params.tile +
				'" />',
		) +
		fieldRow(
			"Method",
			'<select class="form-select form-select-sm" id="detect-method"><option value="somata"' +
				(params.method === "somata" ? " selected" : "") +
				'>Somata</option><option value="nuclei"' +
				(params.method === "nuclei" ? " selected" : "") +
				">Nuclei</option></select>",
		) +
		fieldRow(
			"Area",
			'<input type="number" class="form-control form-control-sm" id="detect-area" value="' +
				params.area +
				'" />',
		) +
		fieldRow(
			"Eccentricity (0–1)",
			'<input type="number" step="0.01" min="0" max="1" class="form-control form-control-sm" id="detect-eccentricity" value="' +
				params.eccentricity +
				'" />',
		) +
		fieldRow(
			"Multichannel",
			'<input type="checkbox" class="form-check-input" id="detect-multichannel" ' +
				(params.multichannel ? "checked" : "") +
				" />",
		) +
		fieldRow(
			"Custom model path (optional)",
			'<input type="text" class="form-control form-control-sm" id="detect-customModel" value="' +
				(params.customModel || "") +
				'" />',
		);
}

function renderCount(section, params) {
	section.innerHTML = fieldRow(
		"Include layer info",
		'<input type="checkbox" class="form-check-input" id="count-layerinfo" ' +
			(params.layerinfo ? "checked" : "") +
			" />",
	);
}

function renderIntensity(section, params) {
	section.innerHTML =
		fieldRow(
			"Hemisphere",
			'<select class="form-select form-select-sm" id="intensity-hemisphere"><option value="whole"' +
				(params.wholeSlice !== false ? " selected" : "") +
				'>Whole slice</option><option value="half"' +
				(params.wholeSlice === false ? " selected" : "") +
				">Hemisphere only</option></select>",
		) +
		fieldRow(
			"Include DAPI",
			'<input type="checkbox" class="form-check-input" id="intensity-useDapi" ' +
				(params.useDapi ? "checked" : "") +
				" />",
		);
}

function renderDual(section) {
	section.innerHTML =
		'<p class="small text-muted mb-0">Uses PKL and dual output paths from each project file.</p>';
}

var renderers = {
	max: renderMax,
	sharpen: renderSharpen,
	detect: renderDetect,
	count: renderCount,
	intensity: renderIntensity,
	dual: renderDual,
};

function renderAll() {
	if (!paramSections) {
		return;
	}
	paramSections.innerHTML = "";
	for (var i = 0; i < plan.steps.length; i++) {
		var stepId = plan.steps[i];
		var meta = registry.getStepMeta(stepId);
		var params = plan.params[stepId] || registry.DEFAULT_PARAMS[stepId] || {};
		var item = document.createElement("div");
		item.className = "accordion-item";
		item.innerHTML =
			'<h2 class="accordion-header">' +
			'<button class="accordion-button' +
			(i > 0 ? " collapsed" : "") +
			'" type="button" data-bs-toggle="collapse" data-bs-target="#collapse-' +
			stepId +
			'">' +
			meta.label +
			"</button></h2>" +
			'<div id="collapse-' +
			stepId +
			'" class="accordion-collapse collapse' +
			(i === 0 ? " show" : "") +
			'"><div class="accordion-body" id="body-' +
			stepId +
			'"></div></div>';
		paramSections.appendChild(item);
		var body = document.getElementById("body-" + stepId);
		if (body && renderers[stepId]) {
			renderers[stepId](body, params);
		}
	}
}

function collectParams() {
	var out = {};
	for (var i = 0; i < plan.steps.length; i++) {
		var stepId = plan.steps[i];
		if (stepId === "max") {
			out.max = {
				dendrites: document.getElementById("max-dendrites") && document.getElementById("max-dendrites").checked,
				cells: document.getElementById("max-cells") && document.getElementById("max-cells").checked,
			};
		} else if (stepId === "sharpen") {
			out.sharpen = {
				radius: parseFloat(document.getElementById("sharpen-radius").value),
				amount: parseFloat(document.getElementById("sharpen-amount").value),
				equalize: document.getElementById("sharpen-equalize") && document.getElementById("sharpen-equalize").checked,
			};
		} else if (stepId === "detect") {
			out.detect = {
				confidence: parseFloat(document.getElementById("detect-confidence").value),
				tile: parseInt(document.getElementById("detect-tile").value, 10),
				method: document.getElementById("detect-method").value,
				area: parseInt(document.getElementById("detect-area").value, 10),
				eccentricity: parseFloat(document.getElementById("detect-eccentricity").value),
				multichannel: document.getElementById("detect-multichannel") && document.getElementById("detect-multichannel").checked,
				customModel: document.getElementById("detect-customModel").value || "",
			};
		} else if (stepId === "count") {
			out.count = {
				layerinfo: document.getElementById("count-layerinfo") && document.getElementById("count-layerinfo").checked,
			};
		} else if (stepId === "intensity") {
			var hem = document.getElementById("intensity-hemisphere").value;
			out.intensity = {
				wholeSlice: hem === "whole",
				useDapi: document.getElementById("intensity-useDapi") && document.getElementById("intensity-useDapi").checked,
			};
		} else if (stepId === "dual") {
			out.dual = {};
		}
	}
	return out;
}

function validateParams(params) {
	for (var i = 0; i < plan.steps.length; i++) {
		var stepId = plan.steps[i];
		if (stepId === "sharpen" && params.sharpen) {
			if (isNaN(params.sharpen.radius) || isNaN(params.sharpen.amount)) {
				alert("Sharpen radius and amount must be numbers.");
				return false;
			}
		}
		if (stepId === "detect" && params.detect) {
			var d = params.detect;
			if (isNaN(d.confidence) || isNaN(d.tile) || isNaN(d.area) || isNaN(d.eccentricity)) {
				alert("Detection parameters must be valid numbers.");
				return false;
			}
		}
	}
	return true;
}

if (nextRunBtn) {
	nextRunBtn.addEventListener("click", function () {
		var params = collectParams();
		if (!validateParams(params)) {
			return;
		}
		plan.params = params;
		if (saveDefaultsCb && saveDefaultsCb.checked) {
			registry.saveBatchDefaults(params);
		}
		registry.saveBatchPlan(plan);
		window.location.href = "./batch_run.html";
	});
}

showPreflight();
renderAll();
