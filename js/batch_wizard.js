"use strict";

/**
 * Batch wizard (Setup → Run → Summary) — replaces batch_select/params/run.
 *
 * Mirrors the CZI / Isolate Regions wizards: `body.wizard-page`, `#wizardSteps`
 * pills, `setStep()`, sticky cancel hidden while running, dual logging to the
 * wizard `pre.wizard-log` + the global Application log.
 *
 * Plan flow:
 *   sessionStorage[masonjar.batchPlan] ↔ batch_registry helpers
 *   ipc 'runBatch' / 'killBatch' ↔ src/batch_queue.ts
 *   ipc 'batchJobStart', 'batchJobLog', 'batchJobEnd', 'batchProgress',
 *       'batchComplete'.
 */

var fs = require("fs");
var path = require("path");
var ipc = require("electron").ipcRenderer;
var dialogs = require("./dialogs");
var registry = require("./batch_registry");
var project = require("./project");
var pipelineRuns = require("./pipeline_runs");
var structureCatalog = require("./structure_catalog");
var atlasStyle = require("./atlas_region_style");
var branding = require("./branding");

var LOG_MAX = 2000;
var PICKER_MODE_KEY = "masonjar.ccfPickerMode";

function qs(id) {
	return document.getElementById(id);
}

function getAppRoot() {
	var p = decodeURIComponent(window.location.pathname || "");
	p = p.replace(/\\/g, "/");
	if (/^\/[A-Za-z]:\//.test(p)) {
		p = p.slice(1);
	}
	return path.dirname(path.dirname(p));
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------- state ----
var state = {
	step: 1,
	projects: {},        // path -> { path, name }
	selectedSteps: {},   // stepId -> true
	params: {},          // stepId -> params
	intensity: {
		selectedIds: [],
		includeLayers: false,
		whole: true,
		useDapi: false,
	},
	collate: {
		outputProjectPath: "",
		name: "collated",
		regions: "",
	},
	pickerMode: "tiers",
	availableHighlight: null,
	selectedHighlight: null,
	catalog: null,
	running: false,
	elapsedTimer: null,
	elapsedStart: null,
	matrixCells: {}, // `${projPath}::${stepId}` -> { td, status }
	failedTails: {}, // `${projPath}::${stepId}` -> string[]
	summary: null,
};

// load any prior plan
function loadPlanFromSession() {
	var plan = registry.loadBatchPlan();
	if (!plan) return;
	if (plan.projects) {
		for (var i = 0; i < plan.projects.length; i++) {
			var p = plan.projects[i];
			state.projects[p.path] = { path: p.path, name: p.name };
		}
	}
	if (plan.steps) {
		for (var j = 0; j < plan.steps.length; j++) {
			state.selectedSteps[plan.steps[j]] = true;
		}
	}
	if (plan.params) {
		state.params = plan.params;
	}
	if (plan.intensity) {
		state.intensity.selectedIds = (plan.intensity.selected_region_ids || []).slice();
		state.intensity.includeLayers = !!plan.intensity.include_layers;
	}
	if (plan.collate) {
		state.collate = Object.assign({}, state.collate, plan.collate);
	}
}

function listProjects() {
	return Object.keys(state.projects).map(function (k) {
		return state.projects[k];
	});
}

function listSelectedSteps() {
	return registry.sortSteps(
		registry.BATCH_STEP_ORDER.filter(function (id) {
			return !!state.selectedSteps[id];
		}),
	);
}

// ---------------------------------------------------------------- setStep ----
function setStep(n) {
	state.step = n;
	var panels = document.querySelectorAll(".wizard-panel");
	for (var i = 0; i < panels.length; i++) {
		panels[i].classList.add("d-none");
	}
	var active = qs("step" + n);
	if (active) {
		active.classList.remove("d-none");
	}
	var pills = document.querySelectorAll("#wizardSteps .nav-link");
	for (var p = 0; p < pills.length; p++) {
		var s = Number(pills[p].getAttribute("data-step"));
		pills[p].classList.remove("active", "disabled");
		if (s === n) {
			pills[p].classList.add("active");
		} else {
			pills[p].classList.add("disabled");
		}
	}
}

// ---------------------------------------------------------------- Step 1 ----

function renderProjects() {
	var el = qs("projectList");
	if (!el) return;
	el.innerHTML = "";
	var entries = listProjects();
	if (!entries.length) {
		el.innerHTML = '<p class="text-muted small mb-0">No projects added.</p>';
		updateStartButton();
		renderPreflightMatrix();
		return;
	}
	for (var i = 0; i < entries.length; i++) {
		(function (entry) {
			var row = document.createElement("div");
			row.className = "project-row";
			row.innerHTML =
				'<div><strong>' +
				escapeHtml(entry.name) +
				'</strong><div class="proj-path">' +
				escapeHtml(entry.path) +
				"</div></div>" +
				'<button type="button" class="btn btn-sm btn-link text-danger">Remove</button>';
			row.querySelector("button").addEventListener("click", function () {
				delete state.projects[entry.path];
				renderProjects();
				saveCurrentPlan();
			});
			el.appendChild(row);
		})(entries[i]);
	}
	updateStartButton();
	renderPreflightMatrix();
}

function renderSteps() {
	var el = qs("stepList");
	if (!el) return;
	el.innerHTML = "";
	for (var i = 0; i < registry.BATCH_STEP_ORDER.length; i++) {
		(function (stepId) {
			var meta = registry.getStepMeta(stepId);
			if (!meta) return;
			var checked = !!state.selectedSteps[stepId];
			var row = document.createElement("div");
			row.className = "form-check";
			var depsLabel = "";
			if (meta.dependsOn && meta.dependsOn.length) {
				depsLabel =
					' <span class="badge bg-light text-muted" title="Depends on">deps: ' +
					meta.dependsOn.map(escapeHtml).join(", ") +
					"</span>";
			}
			row.innerHTML =
				'<input class="form-check-input" type="checkbox" id="step-' +
				stepId +
				'" ' +
				(checked ? "checked" : "") +
				" />" +
				'<label class="form-check-label" for="step-' +
				stepId +
				'">' +
				escapeHtml(meta.label) +
				depsLabel +
				"</label>" +
				'<div class="step-meta-desc">' +
				escapeHtml(meta.description || "") +
				"</div>";
			var cb = row.querySelector("input");
			cb.addEventListener("change", function () {
				if (cb.checked) {
					state.selectedSteps[stepId] = true;
				} else {
					delete state.selectedSteps[stepId];
				}
				renderParams();
				updateStartButton();
				renderPreflightMatrix();
				saveCurrentPlan();
			});
			el.appendChild(row);
		})(registry.BATCH_STEP_ORDER[i]);
	}
}

// ---------------------------------------------------------------- params ----

function fieldRow(label, html, formText) {
	return (
		'<div class="mb-2"><label class="form-label small">' +
		escapeHtml(label) +
		"</label>" +
		html +
		(formText ? '<div class="form-text small">' + formText + "</div>" : "") +
		"</div>"
	);
}

function renderParamSection(stepId, body, params) {
	if (stepId === "max") {
		body.innerHTML =
			fieldRow(
				"Dendrites",
				'<input type="checkbox" class="form-check-input" id="max-dendrites" ' +
					(params.dendrites ? "checked" : "") +
					" />",
			) +
			fieldRow(
				"Cells (top-hat)",
				'<input type="checkbox" class="form-check-input" id="max-cells" ' +
					(params.cells ? "checked" : "") +
					" />",
			);
		return;
	}
	if (stepId === "sharpen") {
		body.innerHTML =
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
		return;
	}
	if (stepId === "detect") {
		body.innerHTML =
			fieldRow(
				"Confidence (0–1)",
				'<input type="number" step="0.01" min="0" max="1" class="form-control form-control-sm" id="detect-confidence" value="' +
					params.confidence +
					'" />',
			) +
			fieldRow(
				"Tile size (px)",
				'<input type="number" class="form-control form-control-sm" id="detect-tile" value="' +
					params.tile +
					'" />',
			) +
			fieldRow(
				"Model",
				'<select class="form-select form-select-sm" id="detect-method">' +
					'<option value="somata"' +
					(params.method === "somata" ? " selected" : "") +
					">Somata</option>" +
					'<option value="nuclei"' +
					(params.method === "nuclei" ? " selected" : "") +
					">Nuclei</option>" +
					"</select>",
			) +
			fieldRow(
				"Min area (px)",
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
				"Multi-channel",
				'<input type="checkbox" class="form-check-input" id="detect-multichannel" ' +
					(params.multichannel ? "checked" : "") +
					" />",
			) +
			fieldRow(
				"Custom model path (optional)",
				'<input type="text" class="form-control form-control-sm" id="detect-customModel" value="' +
					escapeHtml(params.customModel || "") +
					'" />',
			);
		return;
	}
	if (stepId === "count") {
		body.innerHTML = fieldRow(
			"Include layer info",
			'<input type="checkbox" class="form-check-input" id="count-layerinfo" ' +
				(params.layerinfo ? "checked" : "") +
				" />",
		);
		return;
	}
	if (stepId === "dual") {
		body.innerHTML =
			'<p class="small text-muted mb-0">No parameters. Uses each project\'s active <code>pkls/intensity/&lt;run&gt;</code> leaf.</p>';
		return;
	}
	if (stepId === "dapi_cleanup") {
		body.innerHTML =
			fieldRow(
				"Mode",
				'<select class="form-select form-select-sm" id="dapi-inplace"><option value="true"' +
					(params.inPlace !== false ? " selected" : "") +
					'>In-place (backup originals to 00_dapi_backup)</option><option value="false"' +
					(params.inPlace === false ? " selected" : "") +
					">Separate (write to 00_dapi_clean)</option></select>",
			) +
			fieldRow(
				"Isolate tissue",
				'<input type="checkbox" class="form-check-input" id="dapi-isolate" ' +
					(params.isolate !== false ? "checked" : "") +
					" />",
			) +
			fieldRow(
				"CLAHE",
				'<input type="checkbox" class="form-check-input" id="dapi-clahe" ' +
					(params.clahe ? "checked" : "") +
					" />",
			) +
			fieldRow(
				"Saturation % (each tail)",
				'<input type="number" step="any" min="0" max="50" class="form-control form-control-sm" id="dapi-saturation" value="' +
					params.saturation +
					'" />',
			) +
			fieldRow(
				"Background value (optional 0–255)",
				'<input type="text" class="form-control form-control-sm" id="dapi-bgvalue" value="' +
					escapeHtml(params.bgValue != null ? String(params.bgValue) : "") +
					'" placeholder="auto" />',
			);
		return;
	}
	if (stepId === "apply_geometry") {
		body.innerHTML =
			'<p class="small text-muted mb-0">Applies the per-slice rotate/flip stored under <code>settings.czi_import.geometry</code>. Skipped automatically when nothing is pending.</p>';
		return;
	}
	if (stepId === "intensity") {
		body.innerHTML =
			'<div class="row g-2 mb-2">' +
				'<div class="col-md-4">' +
					'<label class="form-label small">Hemisphere</label>' +
					'<select class="form-select form-select-sm" id="intensity-hemisphere">' +
						'<option value="whole"' +
						(params.wholeSlice !== false ? " selected" : "") +
						'>Whole slice</option>' +
						'<option value="half"' +
						(params.wholeSlice === false ? " selected" : "") +
						'>Hemisphere only</option>' +
					"</select>" +
				"</div>" +
				'<div class="col-md-4">' +
					'<label class="form-label small">Include DAPI</label><br/>' +
					'<input type="checkbox" class="form-check-input" id="intensity-useDapi" ' +
					(params.useDapi ? "checked" : "") +
					" />" +
				"</div>" +
				'<div class="col-md-4">' +
					'<label class="form-label small" for="intensityTierSelect">Hierarchy</label>' +
					'<select id="intensityTierSelect" class="form-select form-select-sm"></select>' +
					'<select id="intensityLevelSelect" class="form-select form-select-sm d-none" aria-label="CCFv3 raw depth"></select>' +
				"</div>" +
			"</div>" +
			'<div class="row g-2 mb-2">' +
				'<div class="col-md-6"><label class="form-label small" for="intensityRegionSearch">Search available</label>' +
				'<input type="search" class="form-control form-control-sm" id="intensityRegionSearch" placeholder="acronym or name" /></div>' +
				'<div class="col-md-6 d-flex align-items-end gap-2">' +
				'<button type="button" class="btn btn-outline-secondary btn-sm" id="intensityPresetVis">Visual cortex preset</button>' +
				'</div>' +
			'</div>' +
			'<div class="form-check mb-1"><input class="form-check-input" type="checkbox" id="intensityAdvanced" />' +
			'<label class="form-check-label" for="intensityAdvanced">Advanced — show CCFv3 raw depths</label></div>' +
			'<div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="intensityIncludeLayers" ' +
			(state.intensity.includeLayers ? "checked" : "") +
			'/><label class="form-check-label" for="intensityIncludeLayers">Include cortical layers</label></div>' +
			'<div class="region-dual-list mb-2">' +
				'<div><div class="small fw-bold mb-1">Available regions</div>' +
				'<div id="intensityAvailable" class="region-list-panel"></div></div>' +
				'<div class="d-flex flex-column justify-content-center gap-2">' +
				'<button type="button" class="btn btn-sm btn-primary" id="intensityAdd">Add →</button>' +
				'<button type="button" class="btn btn-sm btn-outline-secondary" id="intensityRemove">← Remove</button>' +
				'</div>' +
				'<div><div class="small fw-bold mb-1">Selected for output</div>' +
				'<div id="intensitySelected" class="region-list-panel"></div></div>' +
			'</div>' +
			'<p id="intensityRegionHint" class="small text-muted"></p>';
		setTimeout(initIntensityPicker, 0);
		return;
	}
	if (stepId === "collate") {
		var projOpts = listProjects()
			.map(function (p, idx) {
				return (
					'<option value="' +
					escapeHtml(p.path) +
					'"' +
					(idx === 0 && !state.collate.outputProjectPath ? " selected" : "") +
					(state.collate.outputProjectPath === p.path ? " selected" : "") +
					">" +
					escapeHtml(p.name) +
					"</option>"
				);
			})
			.join("");
		body.innerHTML =
			fieldRow(
				"Output location (one of the selected projects)",
				'<select class="form-select form-select-sm" id="collate-output">' +
					projOpts +
					"</select>",
				"Collate writes the combined report under that project's <code>quantification/collate/&lt;name&gt;/</code> leaf.",
			) +
			fieldRow(
				"Collate name (slug)",
				'<input type="text" class="form-control form-control-sm" id="collate-name" value="' +
					escapeHtml(state.collate.name || "collated") +
					'" />',
			) +
			fieldRow(
				"Regions filter (CSV acronyms, optional)",
				'<input type="text" class="form-control form-control-sm" id="collate-regions" value="' +
					escapeHtml(state.collate.regions || "") +
					'" placeholder="VISp,VISa,…" />',
			);
		return;
	}
	body.innerHTML =
		'<p class="small text-muted mb-0">No parameters for this tool.</p>';
}

function renderParams() {
	var holder = qs("paramSections");
	if (!holder) return;
	holder.innerHTML = "";
	var steps = listSelectedSteps();
	if (!steps.length) {
		holder.innerHTML =
			'<p class="text-muted small mb-0">Select one or more tools above.</p>';
		return;
	}
	for (var i = 0; i < steps.length; i++) {
		var stepId = steps[i];
		var meta = registry.getStepMeta(stepId);
		if (!meta) continue;
		var params =
			state.params[stepId] ||
			Object.assign({}, registry.DEFAULT_PARAMS[stepId] || {});
		state.params[stepId] = params;
		var item = document.createElement("div");
		item.className = "accordion-item";
		item.innerHTML =
			'<h2 class="accordion-header">' +
			'<button class="accordion-button' +
			(i > 0 ? " collapsed" : "") +
			'" type="button" data-bs-toggle="collapse" data-bs-target="#collapse-' +
			stepId +
			'">' +
			escapeHtml(meta.label) +
			"</button></h2>" +
			'<div id="collapse-' +
			stepId +
			'" class="accordion-collapse collapse' +
			(i === 0 ? " show" : "") +
			'"><div class="accordion-body" id="body-' +
			stepId +
			'"></div></div>';
		holder.appendChild(item);
		var body = qs("body-" + stepId);
		if (body) {
			renderParamSection(stepId, body, params);
		}
	}
}

// ---------------------------------------------------------------- intensity picker ----

function initIntensityPicker() {
	if (!state.catalog) {
		try {
			state.catalog = structureCatalog.loadCatalog(getAppRoot());
		} catch (err) {
			console.warn("loadCatalog failed", err);
			return;
		}
	}
	var tierSel = qs("intensityTierSelect");
	var levelSel = qs("intensityLevelSelect");
	if (tierSel && !tierSel.dataset.populated) {
		var tiers = structureCatalog.listTiers(state.catalog);
		for (var t = 0; t < tiers.length; t++) {
			var opt = document.createElement("option");
			opt.value = tiers[t].id;
			opt.textContent = tiers[t].label;
			tierSel.appendChild(opt);
		}
		tierSel.value = "areas";
		tierSel.dataset.populated = "1";
		tierSel.addEventListener("change", function () {
			state.availableHighlight = null;
			renderIntensityAvailable();
		});
	}
	if (levelSel && !levelSel.dataset.populated) {
		var infos = structureCatalog.listCcfLevels(state.catalog);
		for (var i = 0; i < infos.length; i++) {
			var lopt = document.createElement("option");
			lopt.value = String(infos[i].level);
			lopt.textContent = structureCatalog.formatCcfLevelLabel(infos[i]);
			levelSel.appendChild(lopt);
		}
		levelSel.value = "6";
		levelSel.dataset.populated = "1";
		levelSel.addEventListener("change", function () {
			state.availableHighlight = null;
			renderIntensityAvailable();
		});
	}
	var search = qs("intensityRegionSearch");
	if (search && !search.dataset.bound) {
		search.dataset.bound = "1";
		search.addEventListener("input", renderIntensityAvailable);
	}
	var add = qs("intensityAdd");
	if (add && !add.dataset.bound) {
		add.dataset.bound = "1";
		add.addEventListener("click", function () {
			if (state.availableHighlight != null) {
				addIntensitySelected(state.availableHighlight);
			}
		});
	}
	var remove = qs("intensityRemove");
	if (remove && !remove.dataset.bound) {
		remove.dataset.bound = "1";
		remove.addEventListener("click", function () {
			if (state.selectedHighlight != null) {
				removeIntensitySelected(state.selectedHighlight);
				state.selectedHighlight = null;
			}
		});
	}
	var preset = qs("intensityPresetVis");
	if (preset && !preset.dataset.bound) {
		preset.dataset.bound = "1";
		preset.addEventListener("click", function () {
			state.intensity.selectedIds = structureCatalog
				.presetVisRspIds(state.catalog)
				.slice();
			renderIntensityAvailable();
			renderIntensitySelected();
			saveCurrentPlan();
		});
	}
	var adv = qs("intensityAdvanced");
	if (adv && !adv.dataset.bound) {
		adv.dataset.bound = "1";
		adv.addEventListener("change", function () {
			state.pickerMode = adv.checked ? "advanced" : "tiers";
			applyPickerMode();
		});
	}
	var includeLayers = qs("intensityIncludeLayers");
	if (includeLayers && !includeLayers.dataset.bound) {
		includeLayers.dataset.bound = "1";
		includeLayers.addEventListener("change", function () {
			state.intensity.includeLayers = !!includeLayers.checked;
			saveCurrentPlan();
		});
	}
	try {
		var stored = sessionStorage.getItem(PICKER_MODE_KEY);
		state.pickerMode = stored === "advanced" ? "advanced" : "tiers";
	} catch (_e) {
		state.pickerMode = "tiers";
	}
	if (adv) adv.checked = state.pickerMode === "advanced";
	applyPickerMode();
}

function applyPickerMode() {
	var tierSel = qs("intensityTierSelect");
	var levelSel = qs("intensityLevelSelect");
	if (tierSel) {
		tierSel.classList.toggle("d-none", state.pickerMode === "advanced");
	}
	if (levelSel) {
		levelSel.classList.toggle("d-none", state.pickerMode !== "advanced");
	}
	try {
		sessionStorage.setItem(PICKER_MODE_KEY, state.pickerMode);
	} catch (_e) {
		// ignore
	}
	state.availableHighlight = null;
	renderIntensityAvailable();
	renderIntensitySelected();
}

function currentIntensityRegions(search) {
	if (!state.catalog) return [];
	if (state.pickerMode === "advanced") {
		var levelEl = qs("intensityLevelSelect");
		var level = levelEl ? Number(levelEl.value) : 6;
		return structureCatalog.listRegionsAtLevel(level, search, state.catalog);
	}
	var tierEl = qs("intensityTierSelect");
	var tierId = tierEl ? tierEl.value : "areas";
	return structureCatalog.listRegionsForTier(tierId, search, state.catalog);
}

function renderRegionRow(box, node, isSelected, onClick, onDouble) {
	var rowStyle = atlasStyle.rowStyleForRegion(node, state.catalog.byId);
	var row = document.createElement("div");
	row.className = atlasStyle.rowClasses();
	if (isSelected) row.classList.add("selected-row");
	row.style.borderLeftColor = rowStyle.borderLeftColor;
	row.style.backgroundColor = rowStyle.backgroundColor;
	var sw = document.createElement("span");
	sw.className = "region-swatch";
	sw.style.backgroundColor = rowStyle.swatchColor;
	row.appendChild(sw);
	row.appendChild(
		document.createTextNode(node.acronym + " — " + node.name),
	);
	row.addEventListener("click", onClick);
	if (onDouble) row.addEventListener("dblclick", onDouble);
	box.appendChild(row);
}

function renderIntensityAvailable() {
	var box = qs("intensityAvailable");
	if (!box) return;
	box.innerHTML = "";
	var search = qs("intensityRegionSearch");
	var rows = currentIntensityRegions(search ? search.value : "");
	var selectedSet = {};
	for (var s = 0; s < state.intensity.selectedIds.length; s++) {
		selectedSet[state.intensity.selectedIds[s]] = true;
	}
	for (var i = 0; i < rows.length; i++) {
		(function (node) {
			if (selectedSet[node.id]) return;
			renderRegionRow(
				box,
				node,
				state.availableHighlight === node.id,
				function () {
					state.availableHighlight = node.id;
					state.selectedHighlight = null;
					renderIntensityAvailable();
					renderIntensitySelected();
				},
				function () {
					addIntensitySelected(node.id);
				},
			);
		})(rows[i]);
	}
	updateIntensityHint();
}

function renderIntensitySelected() {
	var box = qs("intensitySelected");
	if (!box) return;
	box.innerHTML = "";
	for (var i = 0; i < state.intensity.selectedIds.length; i++) {
		(function (id) {
			var node = state.catalog && state.catalog.byId[id];
			if (!node) return;
			renderRegionRow(
				box,
				node,
				state.selectedHighlight === id,
				function () {
					state.selectedHighlight = id;
					state.availableHighlight = null;
					renderIntensityAvailable();
					renderIntensitySelected();
				},
			);
		})(state.intensity.selectedIds[i]);
	}
	updateIntensityHint();
}

function addIntensitySelected(id) {
	if (state.intensity.selectedIds.indexOf(id) >= 0) return;
	state.intensity.selectedIds.push(id);
	renderIntensityAvailable();
	renderIntensitySelected();
	saveCurrentPlan();
}

function removeIntensitySelected(id) {
	state.intensity.selectedIds = state.intensity.selectedIds.filter(function (x) {
		return x !== id;
	});
	renderIntensityAvailable();
	renderIntensitySelected();
	saveCurrentPlan();
}

function updateIntensityHint() {
	var hint = qs("intensityRegionHint");
	if (hint) {
		hint.textContent =
			state.intensity.selectedIds.length + " region(s) selected.";
	}
}

// ---------------------------------------------------------------- collect params ----

function collectParamsFromUi() {
	var out = {};
	var steps = listSelectedSteps();
	for (var i = 0; i < steps.length; i++) {
		var stepId = steps[i];
		var prev = state.params[stepId] || {};
		var next = Object.assign({}, prev);
		if (stepId === "max") {
			next.dendrites = !!(qs("max-dendrites") && qs("max-dendrites").checked);
			next.cells = !!(qs("max-cells") && qs("max-cells").checked);
		} else if (stepId === "sharpen") {
			next.radius = parseFloat(qs("sharpen-radius").value);
			next.amount = parseFloat(qs("sharpen-amount").value);
			next.equalize = !!(qs("sharpen-equalize") && qs("sharpen-equalize").checked);
		} else if (stepId === "detect") {
			next.confidence = parseFloat(qs("detect-confidence").value);
			next.tile = parseInt(qs("detect-tile").value, 10);
			next.method = qs("detect-method").value;
			next.area = parseInt(qs("detect-area").value, 10);
			next.eccentricity = parseFloat(qs("detect-eccentricity").value);
			next.multichannel = !!(
				qs("detect-multichannel") && qs("detect-multichannel").checked
			);
			next.customModel = qs("detect-customModel").value || "";
		} else if (stepId === "count") {
			next.layerinfo = !!(qs("count-layerinfo") && qs("count-layerinfo").checked);
		} else if (stepId === "intensity") {
			var hem = qs("intensity-hemisphere") ? qs("intensity-hemisphere").value : "whole";
			next.wholeSlice = hem === "whole";
			next.useDapi = !!(qs("intensity-useDapi") && qs("intensity-useDapi").checked);
			next.selectedRegionIds = state.intensity.selectedIds.slice();
			next.includeLayers = state.intensity.includeLayers;
		} else if (stepId === "dapi_cleanup") {
			next.inPlace = qs("dapi-inplace") ? qs("dapi-inplace").value === "true" : true;
			next.isolate = !!(qs("dapi-isolate") && qs("dapi-isolate").checked);
			next.clahe = !!(qs("dapi-clahe") && qs("dapi-clahe").checked);
			next.saturation = parseFloat(qs("dapi-saturation").value);
			next.bgValue = qs("dapi-bgvalue") ? qs("dapi-bgvalue").value : "";
		} else if (stepId === "collate") {
			next = next; // params not used directly by per-project queue
			state.collate.outputProjectPath = qs("collate-output")
				? qs("collate-output").value
				: state.collate.outputProjectPath;
			state.collate.name = qs("collate-name")
				? qs("collate-name").value || "collated"
				: state.collate.name;
			state.collate.regions = qs("collate-regions")
				? qs("collate-regions").value
				: state.collate.regions;
		}
		out[stepId] = next;
	}
	return out;
}

function saveCurrentPlan() {
	state.params = collectParamsFromUi();
	var plan = buildPlan();
	registry.saveBatchPlan(plan);
}

function buildPlan() {
	var steps = listSelectedSteps();
	var projects = listProjects();
	var plan = {
		projects: projects,
		steps: steps,
		params: state.params,
	};
	if (steps.indexOf("intensity") >= 0) {
		plan.intensity = {
			selected_region_ids: state.intensity.selectedIds.slice(),
			include_layers: state.intensity.includeLayers,
		};
	}
	if (steps.indexOf("collate") >= 0) {
		plan.collate = {
			outputProjectPath: state.collate.outputProjectPath || (projects[0] && projects[0].path) || "",
			name: state.collate.name || "collated",
			regions: state.collate.regions || "",
		};
	}
	return plan;
}

// ---------------------------------------------------------------- preflight ----

function classifyPreflightCell(bundleRoot, stepId) {
	var meta = registry.getStepMeta(stepId);
	if (!meta) return { tone: "red", label: "?", reason: "Unknown step" };
	if (meta.bundleWide) {
		var projData;
		try {
			projData = project.readProjectJson(bundleRoot);
		} catch (_e) {
			return { tone: "red", label: "no project", reason: "Bundle missing project file." };
		}
		var settings = (projData && projData.settings) || {};
		var cziImport = settings.czi_import || {};
		var geom = cziImport.geometry || {};
		var ids = Object.keys(geom);
		var anyPending = false;
		for (var i = 0; i < ids.length; i++) {
			var g = geom[ids[i]];
			if (!g) continue;
			var rot = Number(g.rotate || 0) % 360;
			if (rot !== 0 || g.flip_x || g.flip_y) {
				anyPending = true;
				break;
			}
		}
		return anyPending
			? { tone: "green", label: "ready", reason: ids.length + " slice(s) with pending geometry" }
			: { tone: "amber", label: "no-op", reason: "No pending geometry — will skip." };
	}
	if (stepId === "dapi_cleanup") {
		var paths = project.resolvePathsForBundle(bundleRoot, "max");
		// Inspect dapi role directly
		var projData2;
		try {
			projData2 = project.readProjectJson(bundleRoot);
		} catch (_e) {
			return { tone: "red", label: "no project", reason: "Bundle missing project file." };
		}
		var roles = (projData2 && projData2.roles) || project.CANONICAL_ROLES;
		var dapiAbs = pipelineRuns.resolveRoleBaseAbsForBundle(bundleRoot, roles, "dapi");
		if (!dapiAbs || !fs.existsSync(dapiAbs)) {
			return { tone: "amber", label: "no DAPI", reason: "00_dapi missing — step will skip." };
		}
		var count = 0;
		try {
			var entries = fs.readdirSync(dapiAbs);
			for (var e = 0; e < entries.length; e++) {
				if (/\.(png|tif|tiff)$/i.test(entries[e])) count++;
			}
		} catch (_e2) {
			/* ignore */
		}
		return count > 0
			? { tone: "green", label: count + " img", reason: count + " DAPI image(s) in 00_dapi" }
			: { tone: "amber", label: "no DAPI", reason: "00_dapi empty — step will skip." };
	}
	if (stepId === "collate") {
		var allProjects = listProjects();
		var counted = 0;
		for (var p = 0; p < allProjects.length; p++) {
			var pp = allProjects[p];
			var paths2 = project.resolvePathsForBundle(pp.path, "collate");
			if (paths2.indir && fs.existsSync(paths2.indir)) counted++;
		}
		return counted >= 2
			? { tone: "green", label: counted + " ok", reason: counted + " counted project(s)" }
			: { tone: "amber", label: "needs 2+", reason: "Needs ≥2 counted projects (current: " + counted + ")." };
	}
	var paths3 = project.resolvePathsForBundle(bundleRoot, stepId);
	if (!paths3 || !Object.keys(paths3).length) {
		return { tone: "red", label: "?", reason: "Step paths unresolved" };
	}
	var missing = [];
	var keys = Object.keys(paths3);
	for (var k = 0; k < keys.length; k++) {
		var key = keys[k];
		if (key === "outdir") continue;
		if (key === "dapi") continue;
		var dirPath = paths3[key];
		if (!dirPath || !fs.existsSync(dirPath)) {
			missing.push(key);
		}
	}
	if (meta.requiresAnnotations) {
		var anno = paths3.annodir;
		if (!anno || !project.countAnnotationPkls(anno)) {
			missing.push("annotation_pkls");
		}
	}
	if (!missing.length) {
		return { tone: "green", label: "ready", reason: "All inputs present." };
	}
	if (missing.length === 1 && missing[0] === "annotation_pkls") {
		return { tone: "red", label: "no anno", reason: "Missing annotation PKLs in slices/." };
	}
	return { tone: "red", label: "missing", reason: "Missing: " + missing.join(", ") };
}

function renderPreflightMatrix() {
	var holder = qs("preflightMatrix");
	if (!holder) return;
	var projects = listProjects();
	var steps = listSelectedSteps();
	if (!projects.length || !steps.length) {
		holder.innerHTML =
			'<p class="text-muted small mb-0">Add projects and tools to see the preflight matrix.</p>';
		updateStartButton();
		return;
	}
	var html = '<table class="table table-sm table-bordered batch-matrix-table mb-0"><thead><tr><th class="proj-col">Project</th>';
	for (var s = 0; s < steps.length; s++) {
		html += "<th>" + escapeHtml(registry.getStepLabel(steps[s])) + "</th>";
	}
	html += "</tr></thead><tbody>";
	var anyRed = false;
	for (var p = 0; p < projects.length; p++) {
		var proj = projects[p];
		html += '<tr><td class="proj-col"><strong>' + escapeHtml(proj.name) + "</strong></td>";
		for (var t = 0; t < steps.length; t++) {
			var info = classifyPreflightCell(proj.path, steps[t]);
			if (info.tone === "red") anyRed = true;
			html +=
				'<td><span class="matrix-cell cell-' +
				info.tone +
				'" title="' +
				escapeHtml(info.reason) +
				'">' +
				escapeHtml(info.label) +
				"</span></td>";
		}
		html += "</tr>";
	}
	html += "</tbody></table>";
	holder.innerHTML = html;
	updateStartButton(anyRed);
}

function updateStartButton(anyRed) {
	var btn = qs("startBatch");
	if (!btn) return;
	var hasP = listProjects().length > 0;
	var hasS = listSelectedSteps().length > 0;
	var hasRed = !!anyRed;
	var intensityOk =
		!state.selectedSteps.intensity || state.intensity.selectedIds.length > 0;
	var collateOk =
		!state.selectedSteps.collate || listProjects().length >= 2;
	btn.disabled = !(hasP && hasS && !hasRed && intensityOk && collateOk);
}

// ---------------------------------------------------------------- start batch ----

function startBatch() {
	state.params = collectParamsFromUi();
	var plan = buildPlan();
	var errors = registry.validateBatchPlan(plan);
	if (errors.length) {
		alert(errors.join("\n"));
		return;
	}
	registry.saveBatchPlan(plan);
	if (qs("saveDefaults") && qs("saveDefaults").checked) {
		registry.saveBatchDefaults(state.params);
	}
	state.running = true;
	state.matrixCells = {};
	state.failedTails = {};
	state.summary = null;
	state.elapsedStart = Date.now();
	setStep(2);
	prepareRunMatrix(plan);
	qs("batchLog").textContent = "";
	startElapsedClock();
	ipc.send("runBatch", plan);
}

function startElapsedClock() {
	if (state.elapsedTimer) clearInterval(state.elapsedTimer);
	state.elapsedTimer = setInterval(function () {
		if (qs("elapsedClock") && state.elapsedStart) {
			qs("elapsedClock").textContent = formatElapsed(
				Date.now() - state.elapsedStart,
			);
		}
	}, 1000);
}

function stopElapsedClock() {
	if (state.elapsedTimer) {
		clearInterval(state.elapsedTimer);
		state.elapsedTimer = null;
	}
}

function formatElapsed(ms) {
	var s = Math.floor(ms / 1000);
	var h = Math.floor(s / 3600);
	var m = Math.floor((s % 3600) / 60);
	var sec = s % 60;
	return (
		h +
		":" +
		String(m).padStart(2, "0") +
		":" +
		String(sec).padStart(2, "0")
	);
}

function prepareRunMatrix(plan) {
	state.matrixCells = {};
	var holder = qs("runMatrix");
	if (!holder) return;
	var projects = plan.projects || [];
	var steps = plan.steps || [];
	var perProjectSteps = steps.filter(function (s) {
		return s !== "collate";
	});
	var hasCollate = steps.indexOf("collate") >= 0;
	var html =
		'<table class="table table-sm table-bordered batch-matrix-table mb-2"><thead><tr><th class="proj-col">Project</th>';
	for (var s = 0; s < perProjectSteps.length; s++) {
		html += "<th>" + escapeHtml(registry.getStepLabel(perProjectSteps[s])) + "</th>";
	}
	html += "</tr></thead><tbody>";
	for (var p = 0; p < projects.length; p++) {
		var proj = projects[p];
		html += '<tr><td class="proj-col">' + escapeHtml(proj.name) + "</td>";
		for (var t = 0; t < perProjectSteps.length; t++) {
			html +=
				'<td><span class="matrix-cell cell-pending" data-key="' +
				escapeHtml(proj.path + "::" + perProjectSteps[t]) +
				'">pending</span></td>';
		}
		html += "</tr>";
	}
	if (hasCollate) {
		var colspan = perProjectSteps.length || 1;
		html +=
			'<tr><td class="proj-col"><em>Collate (whole batch)</em></td><td colspan="' +
			colspan +
			'"><span class="matrix-cell cell-pending" data-key="__collate__::collate">pending</span></td></tr>';
	}
	html += "</tbody></table>";
	holder.innerHTML = html;
	var cells = holder.querySelectorAll("[data-key]");
	for (var c = 0; c < cells.length; c++) {
		var key = cells[c].getAttribute("data-key");
		state.matrixCells[key] = cells[c];
		cells[c].addEventListener("click", function (cell) {
			return function () {
				var k = cell.getAttribute("data-key");
				var tail = state.failedTails[k];
				if (tail && tail.length) {
					alert(tail.slice(-50).join("\n"));
				}
			};
		}(cells[c]));
	}
}

function updateMatrixCell(projectPath, stepId, status, elapsedMs, reason) {
	var key = projectPath + "::" + stepId;
	var cell = state.matrixCells[key];
	if (!cell) return;
	cell.className = "matrix-cell cell-" + status;
	var label = status;
	if (status === "ok") label = "done";
	if (status === "failed") label = "failed";
	if (status === "skipped") label = "skipped";
	if (status === "cancelled") label = "cancelled";
	if (status === "running") label = "running…";
	var elapsedHtml = "";
	if (elapsedMs != null && elapsedMs > 0) {
		elapsedHtml =
			'<span class="cell-elapsed">' + Math.round(elapsedMs / 1000) + "s</span>";
	}
	cell.innerHTML = escapeHtml(label) + elapsedHtml;
	if (reason) {
		cell.setAttribute("title", reason);
	}
}

// ---------------------------------------------------------------- IPC ----

ipc.on("batchJobStart", function (_event, info) {
	if (info.step === "collate") {
		var k = "__collate__::collate";
		if (state.matrixCells[k]) {
			updateMatrixCell("__collate__", "collate", "running");
		}
	} else if (info.project && info.step) {
		// We use the project DISPLAY NAME from registry; but matrix cells are keyed by path.
		// Look up path by name (or just iterate cells).
		var matched = false;
		Object.keys(state.matrixCells).forEach(function (k) {
			if (k.indexOf("::" + info.step) > 0 && state.matrixCells[k]._projName == null) {
				// no-op; we key by path
			}
		});
		// Find the project by name
		var projects = listProjects();
		for (var i = 0; i < projects.length; i++) {
			if (projects[i].name === info.project) {
				updateMatrixCell(projects[i].path, info.step, "running");
				matched = true;
				break;
			}
		}
	}
	if (qs("currentProject")) qs("currentProject").textContent = info.project || "—";
	if (qs("currentStep")) qs("currentStep").textContent = registry.getStepLabel(info.step || "");
});

ipc.on("batchProgress", function (_event, data) {
	var pct = data[0];
	var msg = data[1] || "";
	var detail = data[2] || "";
	if (qs("loadbar")) {
		qs("loadbar").style.width = String(pct) + "%";
		qs("loadbar").setAttribute("aria-valuenow", String(pct));
	}
	if (qs("loadmessage")) {
		qs("loadmessage").textContent = msg + (detail ? " — " + detail : "");
	}
});

function appendBatchLog(line) {
	var pre = qs("batchLog");
	if (!pre) return;
	var text = pre.textContent + line + "\n";
	var lines = text.split("\n");
	if (lines.length > LOG_MAX) {
		text = lines.slice(lines.length - LOG_MAX).join("\n");
	}
	pre.textContent = text;
	pre.scrollTop = pre.scrollHeight;
}

ipc.on("batchJobLog", function (_event, data) {
	if (!Array.isArray(data) || data.length < 3) return;
	var proj = data[0];
	var step = data[1];
	var line = String(data[2] || "");
	appendBatchLog("[" + (proj || "?") + " / " + (step || "?") + "] " + line);
});

ipc.on("batchJobEnd", function (_event, result) {
	if (!result || !result.step) return;
	var key;
	if (result.step === "collate") {
		key = "__collate__::collate";
		updateMatrixCell(
			"__collate__",
			"collate",
			result.status,
			result.elapsedMs,
			result.reason,
		);
	} else {
		// Find path by displayed project name
		var projects = listProjects();
		for (var i = 0; i < projects.length; i++) {
			if (projects[i].name === result.project) {
				key = projects[i].path + "::" + result.step;
				updateMatrixCell(
					projects[i].path,
					result.step,
					result.status,
					result.elapsedMs,
					result.reason,
				);
				break;
			}
		}
	}
	if (key && Array.isArray(result.tail)) {
		state.failedTails[key] = result.tail.slice();
	}
	if (result.status === "failed" || result.status === "skipped") {
		appendBatchLog(
			"[" +
				(result.project || "?") +
				" / " +
				(result.step || "?") +
				"] STATUS=" +
				result.status +
				(result.reason ? " — " + result.reason : ""),
		);
	}
});

ipc.on("batchComplete", function (_event, result) {
	state.running = false;
	stopElapsedClock();
	state.summary = result || null;
	if (qs("loadbar")) {
		qs("loadbar").style.width = "100%";
	}
	renderSummary(result);
	setStep(3);
});

function renderSummary(result) {
	if (!result || !result.summary) {
		if (qs("summaryAlert"))
			qs("summaryAlert").textContent = "Batch finished, but no summary was reported.";
		return;
	}
	var summary = result.summary;
	var byStatus = summary.byStatus || {};
	var ok = byStatus.ok || 0;
	var failed = byStatus.failed || 0;
	var skipped = byStatus.skipped || 0;
	var cancelled = byStatus.cancelled || 0;
	var alert = qs("summaryAlert");
	if (alert) {
		var tone = "success";
		if (failed) tone = "danger";
		else if (cancelled) tone = "warning";
		else if (skipped) tone = "warning";
		alert.className = "alert alert-" + tone + " text-start";
		alert.innerHTML =
			"<strong>Batch complete.</strong> " +
			ok +
			" succeeded · " +
			failed +
			" failed · " +
			skipped +
			" skipped" +
			(cancelled ? " · " + cancelled + " cancelled" : "");
	}
	if (qs("totalElapsed")) {
		qs("totalElapsed").textContent = formatElapsed(summary.totalElapsedMs || 0);
	}
	renderSummaryMatrix(result);
	renderActiveRunsSnapshot();
}

function renderSummaryMatrix(result) {
	var holder = qs("batchSummaryTable");
	if (!holder) return;
	var projects = listProjects();
	var plan = registry.loadBatchPlan() || {};
	var steps = (plan.steps || []).filter(function (s) {
		return s !== "collate";
	});
	var hasCollate = (plan.steps || []).indexOf("collate") >= 0;
	var html =
		'<table class="table table-sm table-bordered batch-matrix-table"><thead><tr><th class="proj-col">Project</th>';
	for (var s = 0; s < steps.length; s++) {
		html += "<th>" + escapeHtml(registry.getStepLabel(steps[s])) + "</th>";
	}
	html += "</tr></thead><tbody>";
	for (var p = 0; p < projects.length; p++) {
		var proj = projects[p];
		html += '<tr><td class="proj-col">' + escapeHtml(proj.name) + "</td>";
		var byProj =
			(result.summary && result.summary.byProject && result.summary.byProject[proj.path]) ||
			{};
		for (var t = 0; t < steps.length; t++) {
			var job = byProj[steps[t]];
			if (!job) {
				html += '<td><span class="matrix-cell cell-skipped">—</span></td>';
				continue;
			}
			var label = job.status;
			if (label === "ok") label = "done";
			var title =
				(job.reason || "") +
				(job.outputAbs ? "\nout: " + job.outputAbs : "");
			html +=
				'<td><span class="matrix-cell cell-' +
				job.status +
				'" data-summary-key="' +
				escapeHtml(proj.path + "::" + steps[t]) +
				'" title="' +
				escapeHtml(title) +
				'">' +
				escapeHtml(label) +
				'<span class="cell-elapsed">' +
				Math.round((job.elapsedMs || 0) / 1000) +
				"s</span></span></td>";
		}
		html += "</tr>";
	}
	if (hasCollate && result.summary.collate) {
		var j = result.summary.collate;
		html +=
			'<tr><td class="proj-col"><em>Collate (whole batch)</em></td>' +
			'<td colspan="' +
			(steps.length || 1) +
			'"><span class="matrix-cell cell-' +
			j.status +
			'" title="' +
			escapeHtml((j.reason || "") + (j.outputAbs ? "\nout: " + j.outputAbs : "")) +
			'">' +
			escapeHtml(j.status === "ok" ? "done" : j.status) +
			"</span></td></tr>";
	}
	html += "</tbody></table>";
	holder.innerHTML = html;
	var cells = holder.querySelectorAll("[data-summary-key]");
	for (var c = 0; c < cells.length; c++) {
		cells[c].addEventListener("click", function (cell) {
			return function () {
				var k = cell.getAttribute("data-summary-key");
				var summaryObj = state.summary && state.summary.summary;
				if (!summaryObj) return;
				var parts = k.split("::");
				var projPath = parts[0];
				var stepId = parts[1];
				var job =
					summaryObj.byProject &&
					summaryObj.byProject[projPath] &&
					summaryObj.byProject[projPath][stepId];
				if (!job) return;
				if (job.tail && job.tail.length) {
					alert(job.tail.slice(-50).join("\n"));
				} else if (job.reason) {
					alert(job.reason);
				}
			};
		}(cells[c]));
	}
}

function renderActiveRunsSnapshot() {
	var holder = qs("activeRunsBlock");
	if (!holder) return;
	var projects = listProjects();
	var lines = [];
	for (var p = 0; p < projects.length; p++) {
		var proj = projects[p];
		var data;
		try {
			data = project.readProjectJson(proj.path);
		} catch (_e) {
			lines.push(escapeHtml(proj.name) + ": (project file unreadable)");
			continue;
		}
		var active = (data && data.processing && data.processing.active_runs) || {};
		var keys = Object.keys(active).filter(function (k) {
			return active[k];
		});
		if (!keys.length) {
			lines.push("<strong>" + escapeHtml(proj.name) + "</strong>: <em>no active runs</em>");
			continue;
		}
		var detail = keys.map(function (k) {
			return escapeHtml(k) + " → <code>" + escapeHtml(active[k]) + "</code>";
		}).join("; ");
		lines.push("<strong>" + escapeHtml(proj.name) + "</strong>: " + detail);
	}
	holder.innerHTML = lines.length
		? "<ul class=\"list-unstyled mb-0\"><li>" + lines.join("</li><li>") + "</li></ul>"
		: "<em>no projects</em>";
}

// ---------------------------------------------------------------- wire UI ----

function seedFromRecent() {
	var recent = project.getRecentProjects();
	for (var i = 0; i < recent.length; i++) {
		if (project.isBundleRoot(recent[i].path) && !state.projects[recent[i].path]) {
			state.projects[recent[i].path] = {
				path: recent[i].path,
				name: recent[i].name,
			};
		}
	}
}

function addProjectPath(bundleRoot) {
	if (!bundleRoot || !project.isBundleRoot(bundleRoot)) {
		alert(
			"Not a valid project bundle (missing a .masonjar project file or legacy project.belljar).",
		);
		return;
	}
	var data;
	try {
		data = project.readProjectJson(bundleRoot);
	} catch (err) {
		alert(String(err.message || err));
		return;
	}
	state.projects[bundleRoot] = {
		path: bundleRoot,
		name: data.name || path.basename(bundleRoot),
	};
	renderProjects();
	saveCurrentPlan();
}

if (qs("addProject")) {
	qs("addProject").addEventListener("click", function () {
		dialogs.pickDirectory({ tag: "projectBundle" }).then(function (selected) {
			if (selected) addProjectPath(selected);
		});
	});
}

if (qs("scanFolder")) {
	qs("scanFolder").addEventListener("click", function () {
		ipc.once("returnPath", function (_e, response) {
			var tag = response[1];
			if (typeof tag === "object" && tag !== null && tag.tag) {
				tag = tag.tag;
			}
			if (tag !== "dir" && tag !== "input") return;
			var folder = response[0];
			if (!folder) return;
			var bundles = project.listBundlesInDirectory(folder);
			if (!bundles.length) {
				alert("No .masonjar / .belljar bundles found.");
				return;
			}
			for (var i = 0; i < bundles.length; i++) {
				addProjectPath(bundles[i]);
			}
		});
		ipc.send("openDialog", "input");
	});
}

if (qs("clearProjects")) {
	qs("clearProjects").addEventListener("click", function () {
		state.projects = {};
		renderProjects();
		saveCurrentPlan();
	});
}

if (qs("startBatch")) {
	qs("startBatch").addEventListener("click", startBatch);
}

if (qs("cancelBatch")) {
	qs("cancelBatch").addEventListener("click", function () {
		ipc.send("killBatch", []);
		appendBatchLog("Cancel requested…");
	});
}

if (qs("openLogBtn")) {
	qs("openLogBtn").addEventListener("click", function () {
		ipc.send("showLogWindow");
	});
}

if (qs("rerunBtn")) {
	qs("rerunBtn").addEventListener("click", function () {
		setStep(1);
	});
}

// ---------------------------------------------------------------- bootstrap ----

loadPlanFromSession();
seedFromRecent();
renderProjects();
renderSteps();
renderParams();
renderPreflightMatrix();
