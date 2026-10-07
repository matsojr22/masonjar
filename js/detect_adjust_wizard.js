"use strict";

var fs = require("fs");
var path = require("path");
var ipc = require("electron").ipcRenderer;
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var pipelineRuns = require("./pipeline_runs");
var detectCommon = require("./detect_common");
var detectParams = require("./detect_params");
var preprocess = require("./preprocess_wizard");
var projectIndexBusy = require("./project_index_busy");
var dialogs = require("./dialogs");

var previewToken = 0;

var state = {
	runs: [],
	runAbs: "",
	slices: [],
	index: 0,
	boxes: [],
	mode: "pkl",
	loadedParams: detectParams.DEFAULTS,
	paramSource: "",
	minConfidence: null,
	dirty: false,
	busy: false,
	pendingIndex: null,
	rawRunning: false,
	displayScale: 1,
	showingFullRes: false,
	triedFit: false,
	sourceImageAbs: "",
	displayPath: "",
	panX: 0,
	panY: 0,
	scale: 1,
	baseW: 0,
	baseH: 0,
	viewW: 640,
	viewH: 640,
	fullW: 0,
	fullH: 0,
	manifest: null,
	scoutSections: {},
	scoutPooled: null,
	savedSuggestions: {},
	loadedCutoff: null,
	loadedReason: "",
	loadedCount: 0,
	loadedFiltered: false,
	loadedPending: false,
	estimatePending: false,
	estimateSlice: "",
	recordsPath: "",
	rawCache: "",
};

function qs(id) {
	return document.getElementById(id);
}

function readJson(filePath) {
	try {
		if (!filePath || !fs.existsSync(filePath)) {
			return {};
		}
		var data = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return data && typeof data === "object" ? data : {};
	} catch (_err) {
		return {};
	}
}

function currentSliceId() {
	var slice = currentSlice();
	return slice ? slice.id : "";
}

function scoutHintText(hint, sliceId) {
	if (hint && hint.intensity_min) {
		if (hint.scope === "brain") {
			return (
				"QC scout suggested intensity " +
				hint.intensity_min +
				" for the whole brain. That scout did not store a separate cutoff for " +
				sliceId +
				"."
			);
		}
		if (hint.source === "saved") {
			return "Saved intensity suggestion for " + sliceId + " is " + hint.intensity_min + ".";
		}
		if (hint.source === "run") {
			return "This detection run suggested intensity " + hint.intensity_min + " for " + sliceId + ".";
		}
		return "QC scout suggested intensity " + hint.intensity_min + " for " + sliceId + ".";
	}
	if (hint && hint.scope === "section") {
		return "The QC scout did not find an intensity split for " + sliceId + ".";
	}
	return "No QC scout intensity suggestion is stored for this section.";
}

function loadedHintText() {
	if (state.estimatePending) {
		return state.loadedFiltered
			? "Calculating a cutoff from the boxes that pass the other sliders…"
			: "Measuring the boxes in this file…";
	}
	if (state.loadedPending) {
		return "Measuring the boxes in this file…";
	}
	if (Number(state.loadedCutoff) > 0) {
		var lead = state.loadedFiltered
			? "Boxes that pass the other sliders suggest an intensity cutoff of "
			: "The boxes in this file suggest an intensity cutoff of ";
		return lead + state.loadedCutoff + ".";
	}
	if (state.loadedReason === "too_few_detections") {
		return "Not enough boxes in this file to estimate a cutoff (need at least 30).";
	}
	if (state.loadedReason) {
		return "The boxes in this file do not show a low/high intensity split.";
	}
	return "No cutoff has been calculated from the boxes in this file.";
}

function renderThresholdHints() {
	var sliceId = currentSliceId();
	var hint = detectParams.sectionIntensityHint(sliceId, {
		suggestions: state.savedSuggestions,
		scoutSections: state.scoutSections,
		pooled: state.scoutPooled,
	});
	state.scoutHint = hint;
	var scout = qs("scoutHint");
	var useScout = qs("useScoutCutoff");
	var loaded = qs("loadedHint");
	var useLoaded = qs("useLoadedCutoff");
	if (scout) {
		scout.textContent = scoutHintText(hint, sliceId || "this section");
	}
	if (useScout) {
		useScout.disabled = state.busy || !(hint && Number(hint.intensity_min) > 0);
	}
	if (loaded) {
		loaded.textContent = loadedHintText();
	}
	if (useLoaded) {
		useLoaded.disabled = state.busy || !(Number(state.loadedCutoff) > 0);
	}
	var detect = qs("detectThreshold");
	if (detect) {
		detect.disabled = state.busy || state.estimatePending || !(state.recordsPath || state.rawCache);
	}
}

function applyIntensityCutoff(value) {
	var slider = qs("intensitySlider");
	var cutoff = Math.round(Number(value));
	if (!slider || !(cutoff > 0)) {
		return;
	}
	slider.value = String(cutoff);
	drawBoxes();
}

function absorbPerSlice(target, perSlice, source) {
	if (!perSlice || typeof perSlice !== "object") {
		return;
	}
	Object.keys(perSlice).forEach(function (id) {
		var row = perSlice[id] || {};
		target[id] = {
			intensity_min: row.intensity_min,
			reason: row.reason || null,
			source: source,
		};
	});
}

function listScoutSummaries() {
	var found = [];
	var base = pipelineRuns.resolveRoleBaseAbs("predictions");
	if (!base || !fs.existsSync(base)) {
		return found;
	}
	var branches;
	try {
		branches = fs.readdirSync(base);
	} catch (_err) {
		return found;
	}
	branches.forEach(function (branch) {
		var root = path.join(base, branch, "qc_scout");
		if (!fs.existsSync(root)) {
			return;
		}
		var leaves;
		try {
			leaves = fs.readdirSync(root);
		} catch (_err) {
			return;
		}
		leaves.forEach(function (leaf) {
			var summary = path.join(root, leaf, "detect_qc_summary.json");
			if (fs.existsSync(summary)) {
				found.push(summary);
			}
		});
	});
	found.sort(function (a, b) {
		return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
	});
	return found;
}

function loadSuggestionIndex() {
	state.scoutSections = {};
	state.scoutPooled = null;
	listScoutSummaries().forEach(function (file) {
		var analysis = (readJson(file).analysis) || {};
		absorbPerSlice(state.scoutSections, analysis.per_slice, "scout");
		var pooled = analysis.suggestions && analysis.suggestions.intensity_min;
		if (Number(pooled) > 0) {
			state.scoutPooled = Math.round(Number(pooled));
		}
	});
	if (state.runAbs) {
		var runAnalysis = (readJson(path.join(state.runAbs, "detect_qc_summary.json")).analysis) || {};
		var per = runAnalysis.per_slice || {};
		Object.keys(per).forEach(function (id) {
			if (!Object.prototype.hasOwnProperty.call(state.scoutSections, id)) {
				state.scoutSections[id] = {
					intensity_min: per[id] && per[id].intensity_min,
					reason: (per[id] && per[id].reason) || null,
					source: "run",
				};
			}
		});
	}
	var store = detectParams.readStore(project.getProject());
	state.savedSuggestions = store.suggestions || {};
}

function requestLoadedCutoff(cachePath, confidence, area, eccentricity) {
	var sliceId = currentSliceId();
	if (!cachePath || !sliceId) {
		return;
	}
	state.estimateSlice = sliceId;
	state.estimatePending = true;
	renderThresholdHints();
	ipc.send("runDetectIntensityEstimate", [cachePath, confidence, area, eccentricity]);
}

function sliderParams() {
	return {
		confidence: Number(qs("confidenceSlider").value),
		area: Number(qs("areaSlider").value),
		eccentricity: Number(qs("eccentricitySlider").value),
		intensity_min: Number(qs("intensitySlider").value),
	};
}

function currentSlice() {
	return state.slices[state.index] || null;
}

function setProgress(pct, text) {
	var bar = qs("adjustProgress");
	var label = qs("adjustProgressText");
	var n = Math.min(100, Math.max(0, Number(pct) || 0));
	if (bar) {
		bar.style.width = n + "%";
		bar.setAttribute("aria-valuenow", String(n));
	}
	if (label) {
		label.textContent = text || "";
	}
}

function setBusy(busy) {
	state.busy = !!busy;
	["prevSection", "nextSection", "savePkl", "revertSection", "loadRaw", "runSelect", "sliceSelect", "useScoutCutoff", "useLoadedCutoff", "detectThreshold"].forEach(
		function (id) {
			var el = qs(id);
			if (el) {
				el.disabled = !!busy;
			}
		},
	);
	if (!busy) {
		var revert = qs("revertSection");
		var slice = currentSlice();
		if (revert) {
			revert.disabled = !(
				slice &&
				slice.pkl &&
				state.runAbs &&
				fs.existsSync(path.join(state.runAbs, "adjust_backup", path.basename(slice.pkl)))
			);
		}
		renderThresholdHints();
	}
	var cancel = qs("adjustCancel");
	var back = qs("adjustBack");
	if (cancel) {
		cancel.classList.toggle("d-none", !busy);
	}
	if (back) {
		back.classList.toggle("d-none", !!busy);
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

function boxStrokeWidth() {
	var viewScale = state.scale > 0 ? state.scale : 1;
	var imageScale = state.displayScale > 0 ? state.displayScale : 1;
	var stroke = Math.max(1, 2 * imageScale);
	if (viewScale < 1) {
		stroke = Math.max(stroke, 1 / viewScale);
	}
	return stroke;
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

function refreshDirty() {
	state.dirty = !detectParams.paramsEqual(sliderParams(), state.loadedParams);
	var status = qs("sectionStatus");
	var slice = currentSlice();
	if (!status) {
		return;
	}
	if (!slice) {
		status.textContent = "No section loaded.";
		return;
	}
	status.textContent =
		state.index +
		1 +
		" / " +
		state.slices.length +
		" · " +
		slice.id +
		" · " +
		(state.dirty ? "unsaved changes" : "saved");
}

function drawBoxes() {
	updateSliderLabels();
	refreshDirty();
	var img = qs("preprocessPreviewImg");
	var overlay = qs("preprocessPreviewOverlay");
	var countEl = qs("boxCount");
	var kept = state.showingFullRes ? detectParams.filterBoxes(state.boxes, sliderParams()) : [];
	if (countEl) {
		countEl.textContent = state.boxes.length
			? kept.length + " of " + state.boxes.length + " boxes"
			: "No boxes in this file.";
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

function showImage(token, absPath) {
	var img = qs("preprocessPreviewImg");
	var status = qs("preprocessPreviewStatus");
	if (!img) {
		return;
	}
	state.showingFullRes = true;
	img.onload = function () {
		if (token !== previewToken) {
			return;
		}
		state.baseW = img.naturalWidth || 0;
		state.baseH = img.naturalHeight || 0;
		var viewport = qs("preprocessPreviewViewport");
		var rect = viewport ? viewport.getBoundingClientRect() : null;
		state.viewW = Math.max(280, (rect && rect.width) || 640);
		state.viewH = Math.max(280, (rect && rect.height) || 640);
		preprocess.fitViewportToDimensions(state, state.baseW, state.baseH);
		applyTransform();
		drawBoxes();
		if (status && state.mode === "pkl") {
			status.textContent =
				"Boxes dropped during the original run are not in this file. Drag to pan and scroll to zoom.";
		}
	};
	img.onerror = function () {
		if (token !== previewToken || state.triedFit) {
			if (status && token === previewToken) {
				status.textContent = "Could not load the section image.";
			}
			return;
		}
		state.triedFit = true;
		if (status) {
			status.textContent = "This section is too large to open at full size. Preparing a smaller view…";
		}
		requestPreview(4096);
	};
	var stamp = Date.now();
	try {
		stamp = fs.statSync(absPath).mtimeMs;
	} catch (_err) {}
	img.src = preprocess.fileUrlForPath(absPath) + "?t=" + stamp;
}

function confidenceFloor() {
	if (state.mode === "raw") {
		return detectParams.RAW_CONFIDENCE_FLOOR;
	}
	var loaded = state.loadedParams ? Number(state.loadedParams.confidence) : 0.5;
	var floor = loaded;
	if (state.minConfidence != null && isFinite(Number(state.minConfidence))) {
		floor = Math.min(floor, Number(state.minConfidence));
	}
	if (!(floor >= detectParams.RAW_CONFIDENCE_FLOOR)) {
		floor = detectParams.RAW_CONFIDENCE_FLOOR;
	}
	return floor;
}

function applyLoadedSliders() {
	var p = detectParams.normalizeParams(state.loadedParams);
	var confidence = qs("confidenceSlider");
	if (confidence) {
		confidence.min = String(confidenceFloor());
		confidence.value = String(Math.max(Number(confidence.min), p.confidence));
	}
	qs("areaSlider").value = String(p.area);
	qs("eccentricitySlider").value = String(p.eccentricity);
	qs("intensitySlider").value = String(p.intensity_min);
	var area = qs("areaSlider");
	var maxArea = detectParams.areaSliderMax(state.boxes);
	if (area && Number(area.max) < maxArea) {
		area.max = String(maxArea);
	}
	var source = qs("paramSource");
	if (source) {
		source.textContent = state.paramSource || "";
	}
	state.dirty = false;
	drawBoxes();
}

function paramsForSlice(sliceId) {
	var adjust = readJson(path.join(state.runAbs, "adjust_params.json"));
	var adjustRow = adjust.slices && adjust.slices[sliceId];
	if (adjustRow) {
		return {
			params: detectParams.normalizeParams(adjustRow),
			source: "Loaded from an earlier adjustment on this section.",
		};
	}
	var spec = readJson(path.join(state.runAbs, "detect_slice_params.json"));
	var specRow = spec.slices && spec.slices[sliceId];
	if (specRow) {
		return {
			params: detectParams.normalizeParams(specRow),
			source: "Loaded from this run's section parameters.",
		};
	}
	var manifest = state.manifest || {};
	return {
		params: detectParams.normalizeParams({
			confidence: manifest.confidence,
			area: manifest.area,
			eccentricity: manifest.eccentricity,
			intensity_min: manifest.intensity_min,
		}),
		source: "Loaded from the run defaults.",
	};
}

function findImage(sliceId) {
	var inputDir = state.manifest && state.manifest.input_dir;
	if (!inputDir || !fs.existsSync(inputDir)) {
		return "";
	}
	var names;
	try {
		names = fs.readdirSync(inputDir);
	} catch (_err) {
		return "";
	}
	for (var i = 0; i < names.length; i++) {
		if (detectCommon.sliceStemFromImageBasename(names[i]) === sliceId) {
			return path.join(inputDir, names[i]);
		}
	}
	return "";
}

function listSlices(runAbs) {
	var names;
	try {
		names = fs.readdirSync(runAbs);
	} catch (_err) {
		return [];
	}
	var slices = [];
	for (var i = 0; i < names.length; i++) {
		var match = /^Predictions_(.+)\.pkl$/i.exec(names[i]);
		if (!match) {
			continue;
		}
		slices.push({
			id: match[1],
			pkl: path.join(runAbs, names[i]),
		});
	}
	slices.sort(function (a, b) {
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	return slices;
}

function fillSliceSelect() {
	var sel = qs("sliceSelect");
	if (!sel) {
		return;
	}
	sel.innerHTML = "";
	for (var i = 0; i < state.slices.length; i++) {
		var opt = document.createElement("option");
		opt.value = String(i);
		opt.textContent = state.slices[i].id;
		if (i === state.index) {
			opt.selected = true;
		}
		sel.appendChild(opt);
	}
	if (!state.slices.length) {
		var empty = document.createElement("option");
		empty.value = "";
		empty.textContent = "No prediction files";
		sel.appendChild(empty);
	}
}

function requestPreview(maxSide) {
	var slice = currentSlice();
	if (!slice) {
		return;
	}
	var image = findImage(slice.id);
	state.sourceImageAbs = image;
	if (!image) {
		state.loadedPending = false;
		renderThresholdHints();
		var status = qs("preprocessPreviewStatus");
		if (status) {
			status.textContent = "Could not find the source image for " + slice.id + ".";
		}
		return;
	}
	var display = path.join(state.runAbs, "adjust_display", slice.id + (maxSide ? "_fit" : "") + "_display.png");
	try {
		fs.mkdirSync(path.dirname(display), { recursive: true });
	} catch (_err) {}
	state.displayPath = display;
	setBusy(true);
	setProgress(0, "Loading " + slice.id + "…");
	ipc.send("runDetectAdjustPreview", [image, slice.pkl, display, maxSide || 0]);
}

function loadIndex(index) {
	if (!state.slices.length) {
		return;
	}
	state.index = Math.max(0, Math.min(state.slices.length - 1, index));
	state.mode = "pkl";
	state.pendingIndex = null;
	state.triedFit = false;
	state.boxes = [];
	state.showingFullRes = false;
	state.displayScale = 1;
	var slice = currentSlice();
	var preset = paramsForSlice(slice.id);
	state.loadedParams = preset.params;
	state.paramSource = preset.source;
	state.loadedCutoff = null;
	state.loadedReason = "";
	state.loadedCount = 0;
	state.loadedPending = true;
	state.loadedFiltered = false;
	state.estimatePending = false;
	state.recordsPath = "";
	state.rawCache = "";
	renderThresholdHints();
	fillSliceSelect();
	var revert = qs("revertSection");
	if (revert) {
		revert.disabled = !fs.existsSync(path.join(state.runAbs, "adjust_backup", path.basename(slice.pkl)));
	}
	applyLoadedSliders();
	requestPreview(0);
}

function loadRun(rel) {
	var base = pipelineRuns.resolveRoleBaseAbs("predictions");
	state.runRel = rel || "";
	state.runAbs = base && rel ? path.join(base, rel.split("/").join(path.sep)) : "";
	state.manifest = state.runAbs ? readJson(path.join(state.runAbs, "run_manifest.json")) : null;
	loadSuggestionIndex();
	state.slices = state.runAbs ? listSlices(state.runAbs) : [];
	state.index = 0;
	fillSliceSelect();
	if (!state.slices.length) {
		var status = qs("sectionStatus");
		if (status) {
			status.textContent = "This run has no prediction files.";
		}
		return;
	}
	loadIndex(0);
}

function fillRuns() {
	var sel = qs("runSelect");
	if (!sel) {
		return;
	}
	state.runs = pipelineRuns.listRunChoicesForRole("predictions") || [];
	var active = pipelineRuns.getActiveRunRelForRole("predictions") || "";
	sel.innerHTML = "";
	if (!state.runs.length) {
		var empty = document.createElement("option");
		empty.value = "";
		empty.textContent = "No finished detection runs";
		sel.appendChild(empty);
		return;
	}
	var chosen = "";
	for (var i = 0; i < state.runs.length; i++) {
		var opt = document.createElement("option");
		opt.value = state.runs[i].rel;
		opt.textContent = state.runs[i].label || state.runs[i].rel;
		if (state.runs[i].rel === active) {
			opt.selected = true;
			chosen = state.runs[i].rel;
		}
		sel.appendChild(opt);
	}
	if (!chosen) {
		chosen = state.runs[0].rel;
		sel.value = chosen;
	}
	loadRun(chosen);
}

function keptRequestRows() {
	var kept = detectParams.filterBoxes(state.boxes, sliderParams());
	var rows = [];
	for (var i = 0; i < kept.length; i++) {
		rows.push({
			channel: Number(kept[i].channel) || 0,
			xyxy: kept[i].xyxy,
		});
	}
	return rows;
}

function saveCurrent() {
	var slice = currentSlice();
	if (!slice || state.busy) {
		return;
	}
	var image = state.sourceImageAbs || findImage(slice.id);
	if (!image) {
		state.pendingIndex = null;
		state.pendingRun = null;
		alert("Could not find the source image for this section.");
		return;
	}
	var bboxes = path.join(state.runAbs, "BBoxes_" + slice.id + ".png");
	var request = {
		image: image,
		pkl: slice.pkl,
		sliceId: slice.id,
		source: state.mode === "raw" ? "raw" : "pkl",
		sourceJson: state.mode === "raw" ? state.rawCache : "",
		requested: keptRequestRows(),
		bboxes: bboxes,
		backupDir: path.join(state.runAbs, "adjust_backup"),
		adjustParams: path.join(state.runAbs, "adjust_params.json"),
		sliceParams: path.join(state.runAbs, "detect_slice_params.json"),
		params: sliderParams(),
	};
	var requestPath = path.join(state.runAbs, "adjust_pending.json");
	try {
		fs.writeFileSync(requestPath, JSON.stringify(request), "utf8");
	} catch (err) {
		state.pendingIndex = null;
		state.pendingRun = null;
		alert("Could not write the save request: " + (err.message || err));
		return;
	}
	setBusy(true);
	setProgress(0, "Saving " + slice.id + "…");
	ipc.send("runDetectAdjustApply", [requestPath]);
}

function confirmLeave() {
	if (!state.dirty) {
		return Promise.resolve("discard");
	}
	return dialogs
		.confirmThreeWay({
			title: "Unsaved section",
			message: "This section has slider changes that are not saved to the predictions file.",
			buttons: [
				{ id: "save", label: "Save", primary: true },
				{ id: "discard", label: "Discard" },
				{ id: "stay", label: "Stay" },
			],
		})
		.then(function (choice) {
			return choice || "stay";
		});
}

function goTo(index) {
	if (state.busy || index === state.index) {
		return;
	}
	confirmLeave().then(function (choice) {
		if (choice === "stay" || choice == null) {
			fillSliceSelect();
			return;
		}
		if (choice === "save") {
			state.pendingIndex = index;
			saveCurrent();
			return;
		}
		loadIndex(index);
	});
}

function rawCachePath(sliceId) {
	var manifest = state.manifest || {};
	var inputDir = manifest.input_dir || "";
	var rel = pipelineRuns.relFromRoleBase("max", inputDir) || path.basename(inputDir || "dataset");
	var modelPath = String(manifest.model || "");
	var base = path.basename(modelPath);
	var method = /ankou/i.test(base) ? "nuclei" : "somata";
	var custom = /chaosdruid|ankou/i.test(base) ? "" : modelPath;
	var token = detectCommon.modelBranchForSlug(method, custom);
	var tile = Number(manifest.tile) || detectParams.DEFAULT_TILE;
	var dir = path.join(
		project.getBundleRoot(),
		".masonjar",
		"detect_param_raw",
		pipelineRuns.sanitizeSlugPart(String(rel).replace(/[\\/]/g, "_")) || "dataset",
		token + "_t" + String(tile),
	);
	return {
		dir: dir,
		file: path.join(dir, (pipelineRuns.sanitizeSlugPart(sliceId) || "slice") + ".json"),
		method: custom ? "custom" : method,
		custom: custom,
		tile: tile,
		model: modelPath,
	};
}

function useRawCache(cacheAbs) {
	var data = readJson(cacheAbs);
	if (!Array.isArray(data.boxes)) {
		return false;
	}
	state.mode = "raw";
	state.rawCache = cacheAbs;
	state.boxes = data.boxes;
	state.minConfidence = detectParams.RAW_CONFIDENCE_FLOOR;
	state.displayScale = 1;
	state.fullW = Number(data.width) || 0;
	state.fullH = Number(data.height) || 0;
	var png = data.displayPath && fs.existsSync(data.displayPath) ? data.displayPath : "";
	if (!png) {
		png = cacheAbs.replace(/\.json$/i, "_display.png");
	}
	if (png && fs.existsSync(png)) {
		var token = ++previewToken;
		state.triedFit = true;
		showImage(token, png);
	}
	applyLoadedSliders();
	state.loadedPending = true;
	state.loadedFiltered = false;
	state.loadedCutoff = null;
	state.loadedReason = "";
	var status = qs("preprocessPreviewStatus");
	if (status) {
		status.textContent =
			"Raw detections loaded. Sliders can keep or drop any box from this liberal pass.";
	}
	requestLoadedCutoff(cacheAbs, 0, -1, -1);
	return true;
}

function loadRaw() {
	var slice = currentSlice();
	if (!slice || state.busy) {
		return;
	}
	var image = findImage(slice.id);
	if (!image) {
		alert("Could not find the source image for this section.");
		return;
	}
	var cache = rawCachePath(slice.id);
	if (fs.existsSync(cache.file) && useRawCache(cache.file)) {
		return;
	}
	try {
		fs.mkdirSync(cache.dir, { recursive: true });
	} catch (err) {
		alert("Could not create the raw-detection cache: " + (err.message || err));
		return;
	}
	state.rawCache = cache.file;
	state.rawRunning = true;
	setBusy(true);
	setProgress(0, "Running raw detection on " + slice.id + "…");
	ipc.send("runDetectRaw", [
		image,
		cache.method,
		cache.custom,
		cache.tile,
		cache.file,
		slice.id,
	]);
}

function revertSection() {
	var slice = currentSlice();
	if (!slice || state.busy) {
		return;
	}
	var backupDir = path.join(state.runAbs, "adjust_backup");
	var backupPkl = path.join(backupDir, path.basename(slice.pkl));
	if (!fs.existsSync(backupPkl)) {
		alert("This section has no saved original to restore.");
		return;
	}
	try {
		fs.copyFileSync(backupPkl, slice.pkl);
		var backupPng = path.join(backupDir, "BBoxes_" + slice.id + ".png");
		var livePng = path.join(state.runAbs, "BBoxes_" + slice.id + ".png");
		if (fs.existsSync(backupPng)) {
			fs.copyFileSync(backupPng, livePng);
		}
		var snap = readJson(path.join(backupDir, slice.id + ".params.json"));
		var adjustPath = path.join(state.runAbs, "adjust_params.json");
		var specPath = path.join(state.runAbs, "detect_slice_params.json");
		var adjust = readJson(adjustPath);
		if (!adjust.slices) {
			adjust.slices = {};
		}
		if (snap.hadAdjust) {
			adjust.slices[slice.id] = snap.adjust;
		} else {
			delete adjust.slices[slice.id];
		}
		fs.writeFileSync(adjustPath, JSON.stringify(adjust, null, 2), "utf8");
		var spec = readJson(specPath);
		if (!spec.slices) {
			spec.slices = {};
		}
		if (snap.hadSliceParams) {
			spec.slices[slice.id] = snap.sliceParams;
		} else {
			delete spec.slices[slice.id];
		}
		if (fs.existsSync(specPath) || snap.hadSliceParams) {
			fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");
		}
	} catch (err) {
		alert("Could not revert this section: " + (err.message || err));
		return;
	}
	loadIndex(state.index);
}

function wirePreview() {
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

ipc.on("updateLoad", function (_event, response) {
	if (!state.busy && !state.rawRunning) {
		return;
	}
	setProgress(response[0], response[1]);
});

ipc.on("detectAdjustPreviewResult", function (_event, payload) {
	if (!state.busy || state.rawRunning) {
		return;
	}
	if (!payload || !payload.ok) {
		state.loadedPending = false;
		state.loadedReason = "";
		setBusy(false);
		setProgress(0, (payload && payload.error) || "Could not load this section.");
		return;
	}
	var sliceId = currentSlice() ? currentSlice().id : "";
	state.displayScale = Number(payload.displayScale) > 0 ? Number(payload.displayScale) : 1;
	state.minConfidence = payload.minConfidence;
	state.fullW = Number(payload.fullWidth) || Number(payload.width) || 0;
	state.fullH = Number(payload.fullHeight) || Number(payload.height) || 0;
	var recordsPath = payload.recordsPath;
	setTimeout(function () {
		if (!currentSlice() || currentSlice().id !== sliceId) {
			return;
		}
		var data = readJson(recordsPath);
		state.boxes = data.boxes || [];
		state.recordsPath = recordsPath || "";
		state.loadedCutoff = Number(payload.loadedIntensityMin) > 0 ? Math.round(Number(payload.loadedIntensityMin)) : null;
		state.loadedReason = payload.loadedIntensityReason || (state.loadedCutoff ? "" : "unimodal");
		state.loadedCount = Number(payload.loadedIntensityCount) || state.boxes.length;
		state.loadedPending = false;
		state.loadedFiltered = false;
		state.estimatePending = false;
		applyLoadedSliders();
		if (payload.displayPath && fs.existsSync(payload.displayPath)) {
			var token = ++previewToken;
			showImage(token, payload.displayPath);
		} else {
			var status = qs("preprocessPreviewStatus");
			if (status) {
				status.textContent = "Detections were read, but the section image was not written.";
			}
		}
		setBusy(false);
		setProgress(100, sliceId + " ready.");
	}, 0);
});

ipc.on("detectIntensityEstimateResult", function (_event, payload) {
	var sliceId = currentSliceId();
	if (!state.estimatePending || !sliceId || sliceId !== state.estimateSlice) {
		return;
	}
	state.estimatePending = false;
	if (!payload || payload.ok === false || !payload.bimodal || payload.intensity_threshold_estimate == null) {
		state.loadedCutoff = null;
		state.loadedReason = (payload && payload.reason) || "unimodal";
		state.loadedCount = state.boxes.length;
	} else {
		state.loadedCutoff = Math.round(Number(payload.intensity_threshold_estimate));
		state.loadedReason = "";
		state.loadedCount = state.boxes.length;
	}
	state.loadedPending = false;
	renderThresholdHints();
});

function detectThresholdFromSliders() {
	var cache = state.mode === "raw" && state.rawCache ? state.rawCache : state.recordsPath;
	if (!cache) {
		return;
	}
	var p = sliderParams();
	state.loadedFiltered = true;
	requestLoadedCutoff(cache, p.confidence, p.area, p.eccentricity);
}

ipc.on("detectAdjustApplyResult", function (_event, payload) {
	setBusy(false);
	if (!payload || !payload.ok) {
		state.pendingIndex = null;
		setProgress(0, (payload && payload.error) || "Could not save this section.");
		return;
	}
	state.loadedParams = detectParams.normalizeParams(sliderParams());
	state.paramSource = "Loaded from an earlier adjustment on this section.";
	state.dirty = false;
	refreshDirty();
	var revert = qs("revertSection");
	if (revert) {
		revert.disabled = false;
	}
	setProgress(100, "Saved " + (payload.count != null ? payload.count : "") + " boxes.");
	if (state.pendingRun) {
		var nextRun = state.pendingRun;
		state.pendingRun = null;
		state.pendingIndex = null;
		loadRun(nextRun);
		return;
	}
	if (state.pendingIndex != null) {
		var next = state.pendingIndex;
		state.pendingIndex = null;
		loadIndex(next);
	}
});

ipc.on("detectRawResult", function (_event, payload) {
	if (!state.rawRunning) {
		return;
	}
	state.rawRunning = false;
	setBusy(false);
	if (!payload || !payload.ok) {
		setProgress(0, (payload && payload.error) || "Raw detection failed.");
		return;
	}
	if (state.rawCache && fs.existsSync(state.rawCache)) {
		useRawCache(state.rawCache);
		setProgress(100, "Raw detections ready.");
		return;
	}
	setProgress(0, "Raw detection finished, but the cache could not be read.");
});

projectIndexBusy.populatePage(function () {
	project.tryRestoreActiveProject();
	pipelineGate.assertPipelineAccess();
	wirePreview();
	["confidenceSlider", "areaSlider", "eccentricitySlider", "intensitySlider"].forEach(function (id) {
		var el = qs(id);
		if (el) {
			el.addEventListener("input", drawBoxes);
		}
	});
	var runs = qs("runSelect");
	if (runs) {
		runs.addEventListener("change", function () {
			confirmLeave().then(function (choice) {
				if (choice === "stay" || choice == null) {
					runs.value = state.runRel || "";
					return;
				}
				if (choice === "save") {
					state.pendingRun = runs.value;
					saveCurrent();
					return;
				}
				loadRun(runs.value);
			});
		});
	}
	var slices = qs("sliceSelect");
	if (slices) {
		slices.addEventListener("change", function () {
			goTo(Number(slices.value));
		});
	}
	var prev = qs("prevSection");
	if (prev) {
		prev.addEventListener("click", function () {
			if (state.index > 0) {
				goTo(state.index - 1);
			}
		});
	}
	var next = qs("nextSection");
	if (next) {
		next.addEventListener("click", function () {
			if (state.index < state.slices.length - 1) {
				goTo(state.index + 1);
			}
		});
	}
	var save = qs("savePkl");
	if (save) {
		save.addEventListener("click", saveCurrent);
	}
	var raw = qs("loadRaw");
	if (raw) {
		raw.addEventListener("click", function () {
			confirmLeave().then(function (choice) {
				if (choice === "stay" || choice == null) {
					return;
				}
				if (choice === "save") {
					saveCurrent();
					return;
				}
				loadRaw();
			});
		});
	}
	var revert = qs("revertSection");
	if (revert) {
		revert.addEventListener("click", revertSection);
	}
	var useScout = qs("useScoutCutoff");
	if (useScout) {
		useScout.addEventListener("click", function () {
			if (state.scoutHint && Number(state.scoutHint.intensity_min) > 0) {
				applyIntensityCutoff(state.scoutHint.intensity_min);
			}
		});
	}
	var useLoaded = qs("useLoadedCutoff");
	if (useLoaded) {
		useLoaded.addEventListener("click", function () {
			applyIntensityCutoff(state.loadedCutoff);
		});
	}
	var detectBtn = qs("detectThreshold");
	if (detectBtn) {
		detectBtn.addEventListener("click", detectThresholdFromSliders);
	}
	var cancel = qs("adjustCancel");
	if (cancel) {
		cancel.addEventListener("click", function () {
			if (state.rawRunning) {
				state.rawRunning = false;
				ipc.send("killDetectRaw");
			} else {
				ipc.send("killDetectAdjustPreview");
				ipc.send("killDetectAdjustApply");
			}
			state.pendingIndex = null;
			setBusy(false);
			setProgress(0, "Cancelled.");
		});
	}
	fillRuns();
});
