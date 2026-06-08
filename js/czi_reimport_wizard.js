"use strict";

var fs = require("fs");
var path = require("path");
var url = require("url");
var ipc = require("electron").ipcRenderer;
var navTrail = require("./nav_trail");
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var cziImport = require("./czi_import");
var branding = require("./branding");

var wizardStep = 1;
var running = false;
var bundleRoot = "";
var cziImportCfg = null;
var projectData = null;
var sliceIds = [];
var selectedSliceIds = {};
var blankSliceIds = {};
var selectedRoleKeys = {};
var blankPreviews = [];
var LOG_MAX = 1500;

project.tryRestoreActiveProject();
pipelineGate.assertPipelineAccess();

function qs(id) {
	return document.getElementById(id);
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function setStep(step) {
	wizardStep = step;
	var panels = document.querySelectorAll(".wizard-panel");
	for (var i = 0; i < panels.length; i++) {
		panels[i].classList.add("d-none");
	}
	var active = qs("step" + step);
	if (active) {
		active.classList.remove("d-none");
	}
	var pills = document.querySelectorAll("#wizardSteps .nav-link");
	for (var p = 0; p < pills.length; p++) {
		var pillStep = Number(pills[p].getAttribute("data-step"));
		pills[p].classList.remove("active", "disabled");
		if (pillStep === step) {
			pills[p].classList.add("active");
		} else {
			pills[p].classList.add("disabled");
		}
	}
}

function verboseLog(msg) {
	var logEl = qs("reimportLog");
	if (!logEl) {
		return;
	}
	var line = String(msg || "").trim();
	if (!line) {
		return;
	}
	var lines = logEl.textContent ? logEl.textContent.split("\n") : [];
	lines.push(line);
	if (lines.length > LOG_MAX) {
		lines = lines.slice(lines.length - LOG_MAX);
	}
	logEl.textContent = lines.join("\n");
	logEl.scrollTop = logEl.scrollHeight;
}

function setActivity(message, pct) {
	var status = qs("reimportStatus");
	var bar = qs("reimportProgress");
	if (status) {
		status.textContent = message || "";
	}
	if (bar) {
		var n = Math.max(0, Math.min(100, Number(pct) || 0));
		bar.style.width = n + "%";
		bar.setAttribute("aria-valuenow", String(n));
	}
}

function parsePreselectedSlices() {
	var params = new URLSearchParams(window.location.search);
	var raw = params.get("slices") || "";
	if (!raw) {
		return [];
	}
	return raw
		.split(",")
		.map(function (s) {
			return s.trim();
		})
		.filter(Boolean);
}

function initProjectGate() {
	var missing = qs("reimportMissing");
	var panel = qs("reimportPanel");
	if (!project.isActive()) {
		if (missing) {
			missing.classList.remove("d-none");
		}
		if (panel) {
			panel.classList.add("d-none");
		}
		return false;
	}
	bundleRoot = project.getBundleRoot();
	projectData = project.getProject() || project.readProjectJson(bundleRoot);
	cziImportCfg = projectData && projectData.settings && projectData.settings.czi_import;
	if (!cziImportCfg || !cziImportCfg.files || !cziImportCfg.files.length) {
		if (missing) {
			missing.textContent =
				"This project has no CZI import settings. Use Import from Zeiss CZI for new projects.";
			missing.classList.remove("d-none");
		}
		if (panel) {
			panel.classList.add("d-none");
		}
		return false;
	}
	if (missing) {
		missing.classList.add("d-none");
	}
	if (panel) {
		panel.classList.remove("d-none");
	}
	navTrail.renderTrail([
		{ label: "Start", href: "./menu.html" },
		{ label: "Workspace", href: "./workspace_menu.html" },
		{ label: "Re-import from CZI" },
	]);
	return true;
}

function loadSlicePlan() {
	sliceIds = cziImport.collectSliceIdsFromImport(cziImportCfg);
	var pre = parsePreselectedSlices();
	if (pre.length) {
		for (var i = 0; i < pre.length; i++) {
			if (sliceIds.indexOf(pre[i]) >= 0) {
				selectedSliceIds[pre[i]] = true;
			}
		}
	}
}

function scanBlankPreviews() {
	var status = qs("sliceScanStatus");
	if (status) {
		status.textContent = "Scanning previews for blank DAPI…";
	}
	return cziImport.findBlankPreviewsAsync(bundleRoot, cziImportCfg, {}).then(function (blanks) {
		blankPreviews = blanks || [];
		blankSliceIds = {};
		for (var i = 0; i < blankPreviews.length; i++) {
			if (blankPreviews[i].role_key === cziImport.ROLE_DAPI) {
				blankSliceIds[blankPreviews[i].slice_id] = true;
				if (!Object.keys(selectedSliceIds).length) {
					selectedSliceIds[blankPreviews[i].slice_id] = true;
				}
			}
		}
		if (status) {
			status.textContent =
				blankPreviews.length > 0
					? blankPreviews.length + " blank preview(s) detected."
					: sliceIds.length + " section(s) available.";
		}
		renderSliceList();
	});
}

function renderSliceList() {
	var container = qs("sliceSelectList");
	if (!container) {
		return;
	}
	var showBlankOnly = qs("showBlankOnly") && qs("showBlankOnly").checked;
	container.innerHTML = "";
	for (var i = 0; i < sliceIds.length; i++) {
		var sliceId = sliceIds[i];
		if (showBlankOnly && !blankSliceIds[sliceId]) {
			continue;
		}
		var card = document.createElement("div");
		card.className = "reimport-slice-card" + (blankSliceIds[sliceId] ? " blank-dapi" : "");
		var checked = !!selectedSliceIds[sliceId];
		var previewPath = cziImport.orientDapiPreviewPath(bundleRoot, sliceId);
		var imgHtml = "";
		if (fs.existsSync(previewPath)) {
			var href = url.pathToFileURL(previewPath).href;
			imgHtml =
				'<img src="' +
				escapeHtml(href) +
				'" alt="" loading="lazy" onerror="this.style.display=\'none\'" />';
		}
		var badge = blankSliceIds[sliceId]
			? '<span class="badge bg-warning text-dark ms-1">Blank DAPI</span>'
			: "";
		card.innerHTML =
			'<div class="form-check mb-1">' +
			'<input class="form-check-input reimport-slice" type="checkbox" id="slice_' +
			escapeHtml(sliceId) +
			'" value="' +
			escapeHtml(sliceId) +
			'"' +
			(checked ? " checked" : "") +
			" />" +
			'<label class="form-check-label small" for="slice_' +
			escapeHtml(sliceId) +
			'">' +
			escapeHtml(sliceId) +
			badge +
			"</label></div>" +
			imgHtml;
		container.appendChild(card);
	}
	container.querySelectorAll(".reimport-slice").forEach(function (el) {
		el.addEventListener("change", function () {
			if (el.checked) {
				selectedSliceIds[el.value] = true;
			} else {
				delete selectedSliceIds[el.value];
			}
		});
	});
}

function selectedSliceIdList() {
	return Object.keys(selectedSliceIds).filter(function (k) {
		return selectedSliceIds[k];
	});
}

function renderChannelList() {
	var container = qs("channelSelectList");
	if (!container) {
		return;
	}
	container.innerHTML = "";
	var channels = cziImport.listKeptChannelsForReimport(cziImportCfg);
	var blankRoles = {};
	for (var b = 0; b < blankPreviews.length; b++) {
		blankRoles[blankPreviews[b].role_key] = true;
	}
	for (var i = 0; i < channels.length; i++) {
		var entry = channels[i];
		var roleKey = entry.role_key;
		var checked =
			selectedRoleKeys[roleKey] != null
				? selectedRoleKeys[roleKey]
				: roleKey === cziImport.ROLE_DAPI || !!blankRoles[roleKey];
		if (selectedRoleKeys[roleKey] == null) {
			selectedRoleKeys[roleKey] = checked;
		}
		var div = document.createElement("div");
		div.className = "form-check";
		div.innerHTML =
			'<input class="form-check-input reimport-channel" type="checkbox" id="ch_' +
			escapeHtml(roleKey) +
			'" value="' +
			escapeHtml(roleKey) +
			'"' +
			(checked ? " checked" : "") +
			" />" +
			'<label class="form-check-label" for="ch_' +
			escapeHtml(roleKey) +
			'">' +
			escapeHtml(entry.label) +
			" (index " +
			entry.index +
			")</label>";
		container.appendChild(div);
	}
	container.querySelectorAll(".reimport-channel").forEach(function (el) {
		el.addEventListener("change", function () {
			selectedRoleKeys[el.value] = el.checked;
		});
	});
}

function selectedRoleKeyList() {
	var keys = [];
	for (var k in selectedRoleKeys) {
		if (Object.prototype.hasOwnProperty.call(selectedRoleKeys, k) && selectedRoleKeys[k]) {
			keys.push(k);
		}
	}
	return keys;
}

function buildTargets() {
	return cziImport.buildRepairTargetsForSelection(
		cziImportCfg,
		selectedSliceIdList(),
		selectedRoleKeyList(),
	);
}

function renderConfirmStep() {
	var tbody = qs("confirmTableBody");
	var warnings = qs("confirmWarnings");
	if (!tbody) {
		return;
	}
	tbody.innerHTML = "";
	var targets = buildTargets();
	var validation = cziImport.validateReimportSources(targets);
	var warnParts = [];
	if (!validation.ok) {
		warnParts.push(
			validation.missing.length +
				" target(s) missing source CZI on disk. Re-import cannot proceed until files are reachable.",
		);
	}
	var proc = (projectData && projectData.processing) || {};
	if (proc.active_runs && proc.active_runs.slices) {
		warnParts.push(
			"Alignment outputs exist for this project. Re-import does not modify annotations; re-run Align for affected sections if needed.",
		);
	}
	if (proc.active_runs && proc.active_runs.predictions) {
		warnParts.push(
			"Detection outputs exist. Re-import does not modify predictions; re-run detection if signal channels were replaced.",
		);
	}
	if (warnings) {
		if (warnParts.length) {
			warnings.textContent = warnParts.join(" ");
			warnings.classList.remove("d-none");
		} else {
			warnings.textContent = "";
			warnings.classList.add("d-none");
		}
	}
	for (var i = 0; i < targets.length; i++) {
		var t = targets[i];
		var item = null;
		var workItems = cziImport.iterKeptChannelScenes(cziImportCfg);
		for (var w = 0; w < workItems.length; w++) {
			if (
				workItems[w].slice_id === t.slice_id &&
				workItems[w].role_key === t.role_key &&
				workItems[w].channel_index === t.channel_index
			) {
				item = workItems[w];
				break;
			}
		}
		if (!item) {
			continue;
		}
		var outputs = cziImport.listReimportOutputPaths(bundleRoot, item, cziImportCfg, projectData);
		var tr = document.createElement("tr");
		var cziLabel = t.czi_path ? path.basename(t.czi_path) : "(missing)";
		var cziClass = t.czi_path && fs.existsSync(t.czi_path) ? "" : " table-danger";
		tr.innerHTML =
			"<td>" +
			escapeHtml(t.slice_id) +
			"</td><td>" +
			escapeHtml(t.role_key) +
			"</td><td class" +
			cziClass +
			'">' +
			escapeHtml(cziLabel) +
			"</td><td class="small text-muted"><ul class="mb-0 ps-3">' +
			outputs
				.map(function (p) {
					return "<li>" + escapeHtml(path.relative(bundleRoot, p)) + "</li>";
				})
				.join("") +
			"</ul></td>";
		tbody.appendChild(tr);
	}
	var runBtn = qs("step3Run");
	var confirmBox = qs("confirmOverwrite");
	if (runBtn) {
		runBtn.disabled = !validation.ok || !(confirmBox && confirmBox.checked);
	}
}

function persistCziSettings(result) {
	if (!projectData) {
		return;
	}
	if (!projectData.settings) {
		projectData.settings = {};
	}
	if (!projectData.settings.czi_import) {
		projectData.settings.czi_import = cziImportCfg;
	}
	if (result && result.preview_format_version) {
		projectData.settings.czi_import.preview_format_version = result.preview_format_version;
	}
	if (result && result.max_runs) {
		projectData.settings.czi_import.max_runs = result.max_runs;
	}
	project.saveProjectJson();
}

function runReimport() {
	if (running) {
		return Promise.reject(new Error("Re-import already running"));
	}
	var targets = buildTargets();
	var validation = cziImport.validateReimportSources(targets);
	if (!validation.ok) {
		return Promise.reject(new Error("Source CZI file(s) missing on disk"));
	}
	running = true;
	setStep(4);
	setActivity("Preparing re-import…", 2);
	verboseLog("Re-import " + targets.length + " target(s)…");
	var cancelBtn = qs("cancelReimport");
	var donePanel = qs("reimportDonePanel");
	if (cancelBtn) {
		cancelBtn.classList.remove("d-none");
	}
	if (donePanel) {
		donePanel.classList.add("d-none");
	}

	var payload = cziImport.buildReextractConfig(cziImportCfg, targets, projectData);
	var cfgPath = cziImport.importConfigPath(bundleRoot);
	fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
	fs.writeFileSync(cfgPath, JSON.stringify({ czi_import: payload }, null, 2), "utf8");

	return new Promise(function (resolve, reject) {
		function onProgress(ev, data) {
			var pct = Number(data[0]) || 0;
			setActivity(String(data[1] || "Re-importing…"), pct);
		}
		function onJobLog(ev, line) {
			var msg = String(line || "").trim();
			if (msg) {
				verboseLog(msg.replace(/^LOG:\s*/i, ""));
			}
		}
		function onResult(ev, result) {
			ipc.removeListener("updateLoad", onProgress);
			ipc.removeListener("cziJobLog", onJobLog);
			ipc.removeListener("cziImportResult", onResult);
			running = false;
			if (cancelBtn) {
				cancelBtn.classList.add("d-none");
			}
			if (!result || result.ok === false) {
				var errMsg = (result && result.error) || "Re-import failed";
				setActivity(errMsg, 0);
				reject(new Error(errMsg));
				return;
			}
			persistCziSettings(result);
			project.refreshProjectIndex(bundleRoot).then(function () {
				setActivity("Re-import complete.", 100);
				var summary = qs("reimportSummary");
				if (summary) {
					var extracted = result.extracted || {};
					var keys = Object.keys(extracted);
					summary.textContent =
						"Re-imported " +
						targets.length +
						" channel×section target(s)" +
						(keys.length ? " (" + keys.join(", ") + ")." : ".");
				}
				if (donePanel) {
					donePanel.classList.remove("d-none");
				}
				resolve(result);
			});
		}
		ipc.on("updateLoad", onProgress);
		ipc.on("cziJobLog", onJobLog);
		ipc.once("cziImportResult", onResult);
		ipc.send("runCziImport", [String(bundleRoot || "").trim(), String(cfgPath || "").trim()]);
	});
}

function bindControls() {
	qs("showBlankOnly").addEventListener("change", renderSliceList);
	qs("selectAllSlices").addEventListener("click", function () {
		for (var i = 0; i < sliceIds.length; i++) {
			var sid = sliceIds[i];
			if (qs("showBlankOnly").checked && !blankSliceIds[sid]) {
				continue;
			}
			selectedSliceIds[sid] = true;
		}
		renderSliceList();
	});
	qs("clearAllSlices").addEventListener("click", function () {
		selectedSliceIds = {};
		renderSliceList();
	});
	qs("step1Next").addEventListener("click", function () {
		if (!selectedSliceIdList().length) {
			alert("Select at least one section.");
			return;
		}
		renderChannelList();
		setStep(2);
	});
	qs("step2Back").addEventListener("click", function () {
		setStep(1);
	});
	qs("step2Next").addEventListener("click", function () {
		if (!selectedRoleKeyList().length) {
			var val = qs("channelValidation");
			if (val) {
				val.textContent = "Select at least one channel.";
				val.classList.remove("d-none");
			}
			return;
		}
		var valHide = qs("channelValidation");
		if (valHide) {
			valHide.classList.add("d-none");
		}
		renderConfirmStep();
		setStep(3);
	});
	qs("step3Back").addEventListener("click", function () {
		setStep(2);
	});
	qs("confirmOverwrite").addEventListener("change", renderConfirmStep);
	qs("step3Run").addEventListener("click", function () {
		runReimport().catch(function (err) {
			alert(String(err.message || err));
		});
	});
	qs("cancelReimport").addEventListener("click", function () {
		ipc.send("killCziImport");
	});
}

function boot() {
	if (!initProjectGate()) {
		return;
	}
	loadSlicePlan();
	bindControls();
	scanBlankPreviews().catch(function (err) {
		console.error("[CziReimport]", err);
		renderSliceList();
	});
}

boot();
