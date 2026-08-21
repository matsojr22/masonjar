"use strict";

var fs = require("fs");
var path = require("path");
var { ipcRenderer } = require("electron");
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var pipelineRuns = require("./pipeline_runs");
var maxDatasets = require("./max_datasets");
var projectIndexBusy = require("./project_index_busy");

var META = ".masonjar";
var CONFIG_NAME = "basic_run_config.json";
var PROGRESS_NAME = "basic_apply_progress.json";

var state = {
	step: 0,
	channels: [],
	visited: {},
	paramsByChannel: {},
	running: false,
	lastOutputs: [],
	zoom: 1,
	panX: 0,
	panY: 0,
};

function bundleRoot() {
	return project.isActive() ? project.getBundleRoot() : "";
}

function projectRoles() {
	var proj = project.getProject();
	return (proj && proj.roles) || pipelineRuns.CANONICAL_ROLES;
}

function metaDir() {
	return path.join(bundleRoot(), META);
}

function ensureMeta() {
	var d = metaDir();
	if (!fs.existsSync(d)) {
		fs.mkdirSync(d, { recursive: true });
	}
	return d;
}

function defaultParams() {
	return {
		get_darkfield: true,
		smoothness_flatfield: 1.0,
		smoothness_darkfield: 1.0,
		working_size: 128,
		sort_intensity: false,
	};
}

function readParamsFromUi() {
	return {
		get_darkfield: !!(document.getElementById("getDarkfield") || {}).checked,
		smoothness_flatfield: Number(
			(document.getElementById("smoothFlat") || {}).value || 1
		),
		smoothness_darkfield: Number(
			(document.getElementById("smoothDark") || {}).value || 1
		),
		working_size: Number(
			(document.getElementById("workingSize") || {}).value || 128
		),
		sort_intensity: !!(document.getElementById("sortIntensity") || {}).checked,
	};
}

function writeParamsToUi(params) {
	params = params || defaultParams();
	var gd = document.getElementById("getDarkfield");
	var sf = document.getElementById("smoothFlat");
	var sd = document.getElementById("smoothDark");
	var ws = document.getElementById("workingSize");
	var si = document.getElementById("sortIntensity");
	if (gd) gd.checked = !!params.get_darkfield;
	if (sf) sf.value = String(params.smoothness_flatfield);
	if (sd) sd.value = String(params.smoothness_darkfield);
	if (ws) ws.value = String(params.working_size);
	if (si) si.checked = !!params.sort_intensity;
}

function currentChannelId() {
	var sel = document.getElementById("channelSelect");
	return sel ? String(sel.value || "") : "";
}

function saveCurrentChannelParams() {
	var id = currentChannelId();
	if (!id) return;
	state.paramsByChannel[id] = readParamsFromUi();
	state.visited[id] = true;
	updateVisitHelp();
}

function loadChannelParams(id) {
	writeParamsToUi(state.paramsByChannel[id] || defaultParams());
}

function setStep(n) {
	state.step = n;
	["step0", "step1", "step2", "finishPanel"].forEach(function (id, idx) {
		var el = document.getElementById(id === "finishPanel" ? id : id);
		if (!el) return;
		if (id === "finishPanel") {
			el.classList.toggle("d-none", n !== 3);
		} else {
			var stepNum = Number(id.replace("step", ""));
			el.classList.toggle("d-none", stepNum !== n);
		}
	});
	document.querySelectorAll("#wizardSteps .nav-link").forEach(function (pill) {
		var s = Number(pill.getAttribute("data-step"));
		pill.classList.toggle("active", s === n);
		pill.classList.toggle("disabled", s > n && !(n === 3 && s === 3));
		if (s <= n) pill.classList.remove("disabled");
	});
}

function setBusy(busy) {
	state.running = !!busy;
	[
		"processStart",
		"step1Next",
		"step1BackAttr",
		"step2Back",
		"previewFilterBtn",
		"channelSelect",
		"attrProceed",
	].forEach(function (id) {
		var el = document.getElementById(id);
		if (el) el.disabled = !!busy;
	});
	var cancel = document.getElementById("step2Cancel");
	if (cancel) cancel.classList.toggle("d-none", !busy);
}

function appendLog(line) {
	var log = document.getElementById("wizardLog");
	if (!log) return;
	log.textContent += line + "\n";
	log.scrollTop = log.scrollHeight;
}

function listImageFiles(dir) {
	if (!dir || !fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter(function (n) {
			return /\.(tif|tiff|png|jpe?g)$/i.test(n);
		})
		.map(function (n) {
			return path.join(dir, n);
		})
		.sort();
}

function sliceIdFromPath(p) {
	var base = path.basename(p);
	var ome = base.toLowerCase().indexOf(".ome.");
	if (ome > 0) return base.slice(0, ome);
	return path.parse(base).name;
}

function discoverChannels() {
	var root = bundleRoot();
	var channels = [];
	var roles = projectRoles();
	var dapiAbs = pipelineRuns.resolveRoleBaseAbsForBundle(root, roles, "dapi");
	if (dapiAbs && fs.existsSync(dapiAbs) && listImageFiles(dapiAbs).length) {
		channels.push({
			id: "dapi",
			role: "dapi",
			label: "DAPI (counterstain)",
			source_abs: dapiAbs,
			output_abs: path.join(root, "data", "counting", "00_dapi_basic"),
			preview_suffix: "dapi",
			enabled: true,
		});
	}
	var branches = maxDatasets.listSignalBranches(root) || [];
	branches.forEach(function (branch) {
		var datasets = maxDatasets.listDatasetsForBranch(root, branch) || [];
		var prefer =
			maxDatasets.defaultDatasetForBranch(root, branch, { preferKind: "max" }) ||
			datasets[0];
		if (!prefer) return;
		channels.push({
			id: "signal:" + branch,
			role: "signal",
			label: "Signal — " + branch,
			signal_branch: branch,
			source_abs: prefer.abs,
			source_run_rel: prefer.rel,
			source_kind: prefer.kind,
			preview_suffix: branch,
			enabled: true,
		});
	});
	state.channels = channels;
	channels.forEach(function (ch) {
		if (!state.paramsByChannel[ch.id]) {
			state.paramsByChannel[ch.id] = defaultParams();
		}
	});
	return channels;
}

function fillChannelSelect() {
	var sel = document.getElementById("channelSelect");
	if (!sel) return;
	sel.innerHTML = "";
	state.channels.forEach(function (ch) {
		var opt = document.createElement("option");
		opt.value = ch.id;
		opt.textContent = ch.label;
		sel.appendChild(opt);
	});
	if (state.channels.length) {
		onChannelChanged();
	}
}

function currentChannel() {
	var id = currentChannelId();
	for (var i = 0; i < state.channels.length; i++) {
		if (state.channels[i].id === id) return state.channels[i];
	}
	return null;
}

function onChannelChanged() {
	saveCurrentChannelParams();
	var ch = currentChannel();
	var branchRow = document.getElementById("signalBranchRow");
	var sourceRow = document.getElementById("sourceDatasetRow");
	if (branchRow) branchRow.classList.toggle("d-none", !ch || ch.role !== "signal");
	if (sourceRow) sourceRow.classList.toggle("d-none", !ch || ch.role !== "signal");
	if (ch && ch.role === "signal") {
		fillSignalDatasets(ch);
	}
	loadChannelParams(ch ? ch.id : "");
	fillSlices();
	loadPreviewImage();
	updateVisitHelp();
}

function fillSignalDatasets(ch) {
	var root = bundleRoot();
	var branchSel = document.getElementById("signalBranchSelect");
	var sourceSel = document.getElementById("sourceDatasetSelect");
	if (!branchSel || !sourceSel) return;
	var branches = maxDatasets.listSignalBranches(root) || [];
	branchSel.innerHTML = "";
	branches.forEach(function (b) {
		var name = b.branch || b;
		var opt = document.createElement("option");
		opt.value = name;
		opt.textContent = name;
		if (name === ch.signal_branch) opt.selected = true;
		branchSel.appendChild(opt);
	});
	refreshSourceDatasets();
}

function refreshSourceDatasets() {
	var root = bundleRoot();
	var branchSel = document.getElementById("signalBranchSelect");
	var sourceSel = document.getElementById("sourceDatasetSelect");
	var ch = currentChannel();
	if (!branchSel || !sourceSel || !ch) return;
	var branch = branchSel.value;
	ch.signal_branch = branch;
	ch.preview_suffix = branch;
	ch.id = "signal:" + branch;
	var datasets = maxDatasets.listDatasetsForBranch(root, branch) || [];
	sourceSel.innerHTML = "";
	datasets.forEach(function (ds) {
		var opt = document.createElement("option");
		opt.value = ds.rel;
		opt.textContent = ds.label || ds.rel;
		opt.dataset.abs = ds.abs;
		opt.dataset.kind = ds.kind;
		sourceSel.appendChild(opt);
	});
	if (datasets.length) {
		sourceSel.value = ch.source_run_rel || datasets[0].rel;
		applySourceSelection();
	}
}

function applySourceSelection() {
	var sourceSel = document.getElementById("sourceDatasetSelect");
	var ch = currentChannel();
	if (!sourceSel || !ch) return;
	var opt = sourceSel.options[sourceSel.selectedIndex];
	if (!opt) return;
	ch.source_run_rel = opt.value;
	ch.source_abs = opt.dataset.abs;
	ch.source_kind = opt.dataset.kind;
	fillSlices();
	loadPreviewImage();
}

function fillSlices() {
	var ch = currentChannel();
	var sel = document.getElementById("sliceSelect");
	if (!sel || !ch) return;
	var files = listImageFiles(ch.source_abs);
	sel.innerHTML = "";
	files.forEach(function (f) {
		var opt = document.createElement("option");
		opt.value = f;
		opt.textContent = path.basename(f);
		sel.appendChild(opt);
	});
}

function updateVisitHelp() {
	var el = document.getElementById("channelVisitHelp");
	if (!el) return;
	var pending = state.channels.filter(function (c) {
		return !state.visited[c.id];
	});
	if (!pending.length) {
		el.textContent = "All channels visited — you can proceed to Process.";
	} else {
		el.textContent =
			"Still need to visit: " +
			pending
				.map(function (c) {
					return c.label;
				})
				.join(", ");
	}
}

function applyDisplayWindow() {
	var img = document.getElementById("preprocessPreviewImg");
	if (!img) return;
	var mn = Number((document.getElementById("displayMin") || {}).value || 0);
	var mx = Number((document.getElementById("displayMax") || {}).value || 255);
	if (mx <= mn) mx = mn + 1;
	var scale = 255 / (mx - mn);
	var intercept = -mn * scale;
	img.style.filter =
		"brightness(" +
		(scale * 100) / 100 +
		") contrast(1) " +
		"opacity(1)";
	// CSS filter is limited; use brightness approx
	img.style.filter = "brightness(" + (1 + (128 - (mn + mx) / 2) / 255) + ")";
}

function applyTransform() {
	var t = document.getElementById("preprocessPreviewTransform");
	if (!t) return;
	t.style.transform =
		"translate(" +
		state.panX +
		"px," +
		state.panY +
		"px) scale(" +
		state.zoom +
		")";
}

function loadPreviewImage() {
	var sel = document.getElementById("sliceSelect");
	var img = document.getElementById("preprocessPreviewImg");
	if (!sel || !img || !sel.value) return;
	var ch = currentChannel();
	var filePath = sel.value;
	// Prefer low-res _previews when channel has one
	if (ch) {
		var sid = sliceIdFromPath(filePath);
		var prev = path.join(
			bundleRoot(),
			"data",
			"counting",
			"_previews",
			sid + "_" + (ch.preview_suffix || "dapi") + ".png"
		);
		if (fs.existsSync(prev)) filePath = prev;
	}
	img.src = "file:///" + filePath.replace(/\\/g, "/");
	state.zoom = 1;
	state.panX = 0;
	state.panY = 0;
	applyTransform();
}

function requestPreview() {
	saveCurrentChannelParams();
	var sel = document.getElementById("sliceSelect");
	var ch = currentChannel();
	if (!sel || !sel.value || !ch) return;
	var status = document.getElementById("preprocessPreviewStatus");
	if (status) status.textContent = "Running BaSiC preview…";
	setBusy(true);
	var params = readParamsFromUi();
	ipcRenderer.send("runBasicPreview", [
		sel.value,
		0,
		0,
		512,
		512,
		{
			previewDir: ensureMeta(),
			fitDir: ch.source_abs,
			get_darkfield: params.get_darkfield,
			smoothness_flatfield: params.smoothness_flatfield,
			smoothness_darkfield: params.smoothness_darkfield,
			working_size: params.working_size,
			sort_intensity: params.sort_intensity,
		},
	]);
}

function buildOutputAbsForSignal(ch) {
	var root = bundleRoot();
	var branch = ch.signal_branch || "signal";
	var stems = listImageFiles(ch.source_abs).map(sliceIdFromPath);
	var slug = pipelineRuns.buildRunSlug("basic", {
		sortedStems: stems,
		sourceKind: ch.source_kind || "max",
		sourceRunRel: ch.source_run_rel || "",
		smoothness: (state.paramsByChannel[ch.id] || defaultParams())
			.smoothness_flatfield,
	});
	var branchRoot = path.join(
		pipelineRuns.resolveRoleBaseAbsForBundle(root, projectRoles(), "max"),
		branch
	);
	return pipelineRuns.resolveRunLeaf(branchRoot, "basic", slug);
}

function buildConfig(opts) {
	opts = opts || {};
	saveCurrentChannelParams();
	var root = bundleRoot();
	var channels = state.channels.map(function (ch) {
		var params = state.paramsByChannel[ch.id] || defaultParams();
		var outAbs =
			ch.role === "dapi" ? ch.output_abs : buildOutputAbsForSignal(ch);
		return {
			id: ch.id,
			role: ch.role,
			enabled: true,
			signal_branch: ch.signal_branch || null,
			source_abs: ch.source_abs,
			source_run_rel: ch.source_run_rel || null,
			output_abs: outAbs,
			preview_suffix: ch.preview_suffix,
			params: params,
		};
	});
	return {
		bundle_root: root,
		channels: channels,
		force_refit: !!(document.getElementById("forceRefit") || {}).checked,
		start_fresh: !!(document.getElementById("startFresh") || {}).checked,
		resume: !opts.fresh,
		config_fingerprint: String(Date.now()),
	};
}

function writeConfig(cfg) {
	ensureMeta();
	var p = path.join(metaDir(), CONFIG_NAME);
	fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
	return p;
}

function loadInterruptedProgress() {
	var p = path.join(metaDir(), PROGRESS_NAME);
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch (_e) {
		return null;
	}
}

function prepareProcessStep() {
	var pending = state.channels.filter(function (c) {
		return !state.visited[c.id];
	});
	if (pending.length) {
		alert(
			"Visit and review parameters for every channel before Process:\n" +
				pending
					.map(function (c) {
						return c.label;
					})
					.join("\n")
		);
		return false;
	}
	var list = document.getElementById("channelConfirmList");
	if (list) {
		list.innerHTML = state.channels
			.map(function (c) {
				return "<li>" + c.label + " ← " + c.source_abs + "</li>";
			})
			.join("");
	}
	var banner = document.getElementById("resumeBanner");
	var prog = loadInterruptedProgress();
	if (banner) {
		if (prog && prog.interrupted) {
			banner.classList.remove("d-none");
			banner.textContent =
				"Previous shading run incomplete (last channel " +
				(prog.last_ok_channel || "?") +
				", slice " +
				(prog.last_ok_slice || "?") +
				"). Choose Resume (default) or Start fresh.";
		} else {
			banner.classList.add("d-none");
		}
	}
	return true;
}

function startProcess() {
	var cfg = buildConfig();
	state.lastOutputs = cfg.channels.map(function (c) {
		return { id: c.id, role: c.role, output_abs: c.output_abs, signal_branch: c.signal_branch };
	});
	var configPath = writeConfig(cfg);
	var log = document.getElementById("wizardLog");
	if (log) log.textContent = "";
	setBusy(true);
	appendLog("[BasicWizard] Starting " + configPath);
	ipcRenderer.send("runBasic", [configPath]);
}

function updateProjectTracking(ok) {
	var proj = project.getProject();
	if (!proj) return;
	if (!proj.processing) {
		proj.processing = project.defaultProcessing();
	}
	var basic = {
		last_run_at: new Date().toISOString(),
		interrupted: !ok,
		channels: (state.lastOutputs || []).map(function (o) {
			return {
				id: o.id,
				role: o.role,
				status: ok ? "done" : "failed",
				output_abs: o.output_abs,
				signal_branch: o.signal_branch || null,
			};
		}),
	};
	proj.processing.basic = basic;
	var setActive = document.getElementById("setActiveMax");
	if (ok && setActive && setActive.checked) {
		var signalOut = (state.lastOutputs || []).find(function (o) {
			return o.role === "signal";
		});
		if (signalOut && signalOut.output_abs) {
			var maxBase = pipelineRuns.resolveRoleBaseAbsForBundle(
				bundleRoot(),
				projectRoles(),
				"max"
			);
			var rel = path
				.relative(maxBase, signalOut.output_abs)
				.split(path.sep)
				.join("/");
			pipelineRuns.setActiveRunRel("max", rel);
		}
	}
	project.saveProjectJson();
	try {
		project.refreshProjectIndex(bundleRoot());
	} catch (_e) {}
}

function onRunFinished(result) {
	setBusy(false);
	var ok = result && result.ok;
	var msg = (result && result.message) || (ok ? "ok" : "failed");
	appendLog("[BasicWizard] " + msg);
	updateProjectTracking(!!ok);
	var summary = document.getElementById("finishSummary");
	if (summary) {
		summary.className = ok ? "alert alert-success" : "alert alert-danger";
		summary.textContent = ok
			? "Shading correction finished. Completed tasks on the workspace hub will list BaSiC outputs."
			: "Shading correction failed: " + msg;
	}
	setStep(3);
}

function wirePreviewPan() {
	var vp = document.getElementById("preprocessPreviewViewport");
	if (!vp) return;
	var dragging = false;
	var lastX = 0;
	var lastY = 0;
	vp.addEventListener("wheel", function (ev) {
		ev.preventDefault();
		var factor = ev.deltaY < 0 ? 1.1 : 0.9;
		state.zoom = Math.max(0.2, Math.min(8, state.zoom * factor));
		applyTransform();
	});
	vp.addEventListener("mousedown", function (ev) {
		dragging = true;
		lastX = ev.clientX;
		lastY = ev.clientY;
	});
	window.addEventListener("mouseup", function () {
		dragging = false;
	});
	window.addEventListener("mousemove", function (ev) {
		if (!dragging) return;
		state.panX += ev.clientX - lastX;
		state.panY += ev.clientY - lastY;
		lastX = ev.clientX;
		lastY = ev.clientY;
		applyTransform();
	});
}

function wire() {
	document.getElementById("attrProceed").addEventListener("click", function () {
		setStep(1);
		discoverChannels();
		fillChannelSelect();
		if (!state.channels.length) {
			var root = bundleRoot();
			alert(
				"No DAPI or signal max datasets found in this project.\n\n" +
					"Bundle root: " +
					(root || "(empty — is a project open?)")
			);
		}
	});
	var step1BackAttr = document.getElementById("step1BackAttr");
	if (step1BackAttr) {
		step1BackAttr.addEventListener("click", function () {
			if (state.running) return;
			saveCurrentChannelParams();
			setStep(0);
		});
	}
	document.getElementById("channelSelect").addEventListener("change", function () {
		onChannelChanged();
		state.visited[currentChannelId()] = true;
		updateVisitHelp();
	});
	var branchSel = document.getElementById("signalBranchSelect");
	if (branchSel) {
		branchSel.addEventListener("change", refreshSourceDatasets);
	}
	var sourceSel = document.getElementById("sourceDatasetSelect");
	if (sourceSel) {
		sourceSel.addEventListener("change", applySourceSelection);
	}
	document.getElementById("sliceSelect").addEventListener("change", loadPreviewImage);
	[
		"getDarkfield",
		"smoothFlat",
		"smoothDark",
		"workingSize",
		"sortIntensity",
	].forEach(function (id) {
		var el = document.getElementById(id);
		if (el) {
			el.addEventListener("change", saveCurrentChannelParams);
			el.addEventListener("input", saveCurrentChannelParams);
		}
	});
	document.getElementById("displayMin").addEventListener("input", applyDisplayWindow);
	document.getElementById("displayMax").addEventListener("input", applyDisplayWindow);
	document.getElementById("previewFilterBtn").addEventListener("click", requestPreview);
	document.getElementById("step1Next").addEventListener("click", function () {
		saveCurrentChannelParams();
		state.visited[currentChannelId()] = true;
		if (!prepareProcessStep()) return;
		setStep(2);
	});
	document.getElementById("step2Back").addEventListener("click", function () {
		if (state.running) return;
		setStep(1);
	});
	document.getElementById("processStart").addEventListener("click", startProcess);
	document.getElementById("step2Cancel").addEventListener("click", function () {
		ipcRenderer.send("killBasic", []);
		appendLog("[BasicWizard] Cancel requested");
	});
	wirePreviewPan();

	ipcRenderer.on("basicPreviewResult", function (_e, payload) {
		setBusy(false);
		var status = document.getElementById("preprocessPreviewStatus");
		if (!payload || !payload.ok) {
			if (status) {
				status.textContent =
					"Preview failed: " + ((payload && payload.error) || "unknown");
			}
			return;
		}
		var img = document.getElementById("preprocessPreviewImg");
		if (img && payload.previewPath) {
			img.src =
				"file:///" +
				String(payload.previewPath).replace(/\\/g, "/") +
				"?t=" +
				Date.now();
		}
		if (status) status.textContent = "Preview ready (native ROI correction).";
	});
	ipcRenderer.on("basicResult", function (_e, result) {
		onRunFinished(result || { ok: false, message: "no result" });
	});
	ipcRenderer.on("updateLoad", function (_e, response) {
		if (!state.running && state.step !== 2) return;
		var pct = Array.isArray(response) ? response[0] : 0;
		var msg = Array.isArray(response) ? response[1] : "";
		var bar = document.getElementById("processProgress");
		var pm = document.getElementById("processMessage");
		if (bar) bar.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
		if (pm) pm.textContent = msg || "";
		if (msg && String(msg).indexOf("LOG:") === 0) {
			appendLog(String(msg));
		}
	});
}

projectIndexBusy.populatePage(function () {
	project.tryRestoreActiveProject();
	pipelineGate.assertPipelineAccess();
	setStep(0);
	wire();
});
