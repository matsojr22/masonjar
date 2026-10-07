"use strict";

var fs = require("fs");
var path = require("path");
var ipc = require("electron").ipcRenderer;
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var pipelineRuns = require("./pipeline_runs");
var maxDatasets = require("./max_datasets");
var detectCommon = require("./detect_common");
var detectParams = require("./detect_params");
var preprocess = require("./preprocess_wizard");
var projectIndexBusy = require("./project_index_busy");

var LOG_MAX = 1500;
var previewToken = 0;

var state = {
	step: 1,
	branches: [],
	datasets: [],
	slices: [],
	boxes: [],
	cacheAbs: "",
	fullW: 0,
	fullH: 0,
	baseW: 0,
	baseH: 0,
	viewW: 640,
	viewH: 480,
	scale: 1,
	panX: 0,
	panY: 0,
	rawRunning: false,
	scoutRunning: false,
	fullRunning: false,
	showingFullRes: false,
	displayPending: "",
	displayScale: 1,
	sourceImageAbs: "",
	triedFitDisplay: false,
	outputAbs: "",
	runRel: "",
};

function qs(id) {
	return document.getElementById(id);
}

function projectName() {
	var proj = project.getProject();
	return (proj && proj.name) || "Project";
}

function currentStore() {
	return detectParams.readStore(project.isActive() ? project.getProject() : null);
}

function saveStore(store) {
	if (!project.isActive()) {
		return;
	}
	var proj = project.getProject();
	if (!proj.settings) {
		proj.settings = {};
	}
	proj.settings.detection_params = {
		sections: store.sections,
		averages: store.averages,
		suggestions: store.suggestions || {},
	};
	project.saveProjectJson();
}

function detectionMethod() {
	var sel = qs("methodSelect");
	return sel ? sel.value : "somata";
}

function customModelValue() {
	var input = qs("customModel");
	return input ? String(input.value || "").trim() : "";
}

function tileValue() {
	var input = qs("tileSize");
	var n = input ? Number(input.value) : detectParams.DEFAULT_TILE;
	if (!isFinite(n) || n <= 0) {
		return detectParams.DEFAULT_TILE;
	}
	return Math.round(n);
}

function sliderParams() {
	return {
		confidence: Number(qs("confidenceSlider").value),
		area: Number(qs("areaSlider").value),
		eccentricity: Number(qs("eccentricitySlider").value),
		intensity_min: Number(qs("intensitySlider").value),
	};
}

function selectedDataset() {
	var sel = qs("sourceDatasetSelect");
	if (!sel || !state.datasets.length) {
		return null;
	}
	var idx = Number(sel.value);
	return state.datasets[idx] || state.datasets[0];
}

function selectedSlice() {
	var sel = qs("sliceSelect");
	if (!sel || !state.slices.length) {
		return null;
	}
	var idx = Number(sel.value);
	return state.slices[idx] || state.slices[0];
}

function selectedBranch() {
	var sel = qs("signalBranchSelect");
	return sel ? sel.value : "";
}

function sliceIdOf(slice) {
	if (!slice) {
		return "";
	}
	return detectCommon.sliceStemFromImageBasename(slice.name);
}

function setStep(n) {
	state.step = n;
	var step1 = qs("step1");
	var step2 = qs("step2");
	var step3 = qs("step3");
	if (step1) {
		step1.classList.toggle("d-none", n !== 1);
	}
	if (step2) {
		step2.classList.toggle("d-none", n !== 2);
	}
	if (step3) {
		step3.classList.toggle("d-none", n !== 3);
	}
	var pills = document.querySelectorAll("#wizardSteps [data-step]");
	for (var i = 0; i < pills.length; i++) {
		var pill = pills[i];
		var sn = Number(pill.getAttribute("data-step"));
		pill.classList.remove("active", "disabled");
		if (sn === n) {
			pill.classList.add("active");
		} else if (sn > n) {
			pill.classList.add("disabled");
		}
	}
}

function setRawProgress(pct, text) {
	var n = Math.min(100, Math.max(0, Number(pct) || 0));
	var bar = qs("rawDetectProgress");
	var msg = qs("rawDetectProgressText");
	if (bar) {
		bar.style.width = String(n) + "%";
		bar.setAttribute("aria-valuenow", String(n));
		bar.textContent = n > 0 ? String(n) + "%" : "";
	}
	if (msg && text) {
		msg.textContent = text;
	}
}

function setProcessProgress(pct, text) {
	var n = Math.min(100, Math.max(0, Number(pct) || 0));
	var bar = qs("processProgress");
	var msg = qs("processMessage");
	if (bar) {
		bar.style.width = String(n) + "%";
		bar.setAttribute("aria-valuenow", String(n));
		bar.textContent = n > 0 ? String(n) + "%" : "";
	}
	if (msg && text) {
		msg.textContent = text;
		appendLog(text);
	}
}

function appendLog(line) {
	var log = qs("wizardLog");
	if (!log || !line) {
		return;
	}
	log.textContent += line + "\n";
	var parts = log.textContent.split("\n");
	if (parts.length > LOG_MAX) {
		log.textContent = parts.slice(parts.length - LOG_MAX).join("\n");
	}
	log.scrollTop = log.scrollHeight;
}

function setRawChrome(running) {
	state.rawRunning = !!running;
	var back = qs("step1Back");
	var cancel = qs("rawDetectCancel");
	var runBtn = qs("runRawDetection");
	if (back) {
		back.classList.toggle("d-none", !!running);
	}
	if (cancel) {
		cancel.classList.toggle("d-none", !running);
	}
	if (runBtn) {
		runBtn.disabled = !!running;
	}
}

function setScoutChrome(running) {
	state.scoutRunning = !!running;
	var back = qs("step1Back");
	var cancel = qs("rawDetectCancel");
	var runBtn = qs("runRawDetection");
	var suggestBtn = qs("suggestIntensity");
	if (back) {
		back.classList.toggle("d-none", !!running);
	}
	if (cancel) {
		cancel.classList.toggle("d-none", !running);
	}
	if (runBtn) {
		runBtn.disabled = !!running;
	}
	if (suggestBtn) {
		suggestBtn.disabled = !!running;
	}
}

function setFullChrome(running) {
	state.fullRunning = !!running;
	var back = qs("step2Back");
	var cancel = qs("step2Cancel");
	if (back) {
		back.classList.toggle("d-none", !!running);
	}
	if (cancel) {
		cancel.classList.toggle("d-none", !running);
	}
}

function applyTransform() {
	var el = qs("preprocessPreviewTransform");
	if (!el) {
		return;
	}
	el.style.transform =
		"translate(" + state.panX + "px," + state.panY + "px) scale(" + state.scale + ")";
}

function updateSliderLabels() {
	var p = sliderParams();
	var c = qs("confidenceValue");
	var a = qs("areaValue");
	var e = qs("eccentricityValue");
	var i = qs("intensityValue");
	if (c) {
		c.textContent = detectParams.formatParamValue("confidence", p.confidence);
	}
	if (a) {
		a.textContent = detectParams.formatParamValue("area", p.area);
	}
	if (e) {
		e.textContent = detectParams.formatParamValue("eccentricity", p.eccentricity);
	}
	if (i) {
		i.textContent = detectParams.formatParamValue("intensity_min", p.intensity_min);
	}
}

function boxStrokeWidth() {
	var viewScale = state.scale > 0 ? state.scale : 1;
	var imageScale = state.displayScale > 0 ? state.displayScale : 1;
	var stroke = Math.max(1, 2 * imageScale);
	if (viewScale < 1) {
		stroke = Math.max(stroke, 1 / viewScale);
	}
	return stroke;
}

function drawBoxes() {
	updateSliderLabels();
	var img = qs("preprocessPreviewImg");
	var overlay = qs("preprocessPreviewOverlay");
	var countEl = qs("boxCount");
	var kept = state.showingFullRes
		? detectParams.filterBoxes(state.boxes, sliderParams())
		: [];
	if (countEl) {
		if (!state.boxes.length) {
			countEl.textContent = "No raw detections yet.";
		} else if (!state.showingFullRes) {
			countEl.textContent = state.boxes.length + " raw detections. Loading the full-resolution section…";
		} else {
			countEl.textContent = kept.length + " of " + state.boxes.length + " boxes";
		}
	}
	if (!overlay || !img) {
		return;
	}
	var w = img.naturalWidth || state.baseW || 0;
	var h = img.naturalHeight || state.baseH || 0;
	if (!state.showingFullRes || !w || !h || !kept.length) {
		overlay.textContent = "";
		overlay.style.display = "none";
		return;
	}
	overlay.setAttribute("viewBox", "0 0 " + w + " " + h);
	overlay.setAttribute("width", String(w));
	overlay.setAttribute("height", String(h));
	overlay.style.width = w + "px";
	overlay.style.height = h + "px";
	overlay.style.display = "block";
	var stroke = boxStrokeWidth();
	var markup = [];
	for (var i = 0; i < kept.length; i++) {
		var box = kept[i].xyxy || [];
		if (box.length < 4) {
			continue;
		}
		var scale = state.displayScale > 0 ? state.displayScale : 1;
		var x = Number(box[0]) * scale;
		var y = Number(box[1]) * scale;
		var bw = (Number(box[2]) - Number(box[0])) * scale;
		var bh = (Number(box[3]) - Number(box[1])) * scale;
		if (!(bw > 0) || !(bh > 0)) {
			continue;
		}
		markup.push(
			'<rect x="' +
				x +
				'" y="' +
				y +
				'" width="' +
				bw +
				'" height="' +
				bh +
				'" fill="none" stroke="#ff0000" stroke-width="' +
				stroke +
				'"/>',
		);
	}
	overlay.innerHTML = markup.join("");
}

function cachePathFor(sliceId) {
	var root = project.isActive() ? project.getBundleRoot() : "";
	var dataset = selectedDataset();
	var rel = dataset && dataset.rel ? dataset.rel : "dataset";
	var token = detectCommon.modelBranchForSlug(
		detectionMethod() === "nuclei" ? "nuclei" : "somata",
		detectionMethod() === "custom" ? customModelValue() : "",
	);
	var dir = path.join(
		root,
		".masonjar",
		"detect_param_raw",
		pipelineRuns.sanitizeSlugPart(String(rel).replace(/[\\/]/g, "_")) || "dataset",
		token + "_t" + String(tileValue()),
	);
	return path.join(dir, (pipelineRuns.sanitizeSlugPart(sliceId) || "slice") + ".json");
}

function normalizePath(filePath) {
	return path
		.resolve(String(filePath || ""))
		.replace(/^\\\\\?\\/, "")
		.replace(/\\/g, "/")
		.toLowerCase();
}

function cacheIsFresh(data, imageAbs) {
	if (!data || !Array.isArray(data.boxes) || !imageAbs || !fs.existsSync(imageAbs)) {
		return false;
	}
	var st;
	try {
		st = fs.statSync(imageAbs);
	} catch (_err) {
		return false;
	}
	if (Math.abs(Number(data.mtimeS) - Math.floor(st.mtimeMs / 1000)) > 2) {
		return false;
	}
	if (normalizePath(data.image) !== normalizePath(imageAbs)) {
		return false;
	}
	if (String(data.method || "") !== detectionMethod()) {
		return false;
	}
	if (String(data.customModel || "") !== customModelValue()) {
		return false;
	}
	if (Number(data.tile) !== tileValue()) {
		return false;
	}
	return true;
}

function updateAreaSlider() {
	var areaSlider = qs("areaSlider");
	if (!areaSlider) {
		return;
	}
	var maxArea = detectParams.areaSliderMax(state.boxes);
	areaSlider.max = String(maxArea);
	if (Number(areaSlider.value) > maxArea) {
		areaSlider.value = String(maxArea);
	}
}

function existingDisplayPng(cacheAbs, data) {
	var fromData = data && data.displayPath ? String(data.displayPath) : "";
	if (fromData && fs.existsSync(fromData)) {
		return fromData;
	}
	var sibling = String(cacheAbs || "").replace(/\.json$/i, "_display.png");
	if (sibling && fs.existsSync(sibling)) {
		return sibling;
	}
	return "";
}

function showSectionImage(token, absPath, fullRes) {
	var img = qs("preprocessPreviewImg");
	var status = qs("preprocessPreviewStatus");
	state.showingFullRes = !!fullRes;
	if (!img || !absPath) {
		drawBoxes();
		return;
	}
	img.onload = function () {
		if (token !== previewToken) {
			return;
		}
		state.baseW = img.naturalWidth;
		state.baseH = img.naturalHeight;
		if (fullRes) {
			state.fullW = state.baseW;
			state.fullH = state.baseH;
		}
		var viewport = qs("preprocessPreviewViewport");
		var rect = viewport ? viewport.getBoundingClientRect() : null;
		state.viewW = Math.max(280, (rect && rect.width) || 640);
		state.viewH = Math.max(280, (rect && rect.height) || 640);
		preprocess.fitViewportToDimensions(state, state.baseW, state.baseH);
		applyTransform();
		drawBoxes();
		if (status) {
			if (fullRes) {
				status.textContent =
					(state.boxes.length ? state.boxes.length + " detections on the " : "") +
					"selected section (" +
					state.baseW +
					"×" +
					state.baseH +
					"). Drag to pan and scroll to zoom.";
			} else {
				status.textContent =
					"Low-resolution preview for choosing a section. After raw detection this switches to the image you selected.";
			}
		}
	};
	img.onerror = function () {
		if (token !== previewToken) {
			return;
		}
		if (fullRes && !state.triedFitDisplay && state.sourceImageAbs && state.cacheAbs) {
			state.triedFitDisplay = true;
			if (status) {
				status.textContent =
					"This section is too large to open at full size. Preparing a view of the selected image…";
			}
			requestDisplayImage(state.sourceImageAbs, state.cacheAbs, 4096);
			return;
		}
		if (status) {
			status.textContent = "Could not load the section image.";
		}
	};
	var stamp = Date.now();
	try {
		stamp = fs.statSync(absPath).mtimeMs;
	} catch (_err) {}
	img.src = preprocess.fileUrlForPath(absPath) + "?t=" + stamp;
}

function requestDisplayImage(imageAbs, cacheAbs, maxSide) {
	var key = String(cacheAbs || "") + ":" + String(maxSide || 0);
	if (!imageAbs || !cacheAbs || state.displayPending === key) {
		return;
	}
	state.displayPending = key;
	var status = qs("preprocessPreviewStatus");
	if (status && !(maxSide > 0)) {
		status.textContent = "Loading the full-resolution section you selected…";
	}
	ipc.send("runDetectDisplayImage", [imageAbs, cacheAbs, maxSide || 0]);
}

function scheduleLoadBoxes(cacheAbs, imageAbs, trust) {
	setTimeout(function () {
		if (state.cacheAbs !== cacheAbs) {
			return;
		}
		var status = qs("preprocessPreviewStatus");
		var data;
		try {
			data = JSON.parse(fs.readFileSync(cacheAbs, "utf8"));
		} catch (err) {
			if (status) {
				status.textContent =
					"The section image is ready, but the detections could not be read (" +
					(err.message || err) +
					").";
			}
			return;
		}
		if (!trust && imageAbs && !cacheIsFresh(data, imageAbs)) {
			state.boxes = [];
			drawBoxes();
			if (status) {
				status.textContent = "Saved detections do not match this section file. Run raw detection again.";
			}
			return;
		}
		state.boxes = data.boxes || [];
		state.fullW = Number(data.width) || state.fullW;
		state.fullH = Number(data.height) || state.fullH;
		updateAreaSlider();
		drawBoxes();
		if (status && state.showingFullRes) {
			status.textContent =
				state.boxes.length +
				" detections on the selected section (" +
				(state.fullW || "?") +
				"×" +
				(state.fullH || "?") +
				"). Drag to pan and scroll to zoom.";
		}
	}, 0);
}

function applyStoredSliders() {
	var slice = selectedSlice();
	var preset = detectParams.sliderPreset(currentStore(), slice ? sliceIdOf(slice) : "");
	var p = preset.params;
	if (qs("confidenceSlider")) {
		qs("confidenceSlider").value = String(p.confidence);
	}
	if (qs("areaSlider")) {
		qs("areaSlider").value = String(p.area);
	}
	if (qs("eccentricitySlider")) {
		qs("eccentricitySlider").value = String(p.eccentricity);
	}
	if (qs("intensitySlider")) {
		qs("intensitySlider").value = String(p.intensity_min);
	}
	updateSliderLabels();
}

function loadPreview() {
	applyStoredSliders();
	var token = ++previewToken;
	var slice = selectedSlice();
	var img = qs("preprocessPreviewImg");
	state.boxes = [];
	state.cacheAbs = "";
	state.showingFullRes = false;
	state.displayScale = 1;
	state.triedFitDisplay = false;
	state.fullW = 0;
	state.fullH = 0;
	if (!slice || !img) {
		drawBoxes();
		return;
	}
	state.sourceImageAbs = slice.abs;
	var cacheAbs = cachePathFor(sliceIdOf(slice));
	var png = "";
	if (fs.existsSync(cacheAbs)) {
		state.cacheAbs = cacheAbs;
		png = existingDisplayPng(cacheAbs, null);
	}
	if (png) {
		var readyStatus = qs("preprocessPreviewStatus");
		if (readyStatus) {
			readyStatus.textContent = "Opening the selected section…";
		}
		showSectionImage(token, png, true);
		scheduleLoadBoxes(cacheAbs, slice.abs, false);
		return;
	}
	var root = project.isActive() ? project.getBundleRoot() : "";
	var lowRes = preprocess.findSignalPreviewAbs(root, slice.name, selectedBranch());
	showSectionImage(token, lowRes || slice.abs, false);
	if (state.cacheAbs) {
		requestDisplayImage(slice.abs, state.cacheAbs, 0);
	}
}

function fillSelect(select, items, labelFn) {
	if (!select) {
		return;
	}
	var previous = select.value;
	select.innerHTML = "";
	for (var i = 0; i < items.length; i++) {
		var opt = document.createElement("option");
		opt.value = String(i);
		opt.textContent = labelFn(items[i], i);
		select.appendChild(opt);
	}
	if (previous && Number(previous) < items.length) {
		select.value = previous;
	}
}

function refreshSlices() {
	var dataset = selectedDataset();
	state.slices = dataset ? preprocess.listSliceImageFiles(dataset.abs) : [];
	fillSelect(qs("sliceSelect"), state.slices, function (slice) {
		return slice.name;
	});
	loadPreview();
}

function refreshDatasets() {
	var root = project.isActive() ? project.getBundleRoot() : "";
	state.datasets = maxDatasets.listDatasetsForBranch(root, selectedBranch());
	fillSelect(qs("sourceDatasetSelect"), state.datasets, function (ds) {
		return ds.label || ds.rel;
	});
	refreshSlices();
}

function refreshBranches() {
	var root = project.isActive() ? project.getBundleRoot() : "";
	state.branches = maxDatasets.listSignalBranches(root);
	var sel = qs("signalBranchSelect");
	if (sel) {
		sel.innerHTML = "";
		for (var i = 0; i < state.branches.length; i++) {
			var opt = document.createElement("option");
			opt.value = state.branches[i];
			opt.textContent = state.branches[i];
			sel.appendChild(opt);
		}
		if (!state.branches.length) {
			var empty = document.createElement("option");
			empty.value = "";
			empty.textContent = "No signal branches";
			sel.appendChild(empty);
		}
	}
	refreshDatasets();
}

function renderPolicy(preferred) {
	var select = qs("paramPolicy");
	if (!select) {
		return;
	}
	var current = preferred || select.value || "defaults";
	var options = detectParams.policyOptions(currentStore(), projectName());
	select.innerHTML = "";
	var found = false;
	for (var i = 0; i < options.length; i++) {
		var opt = document.createElement("option");
		opt.value = options[i].id;
		opt.textContent = options[i].label;
		if (options[i].id === current) {
			opt.selected = true;
			found = true;
		}
		select.appendChild(opt);
	}
	if (!found) {
		select.value = "defaults";
	}
}

function renderBanner() {
	var banner = qs("paramBanner");
	if (!banner) {
		return;
	}
	banner.innerHTML = "";
	var store = currentStore();
	var ids = detectParams.sectionIds(store);
	var statusText = detectParams.suggestionStatusLine(store);
	if (statusText) {
		var status = document.createElement("div");
		status.className = "mb-2";
		status.textContent = statusText;
		banner.appendChild(status);
	}
	if (!ids.length && !store.averages) {
		if (!statusText) {
			banner.textContent = "Saved section parameters will appear here.";
		}
		renderPolicy();
		return;
	}
	function addRow(labelText, kind, sliceId) {
		var row = document.createElement("div");
		row.className = "d-flex align-items-center gap-2 mb-1";
		var line = document.createElement("div");
		line.className = "flex-grow-1 text-nowrap font-monospace";
		line.style.overflowX = "auto";
		line.textContent = labelText;
		var trash = document.createElement("button");
		trash.type = "button";
		trash.className = "btn btn-sm btn-outline-danger flex-shrink-0";
		trash.setAttribute("data-kind", kind);
		if (sliceId) {
			trash.setAttribute("data-slice", sliceId);
		}
		trash.setAttribute("aria-label", "Delete " + labelText);
		trash.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
		trash.addEventListener("click", function () {
			onTrash(kind, sliceId);
		});
		row.appendChild(line);
		row.appendChild(trash);
		banner.appendChild(row);
	}
	for (var i = 0; i < ids.length; i++) {
		addRow(
			detectParams.bannerLine(
				projectName(),
				detectParams.sectionToken(ids[i]),
				store.sections[ids[i]],
			),
			"section",
			ids[i],
		);
	}
	if (store.averages) {
		addRow(
			detectParams.bannerLine(projectName(), "user averages", store.averages),
			"averages",
			"",
		);
	}
	renderPolicy();
}

function onTrash(kind, sliceId) {
	var store = currentStore();
	var policy = qs("paramPolicy");
	if (kind === "averages") {
		store = detectParams.clearAverages(store);
		if (policy && (policy.value === "averages" || policy.value === "per_section_average")) {
			policy.value = "defaults";
		}
	} else {
		store = detectParams.removeSection(store, sliceId);
		if (policy && policy.value === "section:" + sliceId) {
			policy.value = "defaults";
		}
	}
	saveStore(store);
	renderBanner();
}

function wirePreviewPane() {
	var viewport = qs("preprocessPreviewViewport");
	if (!viewport) {
		return;
	}
	viewport.addEventListener(
		"wheel",
		function (ev) {
			ev.preventDefault();
			var rect = viewport.getBoundingClientRect();
			preprocess.applyCursorAnchoredZoom(
				state,
				ev.clientX - rect.left,
				ev.clientY - rect.top,
				ev.deltaY > 0 ? 0.9 : 1.1,
			);
			applyTransform();
			drawBoxes();
		},
		{ passive: false },
	);
	var dragging = false;
	var lastX = 0;
	var lastY = 0;
	viewport.addEventListener("mousedown", function (ev) {
		dragging = true;
		lastX = ev.clientX;
		lastY = ev.clientY;
	});
	window.addEventListener("mousemove", function (ev) {
		if (!dragging) {
			return;
		}
		state.panX += ev.clientX - lastX;
		state.panY += ev.clientY - lastY;
		lastX = ev.clientX;
		lastY = ev.clientY;
		applyTransform();
	});
	window.addEventListener("mouseup", function () {
		dragging = false;
	});
}

function wireSliders() {
	var ids = ["confidenceSlider", "areaSlider", "eccentricitySlider", "intensitySlider"];
	for (var i = 0; i < ids.length; i++) {
		var el = qs(ids[i]);
		if (el) {
			el.addEventListener("input", drawBoxes);
		}
	}
}

function setSlidersToDefaults() {
	var d = detectParams.DEFAULTS;
	qs("confidenceSlider").value = String(d.confidence);
	qs("areaSlider").value = String(d.area);
	qs("eccentricitySlider").value = String(d.eccentricity);
	qs("intensitySlider").value = String(d.intensity_min);
	drawBoxes();
}

function scoutLeafAbs() {
	var dataset = selectedDataset();
	if (!dataset || !dataset.abs) {
		return "";
	}
	var defaults = detectParams.DEFAULTS;
	var inputDatasetRel = pipelineRuns.relFromRoleBase("max", dataset.abs) || "";
	var method = detectionMethod() === "nuclei" ? "nuclei" : "somata";
	var custom = detectionMethod() === "custom" ? customModelValue() : "";
	var modelBranch = detectCommon.modelBranchForSlug(method, custom);
	var signalBranch =
		pipelineRuns.inferSignalBranchForMaxFamily(inputDatasetRel, dataset.abs) ||
		selectedBranch() ||
		modelBranch;
	var slug = pipelineRuns.buildDetectRunSlug({
		confidence: defaults.confidence,
		tile: tileValue(),
		area: defaults.area,
		eccentricity: defaults.eccentricity,
		intensityMin: 0,
		sortedStems: detectCommon.listInputSliceStems(dataset.abs),
		inputDatasetRel: inputDatasetRel,
		modelBranch: modelBranch,
	});
	var predBase = pipelineRuns.resolveRoleBaseAbs("predictions");
	if (!predBase) {
		return "";
	}
	return path.join(predBase, signalBranch, "qc_scout", slug);
}

function startScout() {
	if (state.scoutRunning || state.rawRunning || state.fullRunning) {
		return;
	}
	if (!project.isActive()) {
		alert("Open a project before suggesting intensity.");
		return;
	}
	var dataset = selectedDataset();
	if (!dataset || !dataset.abs) {
		alert("Choose a source dataset first.");
		return;
	}
	if (detectionMethod() === "custom" && !customModelValue()) {
		alert("Choose a custom model file.");
		return;
	}
	var outDir = scoutLeafAbs();
	if (!outDir) {
		alert("Could not resolve a scout output folder.");
		return;
	}
	try {
		fs.mkdirSync(outDir, { recursive: true });
	} catch (err) {
		alert("Could not create the scout folder: " + (err.message || err));
		return;
	}
	state.scoutOut = outDir;
	setScoutChrome(true);
	setRawProgress(
		0,
		"Suggesting intensity with the default cutoffs (confidence 0.50, area 200, eccentricity 0.20)…",
	);
	var method = detectionMethod();
	ipc.send("runDetection", [
		dataset.abs,
		outDir,
		detectParams.DEFAULTS.confidence,
		tileValue(),
		method === "custom" ? customModelValue() : "",
		false,
		method === "nuclei" ? "nuclei" : "somata",
		detectParams.DEFAULTS.area,
		detectParams.DEFAULTS.eccentricity,
		"",
		false,
		0,
		"",
		true,
	]);
}

function onScoutResult(_event, payload) {
	if (!state.scoutRunning) {
		return;
	}
	setScoutChrome(false);
	if (!payload || !payload.ok) {
		setRawProgress(0, (payload && payload.error) || "Intensity suggestion failed.");
		return;
	}
	var summaryPath = path.join(payload.outputAbs || state.scoutOut || "", "detect_qc_summary.json");
	var perSlice = null;
	try {
		var summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
		perSlice = summary.analysis && summary.analysis.per_slice;
	} catch (err) {
		setRawProgress(0, "Could not read intensity suggestions (" + (err.message || err) + ").");
		return;
	}
	if (!perSlice || typeof perSlice !== "object") {
		setRawProgress(0, "The scout finished without per-section intensity suggestions.");
		return;
	}
	var store = detectParams.mergeIntensitySuggestions(currentStore(), perSlice);
	saveStore(store);
	renderBanner();
	applyStoredSliders();
	drawBoxes();
	setRawProgress(100, detectParams.suggestionStatusLine(store) || "Intensity suggestions saved.");
}

function runRaw() {
	if (state.rawRunning || state.scoutRunning) {
		return;
	}
	if (!project.isActive()) {
		alert("Open a project before running raw detection.");
		return;
	}
	var slice = selectedSlice();
	if (!slice) {
		alert("Choose a section first.");
		return;
	}
	if (detectionMethod() === "custom" && !customModelValue()) {
		alert("Choose a custom model file.");
		return;
	}
	var sliceId = sliceIdOf(slice);
	var cacheAbs = cachePathFor(sliceId);
	try {
		fs.mkdirSync(path.dirname(cacheAbs), { recursive: true });
	} catch (err) {
		alert("Could not create the raw-detection cache: " + (err.message || err));
		return;
	}
	state.cacheAbs = cacheAbs;
	state.sourceImageAbs = slice.abs;
	setRawChrome(true);
	setRawProgress(0, "Launching raw detection…");
	var status = qs("preprocessPreviewStatus");
	if (status) {
		status.textContent = "Running raw detection on this section…";
	}
	ipc.send("runDetectRaw", [
		slice.abs,
		detectionMethod(),
		customModelValue(),
		tileValue(),
		cacheAbs,
		sliceId,
	]);
}

function onRawResult(_event, payload) {
	if (!state.rawRunning) {
		return;
	}
	setRawChrome(false);
	console.log(
		"[detect-params] raw result",
		payload && payload.ok,
		payload && payload.count,
		payload && payload.displayPath,
	);
	if (!payload || !payload.ok) {
		setRawProgress(0, (payload && payload.error) || "Raw detection failed.");
		var status = qs("preprocessPreviewStatus");
		if (status) {
			status.textContent = (payload && payload.error) || "Raw detection failed.";
		}
		return;
	}
	setRawProgress(100, "Raw detection finished.");
	state.fullW = Number(payload.width) || state.fullW;
	state.fullH = Number(payload.height) || state.fullH;
	state.displayScale = 1;
	state.triedFitDisplay = false;
	if (payload.cachePath) {
		state.cacheAbs = payload.cachePath;
	}
	var png = payload.displayPath && fs.existsSync(payload.displayPath) ? payload.displayPath : "";
	if (!png && state.cacheAbs) {
		png = existingDisplayPng(state.cacheAbs, null);
	}
	var statusEl = qs("preprocessPreviewStatus");
	if (!png) {
		if (statusEl) {
			statusEl.textContent = "Raw detection finished, but the full-resolution image was not written.";
		}
		return;
	}
	if (statusEl) {
		statusEl.textContent =
			"Opening full-resolution section (" +
			(payload.width || "?") +
			"×" +
			(payload.height || "?") +
			")…";
	}
	var token = ++previewToken;
	showSectionImage(token, png, true);
	if (state.cacheAbs) {
		scheduleLoadBoxes(state.cacheAbs, state.sourceImageAbs, true);
	}
}

function detectThreshold() {
	if (!state.cacheAbs || !fs.existsSync(state.cacheAbs)) {
		var status = qs("preprocessPreviewStatus");
		if (status) {
			status.textContent = "Run raw detection before detecting a threshold.";
		}
		return;
	}
	var p = sliderParams();
	ipc.send("runDetectIntensityEstimate", [
		state.cacheAbs,
		p.confidence,
		p.area,
		p.eccentricity,
	]);
}

function onEstimate(_event, payload) {
	var status = qs("preprocessPreviewStatus");
	if (!payload || payload.ok === false) {
		if (status) {
			status.textContent = (payload && payload.error) || "Threshold estimate failed.";
		}
		return;
	}
	var estimate = payload.intensity_threshold_estimate;
	if (!payload.bimodal || estimate == null) {
		var reason = payload.reason || "unimodal";
		if (status) {
			status.textContent =
				reason === "too_few_detections"
					? "No split found (need at least 30 detections above the other cutoffs)."
					: "No intensity split found for the boxes that pass the other cutoffs.";
		}
		return;
	}
	var slider = qs("intensitySlider");
	if (slider) {
		slider.value = String(estimate);
	}
	drawBoxes();
	if (status) {
		status.textContent = "Intensity cutoff set to " + String(estimate) + ".";
	}
}

function saveSection() {
	var slice = selectedSlice();
	if (!slice) {
		alert("Choose a section first.");
		return;
	}
	if (!project.isActive()) {
		alert("Open a project before saving detection parameters.");
		return;
	}
	var store = detectParams.upsertSection(currentStore(), sliceIdOf(slice), sliderParams());
	saveStore(store);
	renderBanner();
}

function calcAverages() {
	if (!detectParams.sectionIds(currentStore()).length) {
		var status = qs("preprocessPreviewStatus");
		if (status) {
			status.textContent = "Save a section before calculating averages.";
		}
		return;
	}
	saveStore(detectParams.withAverages(currentStore()));
	renderBanner();
}

function runParamsForPayload(resolved) {
	var globalParams = resolved.mixed ? resolved.fallback : resolved.global;
	return {
		confidence: globalParams.confidence,
		area: globalParams.area,
		eccentricity: globalParams.eccentricity,
		intensity_min: globalParams.intensity_min,
		tile: tileValue(),
		model: detectionMethod() === "custom" ? customModelValue() : "",
		multichannel: false,
	};
}

function startFullRun() {
	if (state.fullRunning || state.rawRunning || state.scoutRunning) {
		return;
	}
	if (!project.isActive()) {
		alert("Open a project before running detection.");
		return;
	}
	var dataset = selectedDataset();
	if (!dataset) {
		alert("Choose a source dataset first.");
		return;
	}
	if (detectionMethod() === "custom" && !customModelValue()) {
		alert("Choose a custom model file.");
		return;
	}
	var parsed = detectParams.parsePolicyId(qs("paramPolicy").value);
	var stems = detectCommon.listInputSliceStems(dataset.abs);
	var resolved = detectParams.resolveDetectionPolicy({
		mode: parsed.mode,
		sectionId: parsed.sectionId,
		saved: currentStore(),
		sliceIds: stems,
		defaults: detectParams.DEFAULTS,
	});
	if (resolved.error) {
		alert(resolved.error);
		return;
	}
	var sliceParamsPath = "";
	if (resolved.mixed) {
		if (!project.isActive()) {
			alert("Open a project before running mixed section parameters.");
			return;
		}
		sliceParamsPath = path.join(project.metaDirPath(), "detect_slice_params.json");
		try {
			fs.mkdirSync(path.dirname(sliceParamsPath), { recursive: true });
			fs.writeFileSync(
				sliceParamsPath,
				JSON.stringify(
					{
						policy: parsed.mode,
						default: resolved.fallback,
						slices: resolved.perSlice,
					},
					null,
					2,
				),
			);
		} catch (err) {
			alert("Could not write section parameters: " + (err.message || err));
			return;
		}
	}
	var payload = detectCommon.buildRunPayload({
		form: {
			indir: { value: dataset.abs },
			outdir: { value: "" },
			perSliceQc: { checked: false },
			flatOutput: { checked: false },
		},
		detectionMethod: detectionMethod() === "nuclei" ? "nuclei" : "somata",
		params: runParamsForPayload(resolved),
		mixed: resolved.mixed,
		sliceParamsPath: sliceParamsPath,
	});
	if (!payload || payload.error) {
		alert((payload && payload.error) || "Could not start detection.");
		return;
	}
	state.outputAbs = payload.finalOut;
	state.runRel = payload.lastDetectionRunRel || "";
	var log = qs("wizardLog");
	if (log) {
		log.textContent = "";
	}
	setStep(2);
	setFullChrome(true);
	setProcessProgress(0, "Launching cell detection…");
	ipc.send("runDetection", payload.ipcArgs);
}

function showSummary(success, message) {
	setFullChrome(false);
	setStep(3);
	var alertEl = qs("summaryAlert");
	if (alertEl) {
		alertEl.className = "alert text-start " + (success ? "alert-success" : "alert-danger");
		alertEl.textContent = message;
	}
	var gallery = qs("qcGallery");
	var analysis = qs("qcAnalysisSummary");
	if (gallery) {
		gallery.innerHTML = "";
	}
	if (analysis) {
		analysis.innerHTML = "";
	}
	if (!success || !state.outputAbs) {
		return;
	}
	var files = [
		"detect_qc_confidence.png",
		"detect_qc_area_px2.png",
		"detect_qc_eccentricity.png",
	];
	for (var i = 0; i < files.length; i++) {
		var abs = path.join(state.outputAbs, files[i]);
		if (!gallery || !fs.existsSync(abs)) {
			continue;
		}
		var wrap = document.createElement("div");
		wrap.className = "mb-3";
		var cap = document.createElement("div");
		cap.className = "small text-muted mb-1";
		cap.textContent = files[i];
		var img = document.createElement("img");
		img.alt = files[i];
		img.className = "img-fluid";
		img.src = preprocess.fileUrlForPath(abs) + "?t=" + Date.now();
		wrap.appendChild(cap);
		wrap.appendChild(img);
		gallery.appendChild(wrap);
	}
	var summaryPath = path.join(state.outputAbs, "detect_qc_summary.json");
	if (analysis && fs.existsSync(summaryPath)) {
		try {
			var summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
			var lines = (summary.analysis && summary.analysis.summary_lines) || [];
			if (!lines.length) {
				analysis.textContent = "QC summary written.";
			} else {
				var list = document.createElement("ul");
				list.className = "mb-0";
				for (var L = 0; L < lines.length; L++) {
					var item = document.createElement("li");
					item.textContent = lines[L];
					list.appendChild(item);
				}
				analysis.appendChild(list);
			}
		} catch (_err) {
			analysis.textContent = "QC summary could not be read.";
		}
	}
}

ipc.on("detectRawResult", onRawResult);
ipc.on("detectQcScoutResult", onScoutResult);
ipc.on("detectDisplayImageResult", function (_event, payload) {
	state.displayPending = "";
	console.log(
		"[detect-params] display image",
		payload && payload.ok,
		payload && payload.displayPath,
		payload && payload.displayScale,
	);
	if (!payload || !payload.ok || !payload.displayPath) {
		var status = qs("preprocessPreviewStatus");
		if (status) {
			status.textContent =
				(payload && payload.error) || "Could not load the full-resolution section.";
		}
		return;
	}
	if (payload.cachePath && state.cacheAbs && normalizePath(payload.cachePath) !== normalizePath(state.cacheAbs)) {
		return;
	}
	state.displayScale = Number(payload.displayScale) > 0 ? Number(payload.displayScale) : 1;
	if (payload.fullWidth) {
		state.fullW = Number(payload.fullWidth);
	}
	if (payload.fullHeight) {
		state.fullH = Number(payload.fullHeight);
	}
	var token = ++previewToken;
	showSectionImage(token, payload.displayPath, true);
});
ipc.on("detectIntensityEstimateResult", onEstimate);
ipc.on("updateLoad", function (_event, response) {
	if (!response) {
		return;
	}
	if (state.rawRunning || state.scoutRunning) {
		setRawProgress(response[0], response[1]);
		return;
	}
	if (state.fullRunning) {
		setProcessProgress(response[0], response[1]);
	}
});
ipc.on("detectResult", function () {
	if (!state.fullRunning && state.step !== 2) {
		return;
	}
	state.fullRunning = false;
	if (project.isActive() && state.runRel) {
		pipelineRuns.setActiveRunRel("detect", state.runRel);
		project.refreshProjectIndex().catch(function () {});
	}
	showSummary(true, "Cell detection finished.");
});
ipc.on("detectError", function (_event, payload) {
	if (!state.fullRunning && state.step !== 2) {
		return;
	}
	var message = "Cell detection failed. Check the Application log for details.";
	if (payload && payload[0]) {
		message = String(payload[0]);
	}
	showSummary(false, message);
});

projectIndexBusy.populatePage(function () {
	project.tryRestoreActiveProject();
	pipelineGate.assertPipelineAccess();
	var method = qs("methodSelect");
	if (method) {
		method.addEventListener("change", function () {
			var row = qs("customModelRow");
			if (row) {
				row.classList.toggle("d-none", method.value !== "custom");
			}
			loadPreview();
		});
	}
	var browse = qs("browseCustomModel");
	if (browse) {
		browse.addEventListener("click", function () {
			ipc.once("returnPath", function (_event, response) {
				var tag = response && response[1];
				if (tag && typeof tag === "object" && tag.tag) {
					tag = tag.tag;
				}
				if (tag === "detectCustomModel" && response[0]) {
					qs("customModel").value = response[0];
					loadPreview();
				}
			});
			ipc.send("openFileDialog", { tag: "detectCustomModel" });
		});
	}
	var custom = qs("customModel");
	if (custom) {
		custom.addEventListener("change", loadPreview);
	}
	var tile = qs("tileSize");
	if (tile) {
		tile.addEventListener("change", loadPreview);
	}
	var branch = qs("signalBranchSelect");
	if (branch) {
		branch.addEventListener("change", refreshDatasets);
	}
	var dataset = qs("sourceDatasetSelect");
	if (dataset) {
		dataset.addEventListener("change", refreshSlices);
	}
	var slice = qs("sliceSelect");
	if (slice) {
		slice.addEventListener("change", loadPreview);
	}
	var runRawBtn = qs("runRawDetection");
	if (runRawBtn) {
		runRawBtn.addEventListener("click", runRaw);
	}
	var rawCancel = qs("rawDetectCancel");
	if (rawCancel) {
		rawCancel.addEventListener("click", function () {
			if (state.scoutRunning) {
				state.scoutRunning = false;
				ipc.send("killDetect");
				setScoutChrome(false);
				setRawProgress(0, "Cancelling intensity suggestion…");
				return;
			}
			ipc.send("killDetectRaw");
			setRawChrome(false);
			setRawProgress(0, "Cancelling raw detection…");
		});
	}
	var suggestBtn = qs("suggestIntensity");
	if (suggestBtn) {
		suggestBtn.addEventListener("click", startScout);
	}
	var defaultsBtn = qs("setDefaults");
	if (defaultsBtn) {
		defaultsBtn.addEventListener("click", setSlidersToDefaults);
	}
	var thresholdBtn = qs("detectThreshold");
	if (thresholdBtn) {
		thresholdBtn.addEventListener("click", detectThreshold);
	}
	var saveBtn = qs("saveSectionParams");
	if (saveBtn) {
		saveBtn.addEventListener("click", saveSection);
	}
	var avgBtn = qs("calcAverages");
	if (avgBtn) {
		avgBtn.addEventListener("click", calcAverages);
	}
	var runBtn = qs("saveAndRun");
	if (runBtn) {
		runBtn.addEventListener("click", startFullRun);
	}
	var step2Back = qs("step2Back");
	if (step2Back) {
		step2Back.addEventListener("click", function () {
			if (state.fullRunning) {
				return;
			}
			setStep(1);
		});
	}
	var step2Cancel = qs("step2Cancel");
	if (step2Cancel) {
		step2Cancel.addEventListener("click", function () {
			ipc.send("killDetect");
			setFullChrome(false);
			setStep(1);
			setProcessProgress(0, "Cancelled.");
		});
	}
	var backExplore = qs("backToExplore");
	if (backExplore) {
		backExplore.addEventListener("click", function () {
			setStep(1);
		});
	}
	wireSliders();
	wirePreviewPane();
	setSlidersToDefaults();
	refreshBranches();
	renderBanner();
	setStep(1);
	setRawChrome(false);
	setFullChrome(false);
});
