"use strict";

var fs = require("fs");
var path = require("path");
var ipc = require("electron").ipcRenderer;
var branding = require("./branding");
var project = require("./project");
var fileIndex = require("./file_index");
var cziImport = require("./czi_import");
var tissuePaths = require("../js/bundle_slice_paths");
var canvasMod = require("./tissue_cleanup_canvas");

project.tryRestoreActiveProject();

var VERSION = "1";
var DRAFT_DIR = "tissue_cleanup_draft";
var APPLY_CONFIG = "tissue_cleanup_apply_config.json";

var state = {
	step: 1,
	sliceIds: [],
	currentIndex: 0,
	slices: {},
	running: false,
};

var wizardSteps = document.getElementById("wizardSteps");
var step1 = document.getElementById("step1");
var step2 = document.getElementById("step2");
var step3 = document.getElementById("step3");
var step4 = document.getElementById("step4");
var sliceCounter = document.getElementById("sliceCounter");
var sliceIdLabel = document.getElementById("sliceIdLabel");
var canvasStatus = document.getElementById("canvasStatus");
var confirmHeadline = document.getElementById("confirmHeadline");
var confirmFileCount = document.getElementById("confirmFileCount");
var confirmTableBody = document.getElementById("confirmTableBody");
var applyProgress = document.getElementById("applyProgress");
var applyMessage = document.getElementById("applyMessage");
var wizardLog = document.getElementById("wizardLog");
var summaryPanel = document.getElementById("summaryPanel");

var tracePointCountEl = document.getElementById("tracePointCount");
var traceDoneBtn = document.getElementById("traceDoneBtn");

function updateTraceUi(pointCount) {
	if (tracePointCountEl) {
		tracePointCountEl.textContent =
			pointCount > 0 ? pointCount + " point(s) placed" : "";
	}
	if (traceDoneBtn) {
		traceDoneBtn.disabled = pointCount < 2;
	}
}

var canvas = canvasMod.createTissueCleanupCanvas({
	canvas: document.getElementById("tissueCanvas"),
	viewport: document.getElementById("tissueCanvasViewport"),
	onTraceChange: updateTraceUi,
	onOrphansPruned: function (n) {
		if (canvasStatus && n > 0) {
			canvasStatus.textContent =
				"Removed " + n + " stray pixel(s) after erasing.";
		}
	},
	onMaskEdited: function (method) {
		markSliceEdited(method);
		persistCurrentSlice();
	},
});

function edgeShrinkPx() {
	var el = document.getElementById("edgeShrinkPx");
	return el ? Math.max(0, Math.min(5, Number(el.value) || 2)) : 2;
}

function bundleRoot() {
	return project.isActive() ? project.getBundleRoot() : "";
}

function metaDir() {
	return path.join(bundleRoot(), branding.META_DIR);
}

function draftDir() {
	return path.join(metaDir(), DRAFT_DIR);
}

function draftStatePath() {
	return path.join(draftDir(), "state.json");
}

function maskPathForSlice(sliceId) {
	return path.join(draftDir(), "masks", sliceId + ".png");
}

function fileUrl(absPath) {
	return "file://" + absPath.split(path.sep).join("/");
}

function defaultSliceMeta() {
	return { method: "untouched", edited: false };
}

function loadCziCfg() {
	var root = bundleRoot();
	if (!root) {
		return {};
	}
	var pj = project.readProjectJson(root);
	var czi = (pj.settings && pj.settings.czi_import) || {};
	return czi;
}

function listSliceIds() {
	var root = bundleRoot();
	if (!root) {
		return [];
	}
	var dapiDir = path.join(root, "data/counting/00_dapi");
	if (!fs.existsSync(dapiDir)) {
		return [];
	}
	var ids = [];
	var entries = fs.readdirSync(dapiDir);
	for (var i = 0; i < entries.length; i++) {
		if (/\.png$/i.test(entries[i])) {
			ids.push(entries[i].replace(/\.png$/i, ""));
		}
	}
	ids.sort(function (a, b) {
		return a.localeCompare(b, undefined, { numeric: true });
	});
	var pj = project.readProjectJson(root);
	var index = fileIndex.readFileIndex(root, metaDir());
	var report = fileIndex.computeMatchReport(index, fileIndex.INPUT_MATCH_ROLES);
	return fileIndex.getProcessingSliceIds(root, pj, index, report, {
		stepId: "tissue_cleanup",
	}).filter(function (sid) {
		return ids.indexOf(sid) >= 0;
	});
}

function previewPathForSlice(sliceId) {
	var root = bundleRoot();
	var orient = cziImport.orientDapiPreviewPath(root, sliceId);
	if (fs.existsSync(orient)) {
		return orient;
	}
	var pipeline = cziImport.dapiPreviewPath(root, sliceId);
	if (fs.existsSync(pipeline)) {
		return pipeline;
	}
	return "";
}

function ensureDraftDirs() {
	fs.mkdirSync(path.join(draftDir(), "masks"), { recursive: true });
}

function readDraftState() {
	try {
		var raw = fs.readFileSync(draftStatePath(), "utf8");
		return JSON.parse(raw);
	} catch (_err) {
		return null;
	}
}

function writeDraftState() {
	ensureDraftDirs();
	var payload = {
		version: VERSION,
		slice_order: state.sliceIds,
		current_index: state.currentIndex,
		slices: state.slices,
	};
	fs.writeFileSync(draftStatePath(), JSON.stringify(payload, null, 2));
}

function persistCurrentSlice() {
	var sliceId = state.sliceIds[state.currentIndex];
	if (!sliceId) {
		return;
	}
	ensureDraftDirs();
	canvas.exportMaskPngPath(fs, path, maskPathForSlice(sliceId));
	var meta = state.slices[sliceId] || defaultSliceMeta();
	meta.edited = !canvas.maskIsAllKeep();
	state.slices[sliceId] = meta;
	writeDraftState();
}

function setStep(n) {
	state.step = n;
	if (step1) {
		step1.classList.toggle("d-none", n !== 1);
	}
	if (step2) {
		step2.classList.toggle("d-none", n !== 2);
	}
	if (step3) {
		step3.classList.toggle("d-none", n !== 3);
	}
	if (step4) {
		step4.classList.toggle("d-none", n !== 4);
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

function currentSliceId() {
	return state.sliceIds[state.currentIndex] || "";
}

function updateSliceUi() {
	var total = state.sliceIds.length;
	var idx = state.currentIndex;
	if (sliceCounter) {
		sliceCounter.textContent =
			"Section " + (total ? idx + 1 : 0) + " / " + total;
	}
	if (sliceIdLabel) {
		sliceIdLabel.textContent = currentSliceId();
	}
}

function appendLog(line) {
	if (!wizardLog) {
		return;
	}
	wizardLog.textContent += line + "\n";
	wizardLog.scrollTop = wizardLog.scrollHeight;
}

function markSliceEdited(method) {
	var sliceId = currentSliceId();
	if (!sliceId) {
		return;
	}
	var meta = state.slices[sliceId] || defaultSliceMeta();
	if (meta.method === "untouched") {
		meta.method = method;
	} else if (meta.method !== method) {
		meta.method = "mixed";
	}
	meta.edited = !canvas.maskIsAllKeep();
	state.slices[sliceId] = meta;
}

async function loadCurrentSlice() {
	var sliceId = currentSliceId();
	if (!sliceId) {
		if (canvasStatus) {
			canvasStatus.textContent = "No sections with DAPI previews.";
		}
		return;
	}
	var preview = previewPathForSlice(sliceId);
	if (!preview) {
		if (canvasStatus) {
			canvasStatus.textContent = "No preview for " + sliceId;
		}
		return;
	}
	canvas.setMode("idle");
	if (canvasStatus) {
		canvasStatus.textContent = "Loading " + path.basename(preview) + "…";
	}
	await canvas.loadImageUrl(fileUrl(preview) + "?t=" + Date.now());
	await canvas.loadMaskFromFile(fs, path, maskPathForSlice(sliceId));
	if (!state.slices[sliceId]) {
		state.slices[sliceId] = defaultSliceMeta();
	}
	var meta = state.slices[sliceId];
	var hasMaskFile = fs.existsSync(maskPathForSlice(sliceId));
	canvas.setSliceUntouched(meta.method === "untouched");
	canvas.setMaskVisible(hasMaskFile && meta.method !== "untouched");
	if (canvasStatus) {
		canvasStatus.textContent =
			meta.method === "untouched" && !hasMaskFile
				? "Green = keep; red = remove (overlay appears after you edit the mask)."
				: preview;
	}
	updateSliceUi();
	writeDraftState();
}

function goSlice(delta) {
	persistCurrentSlice();
	state.currentIndex = Math.max(
		0,
		Math.min(state.sliceIds.length - 1, state.currentIndex + delta),
	);
	loadCurrentSlice().catch(function (err) {
		console.error(err);
	});
}

function resetCurrentSlice() {
	var sliceId = currentSliceId();
	if (!sliceId) {
		return;
	}
	canvas.pushUndo();
	canvas.resetMaskAllKeep();
	try {
		fs.unlinkSync(maskPathForSlice(sliceId));
	} catch (_err) {}
	state.slices[sliceId] = defaultSliceMeta();
	var preview = previewPathForSlice(sliceId);
	if (preview) {
		canvas.loadImageUrl(fileUrl(preview) + "?r=" + Date.now()).catch(console.error);
	}
	writeDraftState();
}

function maskOutputPath() {
	return path.join(draftDir(), "_auto_mask.png");
}

function runAutoMask() {
	var sliceId = currentSliceId();
	var preview = previewPathForSlice(sliceId);
	if (!preview || state.running) {
		return;
	}
	state.running = true;
	if (canvasStatus) {
		canvasStatus.textContent = "Running auto tissue mask…";
	}
	ipc.send("runTissueCleanupAuto", [
		preview,
		maskOutputPath(),
		edgeShrinkPx(),
	]);
}

function runGuidedMask(strokePoints) {
	var sliceId = currentSliceId();
	var preview = previewPathForSlice(sliceId);
	if (!preview || !strokePoints.length || state.running) {
		return;
	}
	if (strokePoints.length < 2) {
		if (canvasStatus) {
			canvasStatus.textContent = "Place at least two trace points.";
		}
		return;
	}
	var strokePath = path.join(draftDir(), "_stroke.json");
	var jsonPts =
		typeof strokePoints[0] === "number" || Array.isArray(strokePoints[0])
			? strokePoints
			: canvas.getTracePointsForJson();
	fs.writeFileSync(strokePath, JSON.stringify(jsonPts));
	state.running = true;
	if (canvasStatus) {
		canvasStatus.textContent = "Running trace-guided mask…";
	}
	ipc.send("runTissueCleanupGuided", [
		preview,
		maskOutputPath(),
		strokePath,
		edgeShrinkPx(),
	]);
}

function buildConfirmTable() {
	if (!confirmTableBody) {
		return { edited: 0, files: 0 };
	}
	confirmTableBody.innerHTML = "";
	var cfg = loadCziCfg();
	var edited = 0;
	var files = 0;
	for (var i = 0; i < state.sliceIds.length; i++) {
		var sliceId = state.sliceIds[i];
		var meta = state.slices[sliceId] || defaultSliceMeta();
		var maskPath = maskPathForSlice(sliceId);
		var unchanged = !fs.existsSync(maskPath) || meta.method === "untouched";
		if (meta.edited && !unchanged) {
			edited += 1;
			var count = tissuePaths.pathsForSlice(bundleRoot(), sliceId, cfg).length;
			files += count;
		}
		var tr = document.createElement("tr");
		var status = unchanged ? "unchanged" : meta.edited ? "will apply" : "unchanged";
		if (!previewPathForSlice(sliceId)) {
			status = "no preview";
		}
		tr.innerHTML =
			"<td>" +
			sliceId +
			"</td><td>" +
			meta.method +
			"</td><td>" +
			(status === "will apply"
				? String(tissuePaths.pathsForSlice(bundleRoot(), sliceId, cfg).length)
				: "—") +
			"</td><td>" +
			status +
			"</td>";
		confirmTableBody.appendChild(tr);
	}
	return { edited: edited, files: files, total: state.sliceIds.length };
}

function writeApplyConfig() {
	var root = bundleRoot();
	var cfg = loadCziCfg();
	var slices = {};
	for (var i = 0; i < state.sliceIds.length; i++) {
		var sliceId = state.sliceIds[i];
		var meta = state.slices[sliceId] || defaultSliceMeta();
		if (!meta.edited) {
			continue;
		}
		var mp = maskPathForSlice(sliceId);
		if (!fs.existsSync(mp)) {
			continue;
		}
		slices[sliceId] = { mask_path: mp, method: meta.method };
	}
	var payload = {
		bundle_root: root,
		czi_config: path.join(metaDir(), "czi_import_config.json"),
		slices: slices,
		dry_run: false,
	};
	var out = path.join(metaDir(), APPLY_CONFIG);
	fs.writeFileSync(out, JSON.stringify(payload, null, 2));
	return out;
}

function runApply() {
	if (state.running) {
		return;
	}
	state.running = true;
	var configPath = writeApplyConfig();
	if (wizardLog) {
		wizardLog.textContent = "";
	}
	appendLog("[TissueCleanup] Applying masks…");
	setStep(3);
	var cancelBtn = document.getElementById("applyCancel");
	if (cancelBtn) {
		cancelBtn.classList.remove("d-none");
	}
	ipc.send("runTissueCleanupApply", [bundleRoot(), configPath]);
}

function finishApply(result) {
	state.running = false;
	var cancelBtn = document.getElementById("applyCancel");
	if (cancelBtn) {
		cancelBtn.classList.add("d-none");
	}
	if (result && result.ok) {
		var root = bundleRoot();
		var pj = project.readProjectJson(root);
		pj.processing = pj.processing || project.defaultProcessing();
		pj.processing.tissue_cleanup = {
			applied_at: new Date().toISOString(),
			version: VERSION,
			slices: result.slices || {},
		};
		project.saveProjectJson(root, pj);
		project.refreshProjectIndex(root).catch(function (err) {
			console.warn("[TissueCleanup] refreshProjectIndex:", err);
		});
		try {
			fs.rmSync(draftDir(), { recursive: true, force: true });
		} catch (_err) {}
	}
	setStep(4);
	if (summaryPanel) {
		if (result && result.ok) {
			summaryPanel.innerHTML =
				"<p class=\"text-success fw-semibold\">Tissue edge cleanup applied.</p>" +
				"<p>Files updated: <strong>" +
				String(result.applied_files || 0) +
				"</strong>. Slices: <strong>" +
				String(result.slices_applied || 0) +
				"</strong>.</p>";
		} else {
			summaryPanel.innerHTML =
				"<p class=\"text-danger fw-semibold\">Apply failed.</p><pre class=\"small\">" +
				(result && result.error ? result.error : "Unknown error") +
				"</pre>";
		}
	}
}

function init() {
	var root = bundleRoot();
	if (!root) {
		alert("Open a project bundle first.");
		window.location.href = "./workspace_menu.html";
		return;
	}
	state.sliceIds = listSliceIds();
	for (var i = 0; i < state.sliceIds.length; i++) {
		var sid = state.sliceIds[i];
		if (!state.slices[sid]) {
			state.slices[sid] = defaultSliceMeta();
		}
	}
	var draft = readDraftState();
	var proc = project.readProjectJson(root).processing || {};
	if (draft && !proc.tissue_cleanup) {
		state.sliceIds = draft.slice_order || state.sliceIds;
		state.currentIndex = draft.current_index || 0;
		state.slices = draft.slices || state.slices;
	}
	if (!state.sliceIds.length) {
		alert("No DAPI PNG sections found under 00_dapi.");
	}
	updateSliceUi();
	loadCurrentSlice().catch(console.error);
}

ipc.on("tissueCleanupAutoResult", function (_ev, payload) {
	state.running = false;
	if (!payload || !payload.ok) {
		if (canvasStatus) {
			canvasStatus.textContent =
				(payload && payload.error) || "Auto mask failed";
		}
		return;
	}
	canvas.setMaskVisible(true);
	canvas.setSliceUntouched(false);
	if (payload.maskBase64) {
		canvas.loadMaskFromBase64(payload.maskBase64).then(function () {
			markSliceEdited("auto");
			persistCurrentSlice();
		});
	} else if (payload.maskPath && fs.existsSync(payload.maskPath)) {
		canvas.loadMaskFromFile(fs, path, payload.maskPath).then(function () {
			markSliceEdited("auto");
			persistCurrentSlice();
		});
	}
	if (canvasStatus) {
		canvasStatus.textContent =
			"Green = keep; red = remove. Use Eraser to paint red remove regions.";
	}
});

ipc.on("tissueCleanupGuidedResult", function (_ev, payload) {
	state.running = false;
	canvas.clearTrace();
	canvas.setMode("idle");
	updateTraceUi(0);
	var traceAutoBtn = document.getElementById("traceAutoBtn");
	if (traceDoneBtn) {
		traceDoneBtn.classList.add("d-none");
		traceDoneBtn.disabled = true;
	}
	if (traceAutoBtn) {
		traceAutoBtn.classList.remove("d-none");
	}
	if (!payload || !payload.ok) {
		if (canvasStatus) {
			canvasStatus.textContent =
				(payload && payload.error) || "Guided mask failed";
		}
		return;
	}
	var done = payload.maskBase64
		? canvas.loadMaskFromBase64(payload.maskBase64)
		: canvas.loadMaskFromFile(fs, path, payload.maskPath);
	canvas.setMaskVisible(true);
	canvas.setSliceUntouched(false);
	Promise.resolve(done).then(function () {
		markSliceEdited("trace_auto");
		persistCurrentSlice();
		if (canvasStatus) {
			canvasStatus.textContent =
				"Green = keep; red = remove. Trace-guided mask applied.";
		}
	});
});

ipc.on("tissueCleanupApplyResult", function (_ev, payload) {
	finishApply(payload || { ok: false, error: "No result" });
});

ipc.on("updateLoad", function (_ev, data) {
	if (state.step !== 3) {
		return;
	}
	var pct = data[0];
	var msg = data[1] || "";
	if (applyProgress) {
		applyProgress.style.width = String(pct) + "%";
	}
	if (applyMessage) {
		applyMessage.textContent = msg;
	}
	appendLog(msg);
});

document.getElementById("prevSliceBtn").addEventListener("click", function () {
	goSlice(-1);
});
document.getElementById("nextSliceBtn").addEventListener("click", function () {
	goSlice(1);
});
document.getElementById("attemptAutoBtn").addEventListener("click", runAutoMask);
document.getElementById("traceAutoBtn").addEventListener("click", function () {
	canvas.clearTrace();
	canvas.setMode("trace");
	document.getElementById("traceAutoBtn").classList.add("d-none");
	if (traceDoneBtn) {
		traceDoneBtn.classList.remove("d-none");
		traceDoneBtn.disabled = true;
	}
	updateTraceUi(0);
	if (canvasStatus) {
		canvasStatus.textContent =
			"Click on the image to place points along the tissue edge. Click Done tracing when finished.";
	}
});
if (traceDoneBtn) {
	traceDoneBtn.addEventListener("click", function () {
		runGuidedMask(canvas.getTracePointsForJson());
	});
}
function syncBrushButtons() {
	var eraserBtn = document.getElementById("eraserBtn");
	var keepBtn = document.getElementById("keepBrushBtn");
	if (eraserBtn) {
		eraserBtn.classList.toggle("active", canvas.state.mode === "erase");
	}
	if (keepBtn) {
		keepBtn.classList.toggle("active", canvas.state.mode === "keep");
	}
}
document.getElementById("eraserBtn").addEventListener("click", function () {
	var next = canvas.state.mode === "erase" ? "idle" : "erase";
	canvas.setMode(next);
	syncBrushButtons();
	if (canvasStatus && next === "erase") {
		canvasStatus.textContent =
			"Paint over areas to REMOVE (shown in red). Stray pixels are cleaned when you release the mouse.";
	}
});
var keepBrushBtn = document.getElementById("keepBrushBtn");
if (keepBrushBtn) {
	keepBrushBtn.addEventListener("click", function () {
		var next = canvas.state.mode === "keep" ? "idle" : "keep";
		canvas.setMode(next);
		syncBrushButtons();
		if (canvasStatus && next === "keep") {
			canvasStatus.textContent =
				"Paint to KEEP tissue (shown in green). Use this to recover real tissue trimmed too aggressively at the edges.";
		}
	});
}
document.getElementById("eraserSize").addEventListener("input", function (ev) {
	canvas.setEraserSize(Number(ev.target.value) || 16);
});
document.getElementById("resetSliceBtn").addEventListener("click", resetCurrentSlice);
document.getElementById("undoBtn").addEventListener("click", function () {
	if (canvas.undo()) {
		markSliceEdited("eraser");
	}
});
document.getElementById("step1Next").addEventListener("click", function () {
	persistCurrentSlice();
	var stats = buildConfirmTable();
	if (confirmHeadline) {
		confirmHeadline.textContent =
			"You edited " +
			stats.edited +
			" of " +
			stats.total +
			" sections.";
	}
	if (confirmFileCount) {
		confirmFileCount.textContent =
			"Apply will modify an estimated " +
			stats.files +
			" files across DAPI previews, orient previews, z-stacks, and max/sharpen/top-hat TIFFs.";
	}
	setStep(2);
});
document.getElementById("step2Back").addEventListener("click", function () {
	setStep(1);
});
document.getElementById("step2Apply").addEventListener("click", runApply);
document.getElementById("applyCancel").addEventListener("click", function () {
	ipc.send("killTissueCleanup");
});

window.addEventListener("resize", function () {
	canvas.fitToViewport();
});

init();
