"use strict";

var fs = require("fs");
var path = require("path");
var url = require("url");
var childProcess = require("child_process");
var ipc = require("electron").ipcRenderer;
var branding = require("./branding");
var project = require("./project");
var pipelineRun = require("./pipeline_run");
var pipelineRuns = require("./pipeline_runs");
var maxDatasets = require("./max_datasets");
var cziImport = require("./czi_import");
var fileIndex = require("./file_index");
var homeDir = require("./home_dir");

var IDLE_PREVIEW_MS = 5000;
var DEFAULT_VIEW_W = 512;
var DEFAULT_VIEW_H = 512;
var TIFF_SLICE_RE = /\.(tif|tiff)$/i;

/** When false, param/pan/wheel/load never auto-schedule filter preview (manual button only). */
var AUTO_PREVIEW_ON_INTERACTION = false;

var PREVIEW_TARGET_SECONDS = 10;
/** Target full-res pixels for one preview ROI (~4 MP ≈ 2k×2k at 10 s on NAS). */
var PREVIEW_PIXEL_BUDGET = 4_000_000;
var PREVIEW_ZOOM_WARNING =
	"Filters cannot be previewed on this much tissue. Please zoom in to try again.";
var PREVIEW_READY_HINT =
	"Pan/zoom the image, adjust display levels, then click Preview filter.";

function fileUrlForPath(absPath) {
	if (!absPath) {
		return "";
	}
	try {
		return url.pathToFileURL(path.resolve(absPath)).href;
	} catch (_err) {
		return "file://" + String(absPath).replace(/\\/g, "/");
	}
}

/** Viewport ROI at preview click time; filter PNG is scaled to fill this rect. */
function resolveFilterDisplayRoi(state) {
	if (state.lastRoi && state.lastRoi.w > 0 && state.lastRoi.h > 0) {
		return state.lastRoi;
	}
	return state.lastFilterRoi;
}

function parsePreviewJsonLine(line) {
	var idx = String(line).indexOf("PREVIEW_JSON:");
	if (idx < 0) {
		return null;
	}
	try {
		return JSON.parse(String(line).slice(idx + "PREVIEW_JSON:".length));
	} catch (_err) {
		return null;
	}
}

function isProcessableTiffName(name) {
	var lower = name.toLowerCase();
	return TIFF_SLICE_RE.test(name) || lower.indexOf(".ome.") !== -1;
}

function listSliceImageFiles(leafAbs) {
	if (!leafAbs || !fs.existsSync(leafAbs)) {
		return [];
	}
	var out = [];
	try {
		var entries = fs.readdirSync(leafAbs, { withFileTypes: true });
		for (var i = 0; i < entries.length; i++) {
			if (entries[i].isFile() && isProcessableTiffName(entries[i].name)) {
				out.push({
					name: entries[i].name,
					abs: path.join(leafAbs, entries[i].name),
				});
			}
		}
	} catch (_err) {
		return [];
	}
	out.sort(function (a, b) {
		return a.name.localeCompare(b.name, undefined, { numeric: true });
	});
	return out;
}

function sliceStemFromName(name) {
	var base = path.basename(name);
	var dot = base.indexOf(".");
	return dot >= 0 ? base.slice(0, dot) : base;
}

function findSignalPreviewAbs(bundleRoot, sliceName, signalBranch) {
	if (!bundleRoot || !sliceName) {
		return "";
	}
	var sliceId = sliceStemFromName(sliceName);
	if (signalBranch) {
		var direct = path.join(
			bundleRoot,
			"data",
			"counting",
			"_previews",
			sliceId + "_" + signalBranch + ".png",
		);
		if (fs.existsSync(direct)) {
			return direct;
		}
		var proj = project.getProject();
		var czi = (proj && proj.settings && proj.settings.czi_import) || {};
		var resolved = cziImport.resolveOrientPreviewPath(
			bundleRoot,
			czi,
			null,
			sliceId,
			signalBranch,
		);
		if (resolved) {
			return resolved;
		}
	}
	return "";
}

/** @deprecated use findSignalPreviewAbs — kept for tests */
function findLowResPreviewAbs(bundleRoot, sliceName, signalBranch) {
	return findSignalPreviewAbs(bundleRoot, sliceName, signalBranch || "");
}

function scaleRoiForFullRes(roi, previewW, previewH, fullW, fullH) {
	if (!previewW || !previewH || !fullW || !fullH) {
		return roi;
	}
	if (previewW === fullW && previewH === fullH) {
		return roi;
	}
	var scaleX = fullW / previewW;
	var scaleY = fullH / previewH;
	return {
		x: Math.round(roi.x * scaleX),
		y: Math.round(roi.y * scaleY),
		w: Math.max(8, Math.round(roi.w * scaleX)),
		h: Math.max(8, Math.round(roi.h * scaleY)),
	};
}

function fitScaleToViewport(imgW, imgH, viewW, viewH) {
	if (!imgW || !imgH || !viewW || !viewH) {
		return 1;
	}
	return Math.min(viewW / imgW, viewH / imgH, 1);
}

function centerPanForFit(imgW, imgH, viewW, viewH, scale) {
	var dw = imgW * scale;
	var dh = imgH * scale;
	return {
		panX: (viewW - dw) / 2,
		panY: (viewH - dh) / 2,
	};
}

function fitViewportToDimensions(state, imgW, imgH) {
	var viewW = state.viewW || DEFAULT_VIEW_W;
	var viewH = state.viewH || DEFAULT_VIEW_H;
	state.scale = fitScaleToViewport(imgW, imgH, viewW, viewH);
	var pan = centerPanForFit(imgW, imgH, viewW, viewH, state.scale);
	state.panX = pan.panX;
	state.panY = pan.panY;
}

function fitViewportToImage(state) {
	fitViewportToDimensions(
		state,
		state.baseNaturalW || DEFAULT_VIEW_W,
		state.baseNaturalH || DEFAULT_VIEW_H,
	);
}

function computePreviewZoomPolicy(state) {
	var previewW = state.baseNaturalW || 0;
	var previewH = state.baseNaturalH || 0;
	var fullW = state.fullNaturalW || 0;
	var fullH = state.fullNaturalH || 0;
	var viewW = state.viewW || DEFAULT_VIEW_W;
	var viewH = state.viewH || DEFAULT_VIEW_H;
	var budget = PREVIEW_PIXEL_BUDGET;

	state.maxFullResPreviewPixels = budget;

	if (!previewW || !previewH || !fullW || !fullH) {
		state.previewScaleX = 1;
		state.previewScaleY = 1;
		state.minPreviewScale = 1;
		state.previewZoomHint = "";
		return;
	}

	var scaleX = fullW / previewW;
	var scaleY = fullH / previewH;
	state.previewScaleX = scaleX;
	state.previewScaleY = scaleY;

	var product = viewW * viewH * scaleX * scaleY;
	var minScale = Math.sqrt(product / budget);
	minScale = Math.max(0.1, Math.min(8, minScale));
	state.minPreviewScale = minScale;

	var currentScale = state.scale || 1;
	if (currentScale < minScale - 1e-6) {
		var zoomIn = minScale / currentScale;
		state.previewZoomHint =
			PREVIEW_ZOOM_WARNING + " (zoom in ~" + zoomIn.toFixed(1) + "×)";
	} else {
		state.previewZoomHint = "";
	}
}

function isPreviewZoomEligible(state) {
	if (!state.fullNaturalW || !state.fullNaturalH) {
		return false;
	}
	if (!state.minPreviewScale) {
		return true;
	}
	return (state.scale || 1) >= state.minPreviewScale - 1e-6;
}

function capFullResRoi(roi, budget) {
	var pixels = roi.w * roi.h;
	if (!budget || pixels <= budget) {
		return roi;
	}
	var scale = Math.sqrt(budget / pixels);
	var nw = Math.max(8, Math.floor(roi.w * scale));
	var nh = Math.max(8, Math.floor(roi.h * scale));
	if (nw > roi.w) {
		nw = roi.w;
	}
	if (nh > roi.h) {
		nh = roi.h;
	}
	return {
		x: roi.x + Math.floor((roi.w - nw) / 2),
		y: roi.y + Math.floor((roi.h - nh) / 2),
		w: nw,
		h: nh,
	};
}

/**
 * Resolve filter IPC target: WYSIWYG on displayed image (preview PNG) or scaled full TIFF.
 * @returns {{ ready: boolean, filterAbs?: string, roi?: object, reason?: string }}
 */
function resolvePreviewFilterRequest(state, roi, sourceSliceAbs) {
	var imgW = state.baseNaturalW;
	var imgH = state.baseNaturalH;

	if (!state.fullNaturalW || !state.fullNaturalH) {
		return { ready: false, reason: "waiting_for_dimensions" };
	}

	if (state.minPreviewScale && (state.scale || 1) < state.minPreviewScale - 1e-6) {
		return { ready: false, reason: "zoom_too_far" };
	}

	var scaled = scaleRoiForFullRes(
		roi,
		imgW,
		imgH,
		state.fullNaturalW,
		state.fullNaturalH,
	);
	scaled = capFullResRoi(
		scaled,
		state.maxFullResPreviewPixels || PREVIEW_PIXEL_BUDGET,
	);

	return {
		ready: true,
		filterAbs: sourceSliceAbs,
		roi: scaled,
		previewRoi: previewRoiFromFullRes(scaled, state),
	};
}

/**
 * Resolve preview IPC from base low-res view or 1:1 filter-native view (after first preview).
 * @param {object|null} filterBitmapRef - loaded filter image when state.showingFiltered
 */
function resolvePreviewRequest(state, filterBitmapRef, sourceSliceAbs) {
	var budget = state.maxFullResPreviewPixels || PREVIEW_PIXEL_BUDGET;

	if (
		state.showingFiltered &&
		filterBitmapRef &&
		state.lastFullResFilterRoi &&
		filterBitmapRef.width > 0 &&
		filterBitmapRef.height > 0
	) {
		var fw = filterBitmapRef.width;
		var fh = filterBitmapRef.height;
		var localRoi = viewportRoi(state, fw, fh);
		state.lastRoi = localRoi;
		var scaled = capFullResRoi(
			{
				x: state.lastFullResFilterRoi.x + localRoi.x,
				y: state.lastFullResFilterRoi.y + localRoi.y,
				w: localRoi.w,
				h: localRoi.h,
			},
			budget,
		);
		return {
			ready: true,
			filterAbs: sourceSliceAbs,
			roi: scaled,
			previewRoi: { x: 0, y: 0, w: scaled.w, h: scaled.h },
		};
	}

	if (!state.fullNaturalW || !state.fullNaturalH) {
		return { ready: false, reason: "waiting_for_dimensions" };
	}

	if (state.minPreviewScale && (state.scale || 1) < state.minPreviewScale - 1e-6) {
		return { ready: false, reason: "zoom_too_far" };
	}

	var imgW = state.baseNaturalW || DEFAULT_VIEW_W;
	var imgH = state.baseNaturalH || DEFAULT_VIEW_H;
	var roi = viewportRoi(state, imgW, imgH);
	state.lastRoi = roi;
	return resolvePreviewFilterRequest(state, roi, sourceSliceAbs);
}

function previewRoiFromFullRes(fullRoi, state) {
	var fullW = state.fullNaturalW || 0;
	var fullH = state.fullNaturalH || 0;
	var previewW = state.baseNaturalW || 0;
	var previewH = state.baseNaturalH || 0;
	if (!fullW || !fullH || !previewW || !previewH) {
		return fullRoi;
	}
	var sx = previewW / fullW;
	var sy = previewH / fullH;
	return {
		x: Math.round(fullRoi.x * sx),
		y: Math.round(fullRoi.y * sy),
		w: Math.max(1, Math.round(fullRoi.w * sx)),
		h: Math.max(1, Math.round(fullRoi.h * sy)),
	};
}

/** Keep the image point under (mx, my) fixed while changing scale (viewport coords). */
function applyCursorAnchoredZoom(state, mx, my, delta) {
	var scale = state.scale || 1;
	var imgX = (mx - (state.panX || 0)) / scale;
	var imgY = (my - (state.panY || 0)) / scale;
	var newScale = Math.min(8, Math.max(0.1, scale * delta));
	state.panX = mx - imgX * newScale;
	state.panY = my - imgY * newScale;
	state.scale = newScale;
}

function autoStretchImageDataIfFlat(imgData) {
	var data = imgData.data;
	var maxGray = 0;
	for (var i = 0; i < data.length; i += 4) {
		if (data[i] > maxGray) {
			maxGray = data[i];
		}
	}
	if (maxGray >= 32) {
		return imgData;
	}
	var minGray = 255;
	for (var j = 0; j < data.length; j += 4) {
		if (data[j] < minGray) {
			minGray = data[j];
		}
	}
	if (maxGray <= minGray) {
		return imgData;
	}
	var span = maxGray - minGray;
	for (var k = 0; k < data.length; k += 4) {
		var out = Math.round(((data[k] - minGray) / span) * 255);
		data[k] = out;
		data[k + 1] = out;
		data[k + 2] = out;
	}
	return imgData;
}

function applyDisplayWindow(imgData, minVal, maxVal) {
	var data = imgData.data;
	var lo = Math.max(0, Math.min(255, Number(minVal) || 0));
	var hi = Math.max(lo + 1, Math.min(255, Number(maxVal) || 255));
	var span = hi - lo;
	for (var i = 0; i < data.length; i += 4) {
		var gray = data[i];
		var out = Math.round(((gray - lo) / span) * 255);
		if (out < 0) {
			out = 0;
		}
		if (out > 255) {
			out = 255;
		}
		data[i] = out;
		data[i + 1] = out;
		data[i + 2] = out;
	}
	return imgData;
}

/** Replace ROI in base RGBA buffer with filter patch, then apply display min/max.
 *  filterImgData must already match roi.w × roi.h (scale full-res filter before calling). */
function bakeFilterIntoBaseImageData(
	baseImgData,
	filterImgData,
	roi,
	displayMin,
	displayMax,
) {
	var out = {
		data: new Uint8ClampedArray(baseImgData.data),
		width: baseImgData.width,
		height: baseImgData.height,
	};
	var bx = Math.max(0, Math.floor(roi.x));
	var by = Math.max(0, Math.floor(roi.y));
	var bw = Math.min(Math.floor(roi.w), filterImgData.width);
	var bh = Math.min(Math.floor(roi.h), filterImgData.height);
	if (bx + bw > out.width) {
		bw = out.width - bx;
	}
	if (by + bh > out.height) {
		bh = out.height - by;
	}
	for (var dy = 0; dy < bh; dy++) {
		for (var dx = 0; dx < bw; dx++) {
			var fIdx = (dy * filterImgData.width + dx) * 4;
			var bIdx = ((by + dy) * out.width + (bx + dx)) * 4;
			var gray = filterImgData.data[fIdx];
			out.data[bIdx] = gray;
			out.data[bIdx + 1] = gray;
			out.data[bIdx + 2] = gray;
			out.data[bIdx + 3] = 255;
		}
	}
	applyDisplayWindow(out, displayMin, displayMax);
	return out;
}

function viewportRoi(state, imgW, imgH) {
	var scale = state.scale || 1;
	var panX = state.panX || 0;
	var panY = state.panY || 0;
	var vpW = state.viewW || DEFAULT_VIEW_W;
	var vpH = state.viewH || DEFAULT_VIEW_H;
	var x0 = Math.max(0, Math.floor(-panX / scale));
	var y0 = Math.max(0, Math.floor(-panY / scale));
	var x1 = Math.min(imgW, Math.ceil((vpW - panX) / scale));
	var y1 = Math.min(imgH, Math.ceil((vpH - panY) / scale));
	var w = Math.max(32, x1 - x0);
	var h = Math.max(32, y1 - y0);
	if (x0 + w > imgW) {
		w = imgW - x0;
	}
	if (y0 + h > imgH) {
		h = imgH - y0;
	}
	return { x: x0, y: y0, w: w, h: h };
}

function shouldSchedulePreviewOnInteraction() {
	return AUTO_PREVIEW_ON_INTERACTION;
}

function resolveEnvPython() {
	var home = homeDir.masonHomePath();
	if (process.platform === "win32") {
		return path.join(home, "benv", "Scripts", "python.exe");
	}
	return path.join(home, "benv", "bin", "python3");
}

function lookupImageDimensionsFromIndex(absPath, bundleRoot) {
	if (!absPath || !bundleRoot) {
		return null;
	}
	var index = fileIndex.readFileIndex(
		bundleRoot,
		path.join(bundleRoot, branding.META_DIR),
	);
	if (!index || !index.files) {
		return null;
	}
	var target = path.normalize(absPath).toLowerCase();
	for (var i = 0; i < index.files.length; i++) {
		var row = index.files[i];
		if (!row.relPath) {
			continue;
		}
		var rowAbs = path.normalize(path.join(bundleRoot, row.relPath)).toLowerCase();
		if (rowAbs !== target) {
			continue;
		}
		var meta = row.metadata || {};
		if (meta.width && meta.height) {
			return { width: meta.width, height: meta.height };
		}
	}
	return null;
}

function probeImageDimensionsPy(absPath, cb) {
	var py = resolveEnvPython();
	var script = path.join(__dirname, "..", "py", "index_metadata.py");
	if (!fs.existsSync(py) || !fs.existsSync(script)) {
		cb(0, 0);
		return;
	}
	var chunks = [];
	var proc;
	try {
		proc = childProcess.spawn(py, [script, absPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (_err) {
		cb(0, 0);
		return;
	}
	proc.stdout.on("data", function (d) {
		chunks.push(d);
	});
	proc.on("close", function () {
		try {
			var parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]");
			var meta = (parsed[0] && parsed[0].metadata) || {};
			cb(meta.width || 0, meta.height || 0);
		} catch (_e) {
			cb(0, 0);
		}
	});
}

function loadFullResDimensions(absPath, cb) {
	if (!absPath) {
		cb(0, 0);
		return;
	}
	var root = project.isActive() ? project.getBundleRoot() : "";
	var fromIndex = lookupImageDimensionsFromIndex(absPath, root);
	if (fromIndex) {
		cb(fromIndex.width, fromIndex.height);
		return;
	}
	if (isProcessableTiffName(absPath)) {
		probeImageDimensionsPy(absPath, cb);
		return;
	}
	var fullImg = new Image();
	fullImg.onload = function () {
		cb(fullImg.naturalWidth, fullImg.naturalHeight);
	};
	fullImg.onerror = function () {
		cb(0, 0);
	};
	fullImg.src = fileUrlForPath(absPath) + "?t=" + Date.now();
}

/**
 * @param {object} opts
 * @param {string} opts.stepId - "tophat" | "sharpen"
 * @param {string} opts.sourceStorageKey
 * @param {string} opts.configFileName - e.g. tophat_run_config.json
 * @param {string} opts.runIpc
 * @param {string} opts.previewIpc
 * @param {string} opts.resultIpc
 * @param {string} opts.killRunIpc
 * @param {string} opts.killPreviewIpc
 * @param {function(): object} opts.getToolParams
 * @param {function(object, object): object} opts.buildSlugContext
 */
function wirePreprocessWizard(opts) {
	opts = opts || {};
	var stepId = opts.stepId;
	var state = {
		step: 1,
		signalBranch: "",
		sourceDataset: null,
		slices: [],
		currentSlice: null,
		baseAbs: "",
		baseNaturalW: 0,
		baseNaturalH: 0,
		fullNaturalW: 0,
		fullNaturalH: 0,
		showingFiltered: false,
		filteredBitmap: null,
		lastRoi: null,
		lastFilterRoi: null,
		lastFullResFilterRoi: null,
		scale: 1,
		panX: 0,
		panY: 0,
		viewW: DEFAULT_VIEW_W,
		viewH: DEFAULT_VIEW_H,
		displayMin: 0,
		displayMax: 255,
		previewBusy: false,
		running: false,
		lastRunRel: "",
	};

	var wizardSteps = document.getElementById("wizardSteps");
	var step1Panel = document.getElementById("step1");
	var step2Panel = document.getElementById("step2");
	var branchSelect = document.getElementById("signalBranchSelect");
	var sourceSelect = document.getElementById("sourceDatasetSelect");
	var sliceSelect = document.getElementById("sliceSelect");
	var branchRow = document.getElementById("signalBranchRow");
	var sourceRow = document.getElementById("sourceDatasetRow");
	var viewport = document.getElementById("preprocessPreviewViewport");
	var previewTransform = document.getElementById("preprocessPreviewTransform");
	var previewImg = document.getElementById("preprocessPreviewImg");
	var previewOverlay = document.getElementById("preprocessPreviewOverlay");
	var previewStatus = document.getElementById("preprocessPreviewStatus");
	var previewZoomWarning = document.getElementById("preprocessPreviewZoomWarning");
	var previewEqualizeNotice = document.getElementById("preprocessPreviewEqualizeNotice");
	var previewLoadingEl = document.getElementById("preprocessPreviewLoading");
	var previewProgressEl = document.getElementById("preprocessPreviewProgress");
	var previewProgressTextEl = document.getElementById("preprocessPreviewProgressText");
	var previewFilterBtn = document.getElementById("previewFilterBtn");
	var displayMinInput = document.getElementById("displayMin");
	var displayMaxInput = document.getElementById("displayMax");
	var autoRefreshAfterPan = document.getElementById("autoRefreshAfterPan");
	var step1Next = document.getElementById("step1Next");
	var step2Back = document.getElementById("step2Back");
	var step2Cancel = document.getElementById("step2Cancel");
	var processStart = document.getElementById("processStart");
	var wizardLog = document.getElementById("wizardLog");
	var processProgress = document.getElementById("processProgress");
	var processMessage = document.getElementById("processMessage");
	var setActiveCheckbox = document.getElementById("setActiveMax");
	var finishPanel = document.getElementById("finishPanel");
	var idlePreviewTimer = null;
	var baseBitmap = null;
	var filteredBitmap = null;
	var pendingPreviewAfterDims = false;
	var lastPreviewProgressPct = 0;

	function updatePreviewZoomWarning() {
		computePreviewZoomPolicy(state);
		var eligible = isPreviewZoomEligible(state) || state.showingFiltered;
		if (previewZoomWarning) {
			previewZoomWarning.classList.toggle("d-none", eligible);
			if (!eligible) {
				previewZoomWarning.textContent =
					state.previewZoomHint || PREVIEW_ZOOM_WARNING;
			}
		}
		if (previewFilterBtn) {
			previewFilterBtn.disabled =
				!eligible || state.previewBusy || state.running;
		}
		if (previewStatus && !state.previewBusy) {
			if (!eligible) {
				previewStatus.textContent =
					state.previewZoomHint || PREVIEW_ZOOM_WARNING;
			} else if (!state.showingFiltered) {
				previewStatus.textContent = PREVIEW_READY_HINT;
			}
		}
	}

	function showPreviewLoading(on) {
		if (previewLoadingEl) {
			previewLoadingEl.classList.toggle("d-none", !on);
		}
		if (viewport) {
			viewport.classList.toggle("preprocess-preview-loading-active", on);
		}
		if (on) {
			lastPreviewProgressPct = 0;
			if (previewProgressEl) {
				previewProgressEl.style.width = "0%";
			}
			if (previewProgressTextEl) {
				previewProgressTextEl.textContent = "0%";
			}
		}
	}

	pipelineRun.ensureRunModeUi("runModePanel", stepId);

	function bundleRoot() {
		return project.isActive() ? project.getBundleRoot() : "";
	}

	function savedSourceRel() {
		try {
			return sessionStorage.getItem(opts.sourceStorageKey) || "";
		} catch (_err) {
			return "";
		}
	}

	function persistSourceRel(rel) {
		try {
			sessionStorage.setItem(opts.sourceStorageKey, rel || "");
		} catch (_err) {}
	}

	function appendLog(line) {
		if (!wizardLog) {
			return;
		}
		wizardLog.textContent += line + "\n";
		wizardLog.scrollTop = wizardLog.scrollHeight;
	}

	function setStep(n) {
		state.step = n;
		if (step1Panel) {
			step1Panel.classList.toggle("d-none", n !== 1);
		}
		if (step2Panel) {
			step2Panel.classList.toggle("d-none", n !== 2);
		}
		if (finishPanel) {
			finishPanel.classList.toggle("d-none", n !== 3);
		}
		if (wizardSteps) {
			var pills = wizardSteps.querySelectorAll("[data-step]");
			for (var i = 0; i < pills.length; i++) {
				var pill = pills[i];
				var sn = Number(pill.getAttribute("data-step"));
				pill.classList.remove("active", "disabled");
				if (sn === n) {
					pill.classList.add("active");
				} else if (sn < n) {
					pill.classList.remove("disabled");
				} else {
					pill.classList.add("disabled");
				}
			}
		}
	}

	function readDisplayWindow() {
		if (displayMinInput) {
			state.displayMin = Math.max(0, Math.min(255, Number(displayMinInput.value) || 0));
		}
		if (displayMaxInput) {
			state.displayMax = Math.max(
				state.displayMin + 1,
				Math.min(255, Number(displayMaxInput.value) || 255),
			);
		}
	}

	function renderPreviewComposite() {
		if (!previewImg) {
			applyPanZoomCss();
			return;
		}
		readDisplayWindow();
		if (
			state.showingFiltered &&
			filteredBitmap &&
			filteredBitmap.width > 0 &&
			filteredBitmap.height > 0
		) {
			var fw = filteredBitmap.width;
			var fh = filteredBitmap.height;
			var fCanvas = document.createElement("canvas");
			fCanvas.width = fw;
			fCanvas.height = fh;
			var fCtx = fCanvas.getContext("2d");
			fCtx.imageSmoothingEnabled = false;
			fCtx.drawImage(filteredBitmap, 0, 0);
			var fData = fCtx.getImageData(0, 0, fw, fh);
			applyDisplayWindow(fData, state.displayMin, state.displayMax);
			fCtx.putImageData(fData, 0, 0);
			previewImg.src = fCanvas.toDataURL("image/png");
			if (previewOverlay) {
				previewOverlay.style.display = "none";
			}
			applyPanZoomCss();
			return;
		}
		if (!baseBitmap) {
			applyPanZoomCss();
			return;
		}
		var w = baseBitmap.width;
		var h = baseBitmap.height;
		var canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		var ctx = canvas.getContext("2d");
		ctx.drawImage(baseBitmap, 0, 0);
		var imgData = ctx.getImageData(0, 0, w, h);
		applyDisplayWindow(imgData, state.displayMin, state.displayMax);
		ctx.putImageData(imgData, 0, 0);
		previewImg.src = canvas.toDataURL("image/png");
		if (previewOverlay) {
			previewOverlay.style.display = "none";
		}
		applyPanZoomCss();
	}

	function updateEqualizeNotice(data) {
		if (!previewEqualizeNotice) {
			return;
		}
		if (data && data.equalizeSkipped) {
			previewEqualizeNotice.classList.remove("d-none");
		} else {
			previewEqualizeNotice.classList.add("d-none");
		}
	}

	function clearFilteredOverlay() {
		state.showingFiltered = false;
		state.filteredBitmap = null;
		state.lastFilterRoi = null;
		state.lastFullResFilterRoi = null;
		filteredBitmap = null;
		if (previewOverlay) {
			var ctx = previewOverlay.getContext("2d");
			ctx.clearRect(0, 0, previewOverlay.width, previewOverlay.height);
			previewOverlay.style.display = "none";
		}
		updateEqualizeNotice(null);
		if (baseBitmap) {
			fitViewportToImage(state);
			renderPreviewComposite();
		}
	}

	function loadBaseSliceImage() {
		if (!state.currentSlice || !previewImg) {
			return;
		}
		var root = bundleRoot();
		var lowRes = findSignalPreviewAbs(
			root,
			state.currentSlice.name,
			state.signalBranch,
		);
		state.baseAbs = lowRes || state.currentSlice.abs;
		clearFilteredOverlay();
		state.scale = 1;
		state.panX = 0;
		state.panY = 0;
		if (previewStatus) {
			previewStatus.textContent = PREVIEW_READY_HINT;
		}
		loadFullResDimensions(state.currentSlice.abs, function (fw, fh) {
			state.fullNaturalW = fw;
			state.fullNaturalH = fh;
			computePreviewZoomPolicy(state);
			updatePreviewZoomWarning();
			if (pendingPreviewAfterDims) {
				if (fw > 0 && fh > 0) {
					pendingPreviewAfterDims = false;
					requestPreview();
				} else if (previewStatus) {
					pendingPreviewAfterDims = false;
					previewStatus.textContent =
						"Could not read full-resolution image dimensions.";
				}
			}
		});
		var img = new Image();
		img.onload = function () {
			baseBitmap = img;
			state.baseNaturalW = img.naturalWidth;
			state.baseNaturalH = img.naturalHeight;
			applyPanZoomCss();
			computePreviewZoomPolicy(state);
			updatePreviewZoomWarning();
			renderPreviewComposite();
		};
		img.onerror = function () {
			if (previewStatus) {
				previewStatus.textContent = "Could not load slice image.";
			}
		};
		img.src = fileUrlForPath(state.baseAbs) + "?t=" + Date.now();
	}

	function cancelIdlePreview() {
		if (idlePreviewTimer) {
			clearTimeout(idlePreviewTimer);
			idlePreviewTimer = null;
		}
	}

	function scheduleIdlePreview() {
		cancelIdlePreview();
		if (!autoRefreshAfterPan || !autoRefreshAfterPan.checked) {
			return;
		}
		idlePreviewTimer = setTimeout(requestPreview, IDLE_PREVIEW_MS);
	}

	function refreshBranches() {
		var root = bundleRoot();
		var branches = root ? maxDatasets.listSignalBranches(root) : [];
		if (branchSelect) {
			branchSelect.innerHTML = "";
			if (branches.length <= 1) {
				if (branchRow) {
					branchRow.classList.add("d-none");
				}
				state.signalBranch = branches[0] || "";
			} else {
				if (branchRow) {
					branchRow.classList.remove("d-none");
				}
				for (var i = 0; i < branches.length; i++) {
					var opt = document.createElement("option");
					opt.value = branches[i];
					opt.textContent = branches[i];
					branchSelect.appendChild(opt);
				}
				state.signalBranch = branchSelect.value;
			}
		}
		refreshSourceDatasets();
	}

	function refreshSourceDatasets() {
		var root = bundleRoot();
		if (!root) {
			return;
		}
		var datasets = maxDatasets.listDatasetsForBranch(root, state.signalBranch);
		var def = maxDatasets.defaultDatasetForBranch(root, state.signalBranch, {
			preferKind: "max",
			savedRel: savedSourceRel(),
		});
		if (sourceSelect) {
			sourceSelect.innerHTML = "";
			for (var i = 0; i < datasets.length; i++) {
				var d = datasets[i];
				var opt = document.createElement("option");
				opt.value = d.rel;
				opt.textContent = d.label;
				sourceSelect.appendChild(opt);
			}
			if (sourceRow) {
				sourceRow.classList.remove("d-none");
			}
			if (sourceSelect) {
				sourceSelect.disabled = datasets.length <= 1;
			}
			var sourceHelp = document.getElementById("sourceDatasetHelp");
			if (sourceHelp) {
				if (datasets.length === 0) {
					sourceHelp.textContent = "No datasets found for this branch.";
				} else if (datasets.length === 1) {
					sourceHelp.textContent = "Only one dataset on this branch.";
				} else {
					sourceHelp.textContent = "";
				}
			}
			if (def) {
				sourceSelect.value = def.rel;
			}
		}
		onSourceChange();
	}

	function onSourceChange() {
		var root = bundleRoot();
		if (!root || !sourceSelect) {
			return;
		}
		var rel = sourceSelect.value;
		persistSourceRel(rel);
		var datasets = maxDatasets.listDatasetsForBranch(root, state.signalBranch);
		state.sourceDataset = null;
		for (var i = 0; i < datasets.length; i++) {
			if (datasets[i].rel === rel) {
				state.sourceDataset = datasets[i];
				break;
			}
		}
		state.slices = state.sourceDataset
			? listSliceImageFiles(state.sourceDataset.abs)
			: [];
		if (sliceSelect) {
			sliceSelect.innerHTML = "";
			for (var s = 0; s < state.slices.length; s++) {
				var o = document.createElement("option");
				o.value = String(s);
				o.textContent = state.slices[s].name;
				sliceSelect.appendChild(o);
			}
		}
		if (state.slices.length) {
			state.currentSlice = state.slices[0];
		} else {
			state.currentSlice = null;
		}
		cancelIdlePreview();
		loadBaseSliceImage();
	}

	function onSliceChange() {
		if (!sliceSelect || !state.slices.length) {
			return;
		}
		var idx = Number(sliceSelect.value) || 0;
		state.currentSlice = state.slices[idx] || state.slices[0];
		cancelIdlePreview();
		loadBaseSliceImage();
	}

	function applyPanZoomCss() {
		if (!previewTransform) {
			return;
		}
		previewTransform.style.transform =
			"translate(" +
			state.panX +
			"px," +
			state.panY +
			"px) scale(" +
			state.scale +
			")";
	}

	function clearFilterOnViewChange() {
		if (!state.showingFiltered) {
			return;
		}
		clearFilteredOverlay();
		if (!isPreviewZoomEligible(state)) {
			updatePreviewZoomWarning();
		} else if (previewStatus) {
			previewStatus.textContent =
				"Pan/zoom cleared filter preview — click Preview filter to refresh.";
		}
	}

	function sendPreviewIpc(resolved, previewPayload) {
		state.previewBusy = true;
		updateEqualizeNotice(null);
		showPreviewLoading(true);
		if (previewFilterBtn) {
			previewFilterBtn.disabled = true;
		}
		if (previewStatus) {
			previewStatus.textContent = "Updating preview…";
		}
		ipc.send(opts.previewIpc, [
			resolved.filterAbs,
			resolved.roi.x,
			resolved.roi.y,
			resolved.roi.w,
			resolved.roi.h,
			previewPayload,
		]);
	}

	function requestPreview() {
		cancelIdlePreview();
		if (!state.currentSlice || state.previewBusy || state.running) {
			return;
		}
		var params = opts.getToolParams();
		var resolved = resolvePreviewRequest(
			state,
			filteredBitmap,
			state.currentSlice.abs,
		);
		if (!resolved.ready) {
			if (resolved.reason === "zoom_too_far") {
				updatePreviewZoomWarning();
				return;
			}
			pendingPreviewAfterDims = true;
			if (previewStatus) {
				previewStatus.textContent = "Loading full image dimensions…";
			}
			return;
		}
		pendingPreviewAfterDims = false;
		state.lastFilterRoi = resolved.previewRoi || null;
		state.lastFullResFilterRoi = resolved.roi || null;
		var metaDir = bundleRoot()
			? path.join(bundleRoot(), branding.META_DIR)
			: path.dirname(state.currentSlice.abs);
		var previewPayload = {
			previewDir: metaDir,
		};
		if (stepId === "tophat") {
			previewPayload.radius = params.radius;
			previewPayload.gamma = params.gamma;
		} else {
			previewPayload.radius = params.radius;
			previewPayload.amount = params.amount;
			previewPayload.equalize = !!params.equalize;
		}
		sendPreviewIpc(resolved, previewPayload);
	}

	function wirePreviewPane() {
		if (!viewport || !previewImg) {
			return;
		}
		var rect = viewport.getBoundingClientRect();
		state.viewW = Math.max(200, Math.floor(rect.width) || DEFAULT_VIEW_W);
		state.viewH = Math.max(200, Math.floor(rect.height) || DEFAULT_VIEW_H);

		viewport.addEventListener(
			"wheel",
			function (ev) {
				ev.preventDefault();
				clearFilterOnViewChange();
				var rect = viewport.getBoundingClientRect();
				var mx = ev.clientX - rect.left;
				var my = ev.clientY - rect.top;
				var delta = ev.deltaY > 0 ? 0.9 : 1.1;
				applyCursorAnchoredZoom(state, mx, my, delta);
				applyPanZoomCss();
				updatePreviewZoomWarning();
			},
			{ passive: false },
		);

		var dragging = false;
		var lastX = 0;
		var lastY = 0;
		viewport.addEventListener("mousedown", function (ev) {
			clearFilterOnViewChange();
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
			applyPanZoomCss();
		});
		window.addEventListener("mouseup", function () {
			if (dragging) {
				updatePreviewZoomWarning();
				scheduleIdlePreview();
			}
			dragging = false;
		});
	}

	function intersectPlanWithSource(plan) {
		var sourceStems = pipelineRuns.listImageSliceStems(
			state.sourceDataset ? state.sourceDataset.abs : "",
		);
		var stemSet = {};
		for (var i = 0; i < sourceStems.length; i++) {
			stemSet[sourceStems[i]] = true;
		}
		var intersected = [];
		for (var j = 0; j < plan.toProcess.length; j++) {
			if (stemSet[plan.toProcess[j]]) {
				intersected.push(plan.toProcess[j]);
			}
		}
		return intersected;
	}

	function buildOutputPath(plan, intersected) {
		var root = bundleRoot();
		var outBase = maxDatasets.branchRootAbs(root, state.signalBranch);
		var srcMeta = maxDatasets.parseSourceRunRel(
			state.sourceDataset ? state.sourceDataset.rel : "",
			state.signalBranch,
		);
		var stems = pipelineRuns.listImageSliceStems(
			state.sourceDataset ? state.sourceDataset.abs : "",
		);
		var slugCtx = opts.buildSlugContext(
			{
				sortedStems: stems,
				subsetCount: intersected.length,
				sourceKind: srcMeta.source_kind,
				sourceRunRel: srcMeta.source_run_rel,
			},
			opts.getToolParams(),
		);
		var slug = pipelineRuns.buildRunSlug(stepId, slugCtx);
		var cfg = pipelineRuns.RUN_STEP_CONFIG[stepId];
		return {
			abs: pipelineRuns.resolveRunLeaf(outBase, cfg.branch, slug, false),
			slug: slug,
			srcMeta: srcMeta,
		};
	}

	function writeRunConfig(outInfo, intersected) {
		var root = bundleRoot();
		var meta = path.join(root, branding.META_DIR);
		fs.mkdirSync(meta, { recursive: true });
		var configPath = path.join(meta, opts.configFileName);
		var params = opts.getToolParams();
		var sliceListPath = "";
		if (intersected.length) {
			sliceListPath = require("./file_index").writeRunSliceList(meta, intersected);
		}
		var payload = {
			input_dir: state.sourceDataset.abs,
			output_dir: outInfo.abs,
			source_abs: state.sourceDataset.abs,
			output_abs: outInfo.abs,
			signal_branch: state.signalBranch || "",
			source_kind: outInfo.srcMeta.source_kind,
			source_run_rel: outInfo.srcMeta.source_run_rel,
			slice_list: sliceListPath,
		};
		if (stepId === "tophat") {
			payload.radius_px = params.radius;
			payload.gamma = params.gamma;
			payload.filter = params.radius;
			payload.correction = params.gamma;
		} else {
			payload.radius = params.radius;
			payload.amount = params.amount;
			payload.equalize = !!params.equalize;
		}
		fs.writeFileSync(configPath, JSON.stringify(payload, null, 2));
		return configPath;
	}

	function startProcess() {
		if (!state.sourceDataset || !state.sourceDataset.abs) {
			alert("Select a source dataset.");
			return;
		}
		if (!state.slices.length) {
			alert("No TIFF slices in the selected source dataset.");
			return;
		}
		var mode = pipelineRun.getSelectedRunMode(stepId);
		var plan = pipelineRun.preparePipelineRun(stepId, mode);
		var intersected = plan.toProcess;
		if (project.isActive()) {
			intersected = intersectPlanWithSource(plan);
			if (!intersected.length) {
				alert(
					"No slices from the project plan exist in the selected source dataset.",
				);
				return;
			}
		}
		if (project.isActive() && !plan.toProcess.length) {
			alert("No slices to process (subset empty or all filtered).");
			return;
		}
		var outInfo = buildOutputPath(plan, intersected);
		try {
			fs.mkdirSync(outInfo.abs, { recursive: true });
		} catch (err) {
			alert("Could not create output directory: " + (err.message || err));
			return;
		}
		var configPath = writeRunConfig(outInfo, intersected);
		state.lastRunRel = pipelineRuns.relFromRoleBase("max", outInfo.abs);
		state.running = true;
		if (wizardLog) {
			wizardLog.textContent = "";
		}
		appendLog("[Wizard] Output: " + outInfo.abs);
		appendLog("[Wizard] Config: " + configPath);
		if (processStart) {
			processStart.disabled = true;
		}
		if (step2Cancel) {
			step2Cancel.classList.remove("d-none");
		}
		ipc.send(opts.runIpc, [configPath]);
	}

	function onRunFinished(result) {
		state.running = false;
		if (processStart) {
			processStart.disabled = false;
		}
		if (step2Cancel) {
			step2Cancel.classList.add("d-none");
		}
		var ok = !result || result.ok !== false;
		if (!ok) {
			if (processProgress) {
				processProgress.style.width = "0%";
			}
			var msg =
				(result && result.message) ||
				"Processing failed. Check the Application log for details.";
			appendLog("[Wizard] Failed: " + msg);
		if (processMessage) {
			processMessage.textContent = msg;
		}
		alert(msg);
		return;
	}
	if (result && result.message) {
		appendLog("[Wizard] " + result.message);
		if (processMessage) {
			processMessage.textContent = result.message;
		}
	}
	if (processProgress) {
			processProgress.style.width = "100%";
		}
		if (setActiveCheckbox && setActiveCheckbox.checked && state.lastRunRel) {
			pipelineRuns.setActiveRunRel("max", state.lastRunRel);
		}
		if (project.isActive()) {
			project.refreshProjectIndex().catch(function () {});
		}
		setStep(3);
	}

	if (branchSelect) {
		branchSelect.addEventListener("change", function () {
			state.signalBranch = branchSelect.value;
			refreshSourceDatasets();
		});
	}
	if (sourceSelect) {
		sourceSelect.addEventListener("change", onSourceChange);
	}
	if (sliceSelect) {
		sliceSelect.addEventListener("change", onSliceChange);
	}
	if (previewFilterBtn) {
		previewFilterBtn.addEventListener("click", requestPreview);
	}
	if (displayMinInput) {
		displayMinInput.addEventListener("input", renderPreviewComposite);
	}
	if (displayMaxInput) {
		displayMaxInput.addEventListener("input", renderPreviewComposite);
	}
	if (step1Next) {
		step1Next.addEventListener("click", function () {
			if (!state.sourceDataset) {
				alert("No input dataset found for this branch.");
				return;
			}
			if (!state.slices.length) {
				alert("No TIFF slices in the selected source dataset.");
				return;
			}
			setStep(2);
		});
	}
	if (step2Back) {
		step2Back.addEventListener("click", function () {
			if (state.running) {
				return;
			}
			setStep(1);
		});
	}
	if (processStart) {
		processStart.addEventListener("click", startProcess);
	}
	if (step2Cancel) {
		step2Cancel.addEventListener("click", function () {
			if (state.running) {
				ipc.send(opts.killRunIpc, []);
			}
		});
	}

	var paramInputs = document.querySelectorAll("[data-preview-param]");
	for (var p = 0; p < paramInputs.length; p++) {
		paramInputs[p].addEventListener("input", function () {
			if (state.showingFiltered && previewStatus) {
				previewStatus.textContent =
					"Parameters changed — click Preview filter to refresh.";
			}
		});
	}

	var previewResultChannel =
		opts.previewResultIpc ||
		(opts.previewIpc === "runTophatPreview"
			? "tophatPreviewResult"
			: "sharpenPreviewResult");
	ipc.on(previewResultChannel, function (_ev, payload) {
		state.previewBusy = false;
		showPreviewLoading(false);
		var data = payload;
		if (typeof payload === "string") {
			data = parsePreviewJsonLine(payload);
		}
		if (!data || !data.ok) {
			if (previewStatus) {
				previewStatus.textContent = (data && data.error) || "Preview failed";
			}
			updatePreviewZoomWarning();
			return;
		}
		if (data.previewPath) {
			updateEqualizeNotice(data);
			var filt = new Image();
			filt.onload = function () {
				filteredBitmap = filt;
				state.filteredBitmap = filt;
				state.showingFiltered = true;
				fitViewportToDimensions(state, filt.naturalWidth, filt.naturalHeight);
				renderPreviewComposite();
				if (previewStatus) {
					previewStatus.textContent =
						"Filtered ROI (" +
						data.width +
						"x" +
						data.height +
						" px) - pan/zoom to refine, then Preview filter again";
				}
				updatePreviewZoomWarning();
			};
			filt.onerror = function () {
				state.showingFiltered = false;
				filteredBitmap = null;
				if (previewStatus) {
					previewStatus.textContent = "Could not load filtered preview.";
				}
				updatePreviewZoomWarning();
			};
			filt.src = fileUrlForPath(data.previewPath) + "?t=" + Date.now();
			return;
		}
		updatePreviewZoomWarning();
	});

	ipc.on(opts.resultIpc, function (_ev, result) {
		onRunFinished(result);
	});

	ipc.on("updateLoad", function (_ev, response) {
		if (state.step === 1 && state.previewBusy) {
			var previewPct = Number(response[0]) || 0;
			if (previewPct >= lastPreviewProgressPct) {
				lastPreviewProgressPct = previewPct;
				if (previewProgressEl) {
					previewProgressEl.style.width = String(previewPct) + "%";
				}
				var previewMsg = response[1] || "Preview...";
				if (previewProgressTextEl) {
					previewProgressTextEl.textContent =
						String(previewPct) + "% - " + previewMsg;
				}
			}
			return;
		}
		if (state.step !== 2) {
			return;
		}
		if (processProgress && response[0] != null) {
			processProgress.style.width = String(response[0]) + "%";
		}
		if (processMessage && response[1]) {
			processMessage.textContent = response[1];
			appendLog(response[1]);
		}
	});

	function ensurePreprocessNav() {
		var step1 = document.getElementById("step1");
		if (step1 && !document.getElementById("preprocessBackToMenu")) {
			var back = document.createElement("a");
			back.id = "preprocessBackToMenu";
			back.className = "btn btn-outline-secondary ms-2";
			back.href = "./menu_category.html?cat=preprocess";
			back.textContent = "Back to preprocessing";
			var nextBtn = document.getElementById("step1Next");
			if (nextBtn && nextBtn.parentNode) {
				nextBtn.parentNode.insertBefore(back, nextBtn.nextSibling);
			} else {
				step1.appendChild(back);
			}
		}
		if (!document.getElementById("sourceDatasetHelp") && sourceRow) {
			var help = document.createElement("p");
			help.id = "sourceDatasetHelp";
			help.className = "small text-muted mb-2";
			sourceRow.parentNode.insertBefore(help, sourceRow.nextSibling);
		}
		var finish = document.getElementById("finishPanel");
		if (finish && !document.getElementById("preprocessFinishBackToMenu")) {
			var finishBack = document.createElement("a");
			finishBack.id = "preprocessFinishBackToMenu";
			finishBack.className = "btn btn-outline-secondary ms-2";
			finishBack.href = "./menu_category.html?cat=preprocess";
			finishBack.textContent = "Back to preprocessing";
			finish.appendChild(finishBack);
		}
	}

	wirePreviewPane();
	ensurePreprocessNav();
	refreshBranches();
	setStep(1);

	return {
		state: state,
		requestPreview: requestPreview,
		refreshBranches: refreshBranches,
		loadBaseSliceImage: loadBaseSliceImage,
	};
}

module.exports = {
	wirePreprocessWizard: wirePreprocessWizard,
	viewportRoi: viewportRoi,
	parsePreviewJsonLine: parsePreviewJsonLine,
	listSliceImageFiles: listSliceImageFiles,
	applyDisplayWindow: applyDisplayWindow,
	fileUrlForPath: fileUrlForPath,
	resolveFilterDisplayRoi: resolveFilterDisplayRoi,
	bakeFilterIntoBaseImageData: bakeFilterIntoBaseImageData,
	shouldSchedulePreviewOnInteraction: shouldSchedulePreviewOnInteraction,
	findSignalPreviewAbs: findSignalPreviewAbs,
	findLowResPreviewAbs: findLowResPreviewAbs,
	scaleRoiForFullRes: scaleRoiForFullRes,
	fitScaleToViewport: fitScaleToViewport,
	centerPanForFit: centerPanForFit,
	fitViewportToImage: fitViewportToImage,
	fitViewportToDimensions: fitViewportToDimensions,
	resolvePreviewFilterRequest: resolvePreviewFilterRequest,
	resolvePreviewRequest: resolvePreviewRequest,
	computePreviewZoomPolicy: computePreviewZoomPolicy,
	isPreviewZoomEligible: isPreviewZoomEligible,
	capFullResRoi: capFullResRoi,
	previewRoiFromFullRes: previewRoiFromFullRes,
	applyCursorAnchoredZoom: applyCursorAnchoredZoom,
	PREVIEW_PIXEL_BUDGET: PREVIEW_PIXEL_BUDGET,
	PREVIEW_ZOOM_WARNING: PREVIEW_ZOOM_WARNING,
	isProcessableTiffName: isProcessableTiffName,
	autoStretchImageDataIfFlat: autoStretchImageDataIfFlat,
};
