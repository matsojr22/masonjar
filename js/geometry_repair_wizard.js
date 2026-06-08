"use strict";

var fs = require("fs");
var path = require("path");
var url = require("url");
var ipc = require("electron").ipcRenderer;

var pageInit = require("./page_init");
var navTrail = require("./nav_trail");
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var cziImport = require("./czi_import");
var orientGeometry = require("./orient_geometry");
var geometryState = require("./geometry_state");
var branding = require("./branding");

project.tryRestoreActiveProject();
pipelineGate.assertPipelineAccess();

var LOG_MAX = 800;
var state = {
	bundleRoot: "",
	cziImport: null,
	sliceIds: [],
	applyState: null,
	queue: null,
	reviewIndex: 0,
	reviewOps: null,
	auditRunning: false,
	repairRunning: false,
};

function qs(id) {
	return document.getElementById(id);
}

function setStep(step) {
	var panels = ["step0", "step1", "step2", "step3", "step4"];
	for (var i = 0; i < panels.length; i++) {
		var el = qs(panels[i]);
		if (el) {
			el.classList.toggle("d-none", panels[i] !== "step" + step);
		}
	}
	var pills = document.querySelectorAll("#wizardSteps .nav-link");
	for (var p = 0; p < pills.length; p++) {
		var pill = pills[p];
		var n = Number(pill.getAttribute("data-step"));
		pill.classList.toggle("active", n === step);
		pill.classList.toggle("disabled", n > step);
	}
}

function appendLog(preId, line) {
	var pre = qs(preId);
	if (!pre) {
		return;
	}
	var text = (pre.textContent ? pre.textContent + "\n" : "") + line;
	var lines = text.split("\n");
	if (lines.length > LOG_MAX) {
		text = lines.slice(lines.length - LOG_MAX).join("\n");
	}
	pre.textContent = text;
	pre.scrollTop = pre.scrollHeight;
}

function setBar(barId, pct, statusId, msg) {
	var bar = qs(barId);
	if (bar && typeof pct === "number") {
		bar.style.width = String(pct) + "%";
		bar.setAttribute("aria-valuenow", String(pct));
	}
	if (statusId && msg) {
		var st = qs(statusId);
		if (st) {
			st.textContent = msg;
		}
	}
}

function fileUrlForPath(filePath) {
	if (!filePath || !fs.existsSync(filePath)) {
		return "";
	}
	try {
		return url.pathToFileURL(path.resolve(filePath)).href;
	} catch (e) {
		return url.pathToFileURL(filePath).href;
	}
}

function loadCziImportConfig() {
	var cfgPath = cziImport.importConfigPath(state.bundleRoot);
	if (fs.existsSync(cfgPath)) {
		try {
			var raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
			return raw.czi_import || raw;
		} catch (e) {
			console.warn("[GeometryRepair]", e);
		}
	}
	var proj = project.getProject() || {};
	if (proj.settings && proj.settings.czi_import) {
		return JSON.parse(JSON.stringify(proj.settings.czi_import));
	}
	return cziImport.buildDefaultCziImport("");
}

function writeProbeConfig(extra) {
	var cfgPath = cziImport.importConfigPath(state.bundleRoot);
	var payload = Object.assign({}, state.cziImport, extra || {});
	payload.config_fingerprint = cziImport.cziImportFingerprint(payload);
	fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
	fs.writeFileSync(cfgPath, JSON.stringify({ czi_import: payload }, null, 2), "utf8");
	return cfgPath;
}

function writeRepairConfig(targets) {
	var cfgPath = path.join(state.bundleRoot, branding.META_DIR, "geometry_repair_run.json");
	var payload = Object.assign({}, state.cziImport, {
		repair_mode: "geometry",
		repair_targets: targets,
		geometry_hash: geometryState.geometryOnlyHash(state.cziImport),
		config_fingerprint: cziImport.cziImportFingerprint(state.cziImport),
	});
	fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
	fs.writeFileSync(cfgPath, JSON.stringify({ czi_import: payload }, null, 2), "utf8");
	return cfgPath;
}

function populateReferenceBranchSelect() {
	var sel = qs("referenceBranchSelect");
	if (!sel || !state.queue) {
		return;
	}
	var branches = {};
	var slices = state.queue.slices || [];
	for (var i = 0; i < slices.length; i++) {
		var chs = slices[i].channels || [];
		for (var c = 0; c < chs.length; c++) {
			branches[chs[c].branch] = true;
		}
	}
	sel.innerHTML = "";
	var keys = Object.keys(branches).sort();
	if (!keys.length) {
		keys = [state.queue.reference_branch || "somata"];
	}
	for (var k = 0; k < keys.length; k++) {
		var opt = document.createElement("option");
		opt.value = keys[k];
		opt.textContent = keys[k];
		sel.appendChild(opt);
	}
	sel.value = state.queue.reference_branch || keys[0];
}

function renderAuditSummary() {
	var el = qs("auditSummary");
	if (!el || !state.queue) {
		return;
	}
	var sum = geometryState.summarizeQueue(state.queue);
	var s = state.queue.summary || {};
	el.textContent =
		(sum.total || 0) +
		" sections scanned · " +
		(s.ok != null ? s.ok : sum.ok) +
		" OK · " +
		(s.need_review != null ? s.need_review : sum.needReview) +
		" need review · " +
		(s.auto_repairable != null ? s.auto_repairable : sum.autoRepairable) +
		" auto-repairable";
	if (state.applyState && state.applyState.previewBlocked) {
		el.className = "alert alert-warning small";
		el.textContent +=
			" — Repair previews in Orient first (invalid TIFF/missing _previews).";
	} else if (sum.needReview === 0 && sum.autoRepairable === 0 && sum.ok === sum.total) {
		el.className = "alert alert-success small";
		el.textContent =
			"No inconsistent geometry detected across " +
			(sum.total || 0) +
			" section(s). Back to Orient to adjust slices, or close this wizard.";
	} else {
		el.className = "alert alert-info small";
	}
	var step1Next = qs("step1Next");
	if (step1Next && state.queue) {
		var needsWork = sum.needReview > 0 || sum.autoRepairable > 0;
		step1Next.classList.toggle("d-none", !needsWork);
	}
}

function renderReviewSlice() {
	var reviewSlices = geometryState.slicesNeedingReview(state.queue);
	if (!reviewSlices.length) {
		setStep(3);
		renderConfirmSummary();
		return;
	}
	if (state.reviewIndex >= reviewSlices.length) {
		setStep(3);
		renderConfirmSummary();
		return;
	}
	var sl = reviewSlices[state.reviewIndex];
	state.reviewOps = orientGeometry.cloneGeometry({ ops: (sl.pending_ops || []).slice() });
	qs("reviewSliceTitle").textContent = sl.slice_id + " (" + (state.reviewIndex + 1) + "/" + reviewSlices.length + ")";
	qs("reviewSliceIssue").textContent = "Issue: " + (sl.issue || "review");
	updateReviewOpsStatus();

	var grid = qs("reviewChannelGrid");
	grid.innerHTML = "";
	var channels = sl.channels || [];
	for (var i = 0; i < channels.length; i++) {
		var ch = channels[i];
		var abs = path.join(state.bundleRoot, ch.rel_path);
		var pair = document.createElement("div");
		pair.className = "repair-thumb-pair";
		pair.innerHTML = "<div class='repair-thumb-label'>" + ch.branch + " (on disk)</div>";
		var imgDisk = document.createElement("img");
		imgDisk.src = fileUrlForPath(abs);
		imgDisk.alt = ch.branch;
		pair.appendChild(imgDisk);

		var targetWrap = document.createElement("div");
		targetWrap.className = "mt-1";
		targetWrap.innerHTML = "<div class='repair-thumb-label'>Target</div>";
		var viewport = document.createElement("div");
		viewport.style.transform = orientGeometry.geometryCssTransform(state.reviewOps);
		viewport.style.transformOrigin = "center center";
		var imgTarget = document.createElement("img");
		imgTarget.src = fileUrlForPath(abs);
		imgTarget.alt = ch.branch + " target";
		viewport.appendChild(imgTarget);
		targetWrap.appendChild(viewport);
		pair.appendChild(targetWrap);
		grid.appendChild(pair);
	}
}

function updateReviewOpsStatus() {
	var el = qs("reviewOpsStatus");
	if (el) {
		el.textContent = "Slice ops: " + orientGeometry.geometryStatusText(state.reviewOps);
	}
	var grid = qs("reviewChannelGrid");
	if (!grid) {
		return;
	}
	var viewports = grid.querySelectorAll("div[style*='transform']");
	for (var i = 0; i < viewports.length; i++) {
		viewports[i].style.transform = orientGeometry.geometryCssTransform(state.reviewOps);
	}
}

function confirmCurrentReviewSlice() {
	var reviewSlices = geometryState.slicesNeedingReview(state.queue);
	var sl = reviewSlices[state.reviewIndex];
	if (!sl) {
		return;
	}
	sl.confirmed_ops = (state.reviewOps && state.reviewOps.ops) ? state.reviewOps.ops.slice() : [];
	sl.needs_manual_review = false;
	for (var i = 0; i < (state.queue.slices || []).length; i++) {
		if (state.queue.slices[i].slice_id === sl.slice_id) {
			state.queue.slices[i] = sl;
			break;
		}
	}
	geometryState.writeRepairQueue(state.bundleRoot, state.queue);
	state.reviewIndex += 1;
	renderReviewSlice();
}

function skipCurrentReviewSlice() {
	state.reviewIndex += 1;
	renderReviewSlice();
}

function renderConfirmSummary() {
	var targets = geometryState.buildRepairTargetsFromQueue(state.queue);
	var pre = qs("confirmSummary");
	if (pre) {
		pre.textContent = JSON.stringify(targets, null, 2);
	}
	state.repairTargets = targets;
}

function runAudit() {
	if (state.auditRunning) {
		return;
	}
	state.auditRunning = true;
	setStep(0);
	appendLog("geometryRepairLog", "Bundle: " + state.bundleRoot);
	setBar("auditProgress", 2, "auditStatus", "Loading slice list…");

	state.sliceIds = geometryState.resolveSliceIds(state.bundleRoot, state.cziImport);
	state.applyState = geometryState.assessGeometryApplyState(state.bundleRoot, state.cziImport, {
		sliceIds: state.sliceIds,
		previewHealth: cziImport.assessOrientPreviewHealth(state.bundleRoot, state.cziImport),
	});

	appendLog("geometryRepairLog", "Layer 1 policy: " + state.applyState.policyState);
	setBar("auditProgress", 15, "auditStatus", "Policy audit complete; starting fingerprint probe…");

	var probeCfg = writeProbeConfig({
		slice_ids: state.sliceIds,
		reference_branch: state.applyState.referenceBranch,
		geometry: state.cziImport.geometry || {},
	});

	return new Promise(function (resolve, reject) {
		var fileTotal = 0;
		var fileDone = 0;

		function onProgress(ev, data) {
			var rawPct = Number(data[0]) || 0;
			var message = String(data[1] || "");
			var match = message.match(/\[(\d+)\/(\d+)\]/);
			if (match) {
				fileDone = Number(match[1]);
				fileTotal = Number(match[2]);
				rawPct = Math.min(94, 20 + Math.round((fileDone / fileTotal) * 75));
			}
			setBar("auditProgress", rawPct, "auditStatus", message || "Auditing sections…");
		}
		function onJobLog(ev, line) {
			var msg = String(line || "").trim();
			if (msg) {
				appendLog("geometryRepairLog", msg.replace(/^LOG:\s*/i, ""));
			}
		}
		function onResult(ev, payload) {
			ipc.removeListener("updateLoad", onProgress);
			ipc.removeListener("cziJobLog", onJobLog);
			ipc.removeListener("geometryFingerprintResult", onResult);
			state.auditRunning = false;
			if (!payload || payload.ok === false) {
				var errDetail = (payload && payload.error) || "Fingerprint probe failed";
				if (!state.sliceIds.length) {
					errDetail =
						"No tissue sections found — check that _previews PNGs or 00_dapi exist on this project.";
				}
				appendLog("geometryRepairLog", "ERROR: " + errDetail);
				setBar("auditProgress", 0, "auditStatus", "Audit failed: " + errDetail);
				reject(new Error(errDetail));
				return;
			}
			state.queue = geometryState.mergeProbeIntoQueue(state.bundleRoot, payload, state.cziImport);
			setBar("auditProgress", 100, "auditStatus", "Audit complete");
			appendLog("geometryRepairLog", "Queue written: " + geometryState.repairQueuePath(state.bundleRoot));
			populateReferenceBranchSelect();
			renderAuditSummary();
			setStep(1);
			resolve(state.queue);
		}

		ipc.on("updateLoad", onProgress);
		ipc.on("cziJobLog", onJobLog);
		ipc.once("geometryFingerprintResult", onResult);
		setBar("auditProgress", 22, "auditStatus", "Launching orientation probe…");
		ipc.send("runGeometryFingerprintProbe", [
			String(state.bundleRoot).trim(),
			String(probeCfg).trim(),
		]);
	});
}

function runRepair() {
	if (state.repairRunning) {
		return;
	}
	state.repairRunning = true;
	setStep(4);
	var targets = state.repairTargets || geometryState.buildRepairTargetsFromQueue(state.queue);
	var cfgPath = writeRepairConfig(targets);

	return new Promise(function (resolve, reject) {
		function onProgress(ev, data) {
			var pct = Number(data[0]) || 0;
			var msg = String(data[1] || "");
			setBar("repairProgress", pct, "repairStatus", msg);
		}
		function onJobLog(ev, line) {
			var msg = String(line || "").trim();
			if (msg) {
				appendLog("repairLog", msg.replace(/^LOG:\s*/i, ""));
			}
		}
		function onResult(ev, payload) {
			ipc.removeListener("updateLoad", onProgress);
			ipc.removeListener("cziJobLog", onJobLog);
			ipc.removeListener("applyGeometryResult", onResult);
			state.repairRunning = false;
			geometryState.persistLastApplyResult(state.bundleRoot, state.cziImport, payload || {});
			if (!payload || payload.ok === false) {
				setBar("repairProgress", 0, "repairStatus", "Repair failed");
				reject(new Error((payload && payload.error) || "Repair failed"));
				return;
			}
			setBar("repairProgress", 100, "repairStatus", "Repair complete");
			var proj = project.getProject();
			if (proj) {
				orientGeometry.resetGeometryMap(state.cziImport.geometry, state.sliceIds);
				state.cziImport.geometry_applied_at = new Date().toISOString();
				proj.settings = proj.settings || {};
				proj.settings.czi_import = state.cziImport;
				project.saveProjectJson();
			}
			writeProbeConfig({});
			resolve(payload);
		}
		ipc.on("updateLoad", onProgress);
		ipc.on("cziJobLog", onJobLog);
		ipc.once("applyGeometryResult", onResult);
		setBar("repairProgress", 5, "repairStatus", "Starting repair…");
		ipc.send("runApplyGeometry", [String(state.bundleRoot).trim(), String(cfgPath).trim()]);
	});
}

function init() {
	navTrail.renderTrail(
		[
			{ label: "Start", href: "./menu.html" },
			{ label: "Workspace", href: "./workspace_menu.html" },
			{ label: "Orient", href: "./orient.html" },
			{ label: "Check orientation" },
		],
		"navTrail",
	);

	state.bundleRoot = project.getBundleRoot();
	if (!state.bundleRoot || !project.isActive()) {
		setBar("auditProgress", 0, "auditStatus", "No active project.");
		return;
	}
	state.cziImport = loadCziImportConfig();

	var step1NextBtn = qs("step1Next");
	if (step1NextBtn) {
		step1NextBtn.addEventListener("click", function () {
			var sel = qs("referenceBranchSelect");
			if (sel && state.queue) {
				state.queue.reference_branch = sel.value;
				geometryState.writeRepairQueue(state.bundleRoot, state.queue);
			}
			var needReview = geometryState.slicesNeedingReview(state.queue).length;
			if (needReview > 0) {
				state.reviewIndex = 0;
				setStep(2);
				renderReviewSlice();
			} else {
				setStep(3);
				renderConfirmSummary();
			}
		});
	}
	qs("reviewRot90").addEventListener("click", function () {
		state.reviewOps = orientGeometry.applyGeometryAction(state.reviewOps, "rot90");
		updateReviewOpsStatus();
	});
	qs("reviewFlipX").addEventListener("click", function () {
		state.reviewOps = orientGeometry.applyGeometryAction(state.reviewOps, "flipX");
		updateReviewOpsStatus();
	});
	qs("reviewFlipY").addEventListener("click", function () {
		state.reviewOps = orientGeometry.applyGeometryAction(state.reviewOps, "flipY");
		updateReviewOpsStatus();
	});
	qs("reviewConfirmSlice").addEventListener("click", confirmCurrentReviewSlice);
	qs("reviewSkipSlice").addEventListener("click", skipCurrentReviewSlice);
	qs("runRepair").addEventListener("click", function () {
		runRepair().catch(function (err) {
			alert(String(err.message || err));
		});
	});
	qs("step3Back").addEventListener("click", function () {
		state.reviewIndex = 0;
		setStep(2);
		renderReviewSlice();
	});

	runAudit().catch(function (err) {
		appendLog("geometryRepairLog", "ERROR: " + String(err.message || err));
		setBar("auditProgress", 0, "auditStatus", "Audit failed: " + err.message);
	});
}

pageInit.onReady(function () {
	pageInit.installGlobalErrorHandler();
	init();
});
