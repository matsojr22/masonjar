"use strict";

var fs = require("fs");
var path = require("path");
var url = require("url");
var pageInit = require("./page_init");
var project = require("./project");
var pipelineRuns = require("./pipeline_runs");
var cziImport = require("./czi_import");
var branding = require("./branding");

var ipc = require("electron").ipcRenderer;

var wizardState = {
	step: 1,
	parentDir: "",
	bundleRoot: "",
	projectFilename: "",
	cziSourceDirs: [],
	cziImport: cziImport.buildDefaultCziImport(""),
	importResult: null,
	repairMode: false,
	repairTargets: [],
};

var extractRunning = false;
var probeInFlight = false;
var extractGotPythonAck = false;
var extractHeartbeatTimer = null;
var extractGapWatchdogTimer = null;
var extractWaitStartedAt = 0;
var extractLastPythonActivityAt = 0;
var extractGapEmitted = false;
var EXTRACT_LOG_MAX_LINES = 2000;

function qs(id) {
	return document.getElementById(id);
}

function yieldToUi() {
	return new Promise(function (resolve) {
		requestAnimationFrame(function () {
			setTimeout(resolve, 0);
		});
	});
}

function updateBundlePathPreview() {
	var parentDir = wizardState.parentDir;
	var nameEl = qs("projectName");
	var pathEl = qs("bundlePath");
	if (!pathEl) {
		return;
	}
	if (!parentDir || !nameEl || !nameEl.value.trim()) {
		pathEl.value = "";
		wizardState.bundleRoot = "";
		wizardState.projectFilename = "";
		return;
	}
	var resolved = project.resolveNewBundlePath(parentDir, nameEl.value);
	pathEl.value = resolved.bundleRoot;
	wizardState.bundleRoot = resolved.bundleRoot;
	wizardState.projectFilename = resolved.projectFilename;
}

function setStep(step) {
	wizardState.step = step;
	var panels = document.querySelectorAll(".wizard-panel");
	for (var i = 0; i < panels.length; i++) {
		panels[i].classList.add("d-none");
		panels[i].setAttribute("hidden", "");
	}
	var active = qs("step" + step);
	if (active) {
		active.classList.remove("d-none");
		active.removeAttribute("hidden");
	}
	var pills = document.querySelectorAll("#wizardSteps .nav-link");
	for (var p = 0; p < pills.length; p++) {
		var pillStep = Number(pills[p].getAttribute("data-step"));
		pills[p].classList.remove("active", "disabled", "wizard-step-done");
		if (pillStep === step) {
			pills[p].classList.add("active");
		} else if (pillStep < step) {
			pills[p].classList.add("wizard-step-done");
		} else {
			pills[p].classList.add("disabled");
		}
	}
	var parent = qs("parent");
	if (parent) {
		parent.scrollTop = 0;
	}
	window.scrollTo(0, 0);
	updateWizardCancelVisibility();
}

function updateWizardCancelVisibility() {
	var footer = qs("wizardCancel");
	if (footer) {
		footer.classList.toggle("d-none", wizardState.step === 4 && extractRunning);
	}
}

function verboseExtractLog(msg) {
	console.log("[CziWizard]", msg);
	var el = qs("extractLog");
	if (el) {
		el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
		// Cap scrollback for long jobs (324+ items with per-plane logs).
		var lines = el.textContent.split("\n");
		if (lines.length > EXTRACT_LOG_MAX_LINES) {
			el.textContent = lines.slice(lines.length - EXTRACT_LOG_MAX_LINES).join("\n");
		}
		el.scrollTop = el.scrollHeight;
	}
}

function truncateStatus(text, maxLen) {
	var s = String(text || "").trim();
	if (s.length <= maxLen) {
		return s;
	}
	return s.slice(0, maxLen - 1) + "…";
}

function clearExtractWaitTimers() {
	if (extractHeartbeatTimer) {
		clearInterval(extractHeartbeatTimer);
		extractHeartbeatTimer = null;
	}
	if (extractGapWatchdogTimer) {
		clearInterval(extractGapWatchdogTimer);
		extractGapWatchdogTimer = null;
	}
}

function markPythonActivity() {
	extractLastPythonActivityAt = Date.now();
	extractGapEmitted = false;
	if (!extractGotPythonAck) {
		extractGotPythonAck = true;
		clearExtractWaitTimers();
		setExtractIndeterminate(false);
	}
}

function startExtractWaitFeedback() {
	extractGotPythonAck = false;
	extractWaitStartedAt = Date.now();
	extractLastPythonActivityAt = Date.now();
	extractGapEmitted = false;
	clearExtractWaitTimers();
	setExtractIndeterminate(true);
	verboseExtractLog("Waiting for Python worker…");
	if (extractHeartbeatTimer) {
		clearInterval(extractHeartbeatTimer);
	}
	extractHeartbeatTimer = setInterval(function () {
		if (extractGotPythonAck || !extractRunning) {
			clearExtractWaitTimers();
			return;
		}
		var elapsed = Math.round((Date.now() - extractWaitStartedAt) / 1000);
		verboseExtractLog("Still waiting for Python worker… (" + elapsed + "s)");
	}, 1500);
	extractGapWatchdogTimer = setInterval(function () {
		if (!extractRunning) {
			return;
		}
		var gap = Date.now() - extractLastPythonActivityAt;
		if (gap >= 2000 && !extractGapEmitted) {
			extractGapEmitted = true;
			verboseExtractLog("(local) waiting for Python output…");
			var status = qs("extractStatus");
			if (status) {
				status.textContent = truncateStatus("Waiting for Python output…", 120);
			}
		}
	}, 500);
}

function mapExtractDisplayPct(rawPct, message) {
	var text = String(message || "");
	if (rawPct >= 100 || /complete/i.test(text)) {
		return 100;
	}
	if (/^Ready —/i.test(text)) {
		return 20;
	}
	if (/max project/i.test(text)) {
		return 92 + Math.min(7, Math.round((rawPct / 100) * 7));
	}
	if (/Extracting\s+\S+\s+scene/i.test(text)) {
		if (rawPct >= 22 && rawPct <= 92) {
			return rawPct;
		}
		return 22 + Math.round(Math.min(100, Math.max(0, rawPct)) * 0.70);
	}
	if (rawPct >= 3 && rawPct <= 22) {
		return rawPct;
	}
	return Math.min(22, Math.max(0, rawPct));
}

function formatExtractStatus(rawPct, message) {
	var text = String(message || "").trim();
	if (rawPct >= 100 || /complete/i.test(text)) {
		return "Extract complete";
	}
	if (/^Ready —/i.test(text)) {
		return text;
	}
	if (/max project/i.test(text)) {
		return "Max projecting signal channels…";
	}
	var prefer =
		/Importing|Reading Z|Writing|Opening|still loading|Loading |Libraries ready|Arguments OK|Starting extract/i;
	if (prefer.test(text)) {
		return truncateStatus(text, 120);
	}
	var m = text.match(/Extracting\s+(\S+)\s+scene\s+(\d+)\s+ch\s+(\d+)/i);
	if (m) {
		return "Extracting " + m[1] + " scene " + m[2] + " channel " + m[3] + "…";
	}
	return truncateStatus(text || "Extracting…", 120);
}

function setExtractIndeterminate(indeterminate) {
	var bar = qs("extractProgress");
	if (!bar) {
		return;
	}
	if (indeterminate) {
		bar.style.width = "100%";
		bar.classList.add("progress-bar-striped", "progress-bar-animated");
		bar.removeAttribute("aria-valuenow");
	} else {
		bar.setAttribute("aria-valuemin", "0");
		bar.setAttribute("aria-valuemax", "100");
	}
}

function setExtractActivity(msg, pct) {
	var bar = qs("extractProgress");
	var status = qs("extractStatus");
	if (status && msg) {
		status.textContent = msg;
	}
	if (bar && typeof pct === "number") {
		setExtractIndeterminate(false);
		bar.style.width = String(pct) + "%";
		bar.setAttribute("aria-valuenow", String(pct));
		if (pct >= 100) {
			bar.classList.remove("progress-bar-striped", "progress-bar-animated");
		} else {
			bar.classList.add("progress-bar-striped", "progress-bar-animated");
		}
	}
}

function setExtractNavDisabled(disabled) {
	var pills = document.querySelectorAll("#wizardSteps .nav-link");
	for (var i = 0; i < pills.length; i++) {
		if (disabled) {
			pills[i].style.pointerEvents = "none";
		} else {
			pills[i].style.pointerEvents = "";
		}
	}
	if (!disabled) {
		setStep(wizardState.step);
	}
}

function countKeptChannels(cfg) {
	var channels = cfg.channels || [];
	var n = 0;
	for (var i = 0; i < channels.length; i++) {
		if (channels[i].keep && channels[i].role !== cziImport.ROLE_UNUSED) {
			n++;
		}
	}
	return n;
}

function projectStemForImport() {
	var nameEl = qs("projectName");
	var raw = (nameEl && nameEl.value.trim()) || path.basename(wizardState.bundleRoot || "");
	return cziImport.sanitizeSliceStem(raw.replace(/\.masonjar$/i, ""));
}

function applySliceNumberingDefault() {
	if ((wizardState.cziSourceDirs || []).length > 1) {
		wizardState.cziImport.slice_numbering = cziImport.SLICE_NUMBERING_RENAME;
	} else if (!wizardState.cziImport.slice_numbering) {
		wizardState.cziImport.slice_numbering = cziImport.SLICE_NUMBERING_PRESERVE;
	}
}

function refreshSliceOrder() {
	applySliceNumberingDefault();
	cziImport.buildSliceOrder(wizardState.cziImport, projectStemForImport());
}

function syncSliceNumberingRadios() {
	var numbering = wizardState.cziImport.slice_numbering || cziImport.SLICE_NUMBERING_PRESERVE;
	var preserve = qs("sliceNumberingPreserve");
	var rename = qs("sliceNumberingRename");
	if (preserve) {
		preserve.checked = numbering === cziImport.SLICE_NUMBERING_PRESERVE;
	}
	if (rename) {
		rename.checked = numbering === cziImport.SLICE_NUMBERING_RENAME;
	}
}

function setProbeControlsBusy(busy) {
	var addBtn = qs("addCziDir");
	if (addBtn) {
		addBtn.disabled = !!busy;
	}
}

function renderSourceDirList() {
	var list = qs("cziSourceDirList");
	if (!list) {
		return;
	}
	list.innerHTML = "";
	var dirs = wizardState.cziSourceDirs || [];
	if (!dirs.length) {
		var empty = document.createElement("li");
		empty.className = "list-group-item text-muted small";
		empty.textContent = "No folders added yet.";
		list.appendChild(empty);
		return;
	}
	for (var i = 0; i < dirs.length; i++) {
		var dir = dirs[i];
		var li = document.createElement("li");
		li.className = "list-group-item d-flex justify-content-between align-items-center";
		li.innerHTML =
			'<span class="small text-break">' +
			dir +
			'</span><button type="button" class="btn btn-sm btn-outline-danger ms-2" data-remove-dir="' +
			i +
			'">Remove</button>';
		list.appendChild(li);
	}
	list.querySelectorAll("[data-remove-dir]").forEach(function (btn) {
		btn.addEventListener("click", function (ev) {
			var idx = Number(ev.target.getAttribute("data-remove-dir"));
			wizardState.cziSourceDirs.splice(idx, 1);
			wizardState.cziImport.source_dirs = wizardState.cziSourceDirs.slice();
			wizardState.cziImport.files = (wizardState.cziImport.files || []).filter(function (f) {
				return wizardState.cziSourceDirs.indexOf(f.source_dir) >= 0;
			});
			renderSourceDirList();
			if (wizardState.cziSourceDirs.length) {
				runProbeAll().catch(function (err) {
					alert(String(err.message || err));
				});
			} else {
				renderCziFileTable([]);
				renderMosaicWarnings([]);
				var nextBtn = qs("step2Next");
				if (nextBtn) {
					nextBtn.disabled = true;
				}
				var status = qs("probeStatus");
				if (status) {
					status.textContent = "";
				}
			}
		});
	});
}

function renderRenamingTable() {
	var tbody = qs("renamingTableBody");
	if (!tbody) {
		return;
	}
	tbody.innerHTML = "";
	var order = wizardState.cziImport.slice_order || [];
	var readOnly = wizardState.cziImport.slice_numbering === cziImport.SLICE_NUMBERING_PRESERVE;
	for (var i = 0; i < order.length; i++) {
		var entry = order[i];
		var tr = document.createElement("tr");
		var input =
			'<input type="text" class="form-control form-control-sm slice-id-input" data-ordinal="' +
			entry.ordinal +
			'" value="' +
			String(entry.sliceId || "").replace(/"/g, "&quot;") +
			'"' +
			(readOnly ? " readonly" : "") +
			" />";
		tr.innerHTML =
			"<td>" +
			entry.ordinal +
			"</td><td>" +
			(entry.basename || "—") +
			"</td><td>" +
			entry.scene_index +
			"</td><td>" +
			(entry.originalSliceId || "—") +
			"</td><td>" +
			input +
			"</td><td class=\"small text-break\">" +
			(entry.source_dir || "—") +
			"</td>";
		tbody.appendChild(tr);
	}
	tbody.querySelectorAll(".slice-id-input").forEach(function (inp) {
		inp.addEventListener("change", function (ev) {
			var ordinal = Number(ev.target.getAttribute("data-ordinal"));
			var orderList = wizardState.cziImport.slice_order || [];
			for (var j = 0; j < orderList.length; j++) {
				if (orderList[j].ordinal === ordinal) {
					orderList[j].sliceId = ev.target.value.trim();
					break;
				}
			}
			cziImport.syncScenesFromSliceOrder(wizardState.cziImport);
			updateStep3Validation();
		});
	});
}

function primarySignalLabel(roleKey) {
	if (roleKey === cziImport.ROLE_SIGNAL_SOMATA) {
		return "Somata / rabies";
	}
	if (roleKey === cziImport.ROLE_SIGNAL_NUCLEI) {
		return "Nuclei";
	}
	if (roleKey === cziImport.ROLE_SIGNAL_AXONS) {
		return "Axons";
	}
	if (String(roleKey).indexOf("other:") === 0) {
		return "Other: " + roleKey.slice(6);
	}
	return roleKey;
}

function renderPrimarySignalSelect() {
	var sel = qs("primarySignalRole");
	if (!sel) {
		return;
	}
	var keys = cziImport.collectKeptSignalRoleKeys(wizardState.cziImport);
	if (!keys.length) {
		keys = [cziImport.ROLE_SIGNAL_SOMATA];
	}
	var current = wizardState.cziImport.primary_signal_role || cziImport.ROLE_SIGNAL_SOMATA;
	if (keys.indexOf(current) < 0) {
		current = keys[0];
		wizardState.cziImport.primary_signal_role = current;
	}
	sel.innerHTML = "";
	for (var i = 0; i < keys.length; i++) {
		sel.innerHTML +=
			'<option value="' +
			keys[i] +
			'"' +
			(keys[i] === current ? " selected" : "") +
			">" +
			primarySignalLabel(keys[i]) +
			"</option>";
	}
}

function renderMosaicInfo(files) {
	var box = qs("mosaicInfoBox");
	if (!box) {
		return;
	}
	var infos = cziImport.collectMosaicInfo(files);
	if (!infos.length) {
		box.classList.add("d-none");
		box.innerHTML = "";
		return;
	}
	var html =
		"<strong>Mosaic files detected:</strong> These CZIs contain mosaic tile structure. " +
		"This is normal for ZEN-stitched exports.<ul class=\"mb-0 mt-2\">";
	for (var i = 0; i < infos.length; i++) {
		var info = infos[i];
		var label = info.basename ? "<code>" + info.basename + "</code>: " : "";
		html += "<li>" + label + info.message + "</li>";
	}
	html += "</ul>";
	box.innerHTML = html;
	box.classList.remove("d-none");
}

function renderMosaicWarnings(files) {
	var box = qs("mosaicWarningBox");
	if (!box) {
		return;
	}
	var warnings = cziImport.collectMosaicWarnings(files);
	if (!warnings.length) {
		box.classList.add("d-none");
		box.innerHTML = "";
		return;
	}
	var html =
		"<strong>Mosaic stitch check:</strong> One or more files may be unstitched tile sets. " +
		"Stitch mosaics in ZEN before export when possible. Import will continue but geometry may be wrong.<ul class=\"mb-0 mt-2\">";
	for (var i = 0; i < warnings.length; i++) {
		var w = warnings[i];
		var label = w.basename ? "<code>" + w.basename + "</code>: " : "";
		html += "<li>" + label + w.message + "</li>";
	}
	html += "</ul>";
	box.innerHTML = html;
	box.classList.remove("d-none");
}

function mosaicTableLabel(f) {
	if (f.error) {
		return "—";
	}
	if (f.is_mosaic !== true) {
		return f.is_mosaic === false ? "No" : "—";
	}
	var tiles = f.m_tile_count != null ? f.m_tile_count : f.has_m_dim ? "2+" : "?";
	var label = "Yes";
	if (tiles !== "?" && tiles !== 1) {
		label += " (" + tiles + " tiles)";
	}
	if (f.likely_unstitched || f.mosaic_stitch_status === "suspect") {
		label += ' <span class="text-warning">unstitched?</span>';
	}
	return label;
}

function renderCziFileTable(files) {
	var tbody = qs("cziFileTableBody");
	if (!tbody) {
		return;
	}
	renderMosaicInfo(files);
	renderMosaicWarnings(files);
	tbody.innerHTML = "";
	for (var i = 0; i < files.length; i++) {
		var f = files[i];
		var tr = document.createElement("tr");
		if (f.likely_unstitched || f.mosaic_stitch_status === "suspect") {
			tr.classList.add("table-warning");
		}
		var err = f.error ? ' <span class="text-danger">' + f.error + "</span>" : "";
		var mosaicLabel = mosaicTableLabel(f);
		tr.innerHTML =
			"<td>" +
			(f.basename || path.basename(f.path || "")) +
			err +
			"</td><td>" +
			(f.scene_count != null ? f.scene_count : "—") +
			"</td><td>" +
			(f.channel_count != null ? f.channel_count : "—") +
			"</td><td>" +
			(f.z_count != null ? f.z_count : "—") +
			"</td><td>" +
			mosaicLabel +
			"</td>";
		tbody.appendChild(tr);
	}
}

function roleOptionsHtml(selectedRole) {
	var html = "";
	var opts = cziImport.CHANNEL_ROLE_OPTIONS;
	for (var o = 0; o < opts.length; o++) {
		html +=
			'<option value="' +
			opts[o].value +
			'"' +
			(selectedRole === opts[o].value ? " selected" : "") +
			">" +
			opts[o].label +
			"</option>";
	}
	return html;
}

function validateStep3() {
	var channels = wizardState.cziImport.channels || [];
	var kept = channels.filter(function (ch) {
		return ch.keep;
	});
	if (!kept.length) {
		return "Keep at least one channel.";
	}
	for (var i = 0; i < channels.length; i++) {
		var ch = channels[i];
		if (ch.role === cziImport.ROLE_OTHER && ch.keep && !cziImport.sanitizeOtherName(ch.other_name)) {
			return "Enter a valid name for all Other signal channels (letters, numbers, _ and -).";
		}
	}
	var sliceErr = cziImport.validateSliceOrder(wizardState.cziImport);
	if (sliceErr) {
		return sliceErr;
	}
	var signalKeys = cziImport.collectKeptSignalRoleKeys(wizardState.cziImport);
	if (
		signalKeys.length &&
		signalKeys.indexOf(wizardState.cziImport.primary_signal_role) < 0
	) {
		return "Choose a primary signal from kept signal channels.";
	}
	return "";
}

function updateStep3Validation() {
	var msg = validateStep3();
	var el = qs("step3Validation");
	var nextBtn = qs("step3Next");
	if (el) {
		if (msg) {
			el.textContent = msg;
			el.classList.remove("d-none");
		} else {
			el.textContent = "";
			el.classList.add("d-none");
		}
	}
	if (nextBtn) {
		nextBtn.disabled = !!msg;
	}
}

function syncKeepAllCheckbox() {
	var master = qs("keepAllChannels");
	if (!master) {
		return;
	}
	var channels = wizardState.cziImport.channels || [];
	if (!channels.length) {
		master.checked = false;
		master.indeterminate = false;
		return;
	}
	var kept = channels.filter(function (ch) {
		return ch.keep;
	}).length;
	master.checked = kept === channels.length;
	master.indeterminate = kept > 0 && kept < channels.length;
}

function renderGlobalChannelBar() {
	var indices = cziImport.collectChannelIndices(wizardState.cziImport);
	var indexSel = qs("globalChannelIndex");
	var roleSel = qs("globalChannelRole");
	var otherWrap = qs("otherNameGlobalWrap");
	var otherInput = qs("otherNameGlobal");
	var hint = qs("globalChannelHint");
	if (!indexSel || !roleSel) {
		return;
	}
	var selectedIndex =
		indexSel.value !== "" && indices.indexOf(Number(indexSel.value)) >= 0
			? Number(indexSel.value)
			: indices.length
				? indices[0]
				: 0;
	indexSel.innerHTML = "";
	for (var i = 0; i < indices.length; i++) {
		indexSel.innerHTML +=
			'<option value="' +
			indices[i] +
			'"' +
			(indices[i] === selectedIndex ? " selected" : "") +
			">Ch " +
			indices[i] +
			"</option>";
	}
	roleSel.innerHTML = roleOptionsHtml(cziImport.ROLE_SIGNAL_SOMATA);
	var defaults = (wizardState.cziImport.channel_defaults || {})[String(selectedIndex)] || {};
	roleSel.value = defaults.role || cziImport.ROLE_SIGNAL_SOMATA;
	if (otherInput) {
		otherInput.value = defaults.other_name || "";
	}
	if (otherWrap) {
		if (roleSel.value === cziImport.ROLE_OTHER) {
			otherWrap.classList.remove("d-none");
		} else {
			otherWrap.classList.add("d-none");
		}
	}
	if (hint) {
		hint.textContent = indices.length
			? "Set role for channel index " +
				selectedIndex +
				" and apply to every file row with that index."
			: "No channels probed yet.";
	}
	var applyBtn = qs("applyChannelDefaults");
	if (applyBtn) {
		applyBtn.textContent = "Apply to all Ch " + selectedIndex;
	}
}

function applyGlobalChannelDefaults() {
	var indexSel = qs("globalChannelIndex");
	var roleSel = qs("globalChannelRole");
	var otherInput = qs("otherNameGlobal");
	if (!indexSel || !roleSel) {
		return;
	}
	var channelIndex = Number(indexSel.value);
	var role = roleSel.value;
	var otherName = "";
	if (role === cziImport.ROLE_OTHER && otherInput) {
		otherName = cziImport.sanitizeOtherName(otherInput.value) || otherInput.value.trim();
		otherInput.value = otherName;
	}
	cziImport.applyChannelDefaults(wizardState.cziImport, channelIndex, {
		role: role,
		other_name: otherName,
	});
	renderChannelTable();
}

function renderChannelTable() {
	var tbody = qs("channelTableBody");
	if (!tbody) {
		return;
	}
	tbody.innerHTML = "";
	var channels = wizardState.cziImport.channels || [];
	for (var i = 0; i < channels.length; i++) {
		var ch = channels[i];
		var tr = document.createElement("tr");
		var roleCell = '<select class="form-select form-select-sm channel-role" data-idx="' + i + '">';
		roleCell += roleOptionsHtml(ch.role);
		roleCell += "</select>";
		if (ch.role === cziImport.ROLE_OTHER) {
			var invalidOther =
				ch.keep && !cziImport.sanitizeOtherName(ch.other_name);
			roleCell +=
				'<input type="text" class="form-control form-control-sm mt-1 channel-other-name' +
				(invalidOther ? " is-invalid" : "") +
				'" data-idx="' +
				i +
				'" maxlength="32" placeholder="custom_name" value="' +
				(ch.other_name || "").replace(/"/g, "&quot;") +
				'" />';
		}
		tr.innerHTML =
			"<td>" +
			ch.file +
			"</td><td>" +
			ch.index +
			"</td><td>" +
			(ch.label || "—") +
			"</td><td>" +
			roleCell +
			'</td><td><input type="checkbox" class="form-check-input channel-keep" data-idx="' +
			i +
			'"' +
			(ch.keep ? " checked" : "") +
			" /></td>";
		tbody.appendChild(tr);
	}

	tbody.querySelectorAll(".channel-role").forEach(function (sel) {
		sel.addEventListener("change", function (ev) {
			var idx = Number(ev.target.getAttribute("data-idx"));
			wizardState.cziImport.channels[idx].role = ev.target.value;
			if (ev.target.value !== cziImport.ROLE_OTHER) {
				delete wizardState.cziImport.channels[idx].other_name;
			} else if (!wizardState.cziImport.channels[idx].other_name) {
				wizardState.cziImport.channels[idx].other_name = "";
			}
			renderChannelTable();
		});
	});
	tbody.querySelectorAll(".channel-other-name").forEach(function (inp) {
		inp.addEventListener("blur", function (ev) {
			var idx = Number(ev.target.getAttribute("data-idx"));
			var sanitized = cziImport.sanitizeOtherName(ev.target.value);
			if (sanitized) {
				ev.target.value = sanitized;
				wizardState.cziImport.channels[idx].other_name = sanitized;
			} else {
				wizardState.cziImport.channels[idx].other_name = String(ev.target.value || "").trim();
			}
			renderChannelTable();
		});
		inp.addEventListener("input", function (ev) {
			var idx = Number(ev.target.getAttribute("data-idx"));
			wizardState.cziImport.channels[idx].other_name = ev.target.value;
			updateStep3Validation();
		});
	});
	tbody.querySelectorAll(".channel-keep").forEach(function (cb) {
		cb.addEventListener("change", function (ev) {
			var idx = Number(ev.target.getAttribute("data-idx"));
			wizardState.cziImport.channels[idx].keep = ev.target.checked;
			renderChannelTable();
		});
	});

	renderGlobalChannelBar();
	renderPrimarySignalSelect();
	syncSliceNumberingRadios();
	syncKeepAllCheckbox();
	updateStep3Validation();
}

function renderStep3Panel() {
	refreshSliceOrder();
	renderRenamingTable();
	renderChannelTable();
}

function defaultGeometry() {
	return { rotate: 0, flipX: false, flipY: false };
}

function ensureGeometryMap() {
	if (!wizardState.cziImport.geometry) {
		wizardState.cziImport.geometry = {};
	}
	var ids = cziImport.collectSliceIds(wizardState.cziImport);
	for (var i = 0; i < ids.length; i++) {
		if (!wizardState.cziImport.geometry[ids[i]]) {
			wizardState.cziImport.geometry[ids[i]] = defaultGeometry();
		}
	}
}

function fileUrlForPath(filePath) {
	if (!filePath) {
		return "";
	}
	return url.pathToFileURL(filePath).href;
}

function previewPathForSlice(sliceId) {
	return cziImport.resolveOrientPreviewPath(
		wizardState.bundleRoot,
		wizardState.cziImport,
		wizardState.importResult,
		sliceId,
	);
}

function renderOrientationGrid() {
	ensureGeometryMap();
	var grid = qs("orientGrid");
	if (!grid) {
		return;
	}
	grid.innerHTML = "";
	var ids = cziImport.collectSliceIds(wizardState.cziImport);
	for (var i = 0; i < ids.length; i++) {
		var sliceId = ids[i];
		var geom = wizardState.cziImport.geometry[sliceId];
		var tile = document.createElement("div");
		tile.className = "czi-orient-tile";
		tile.setAttribute("data-slice-id", sliceId);
		var imgPath = previewPathForSlice(sliceId);
		var imgSrc = fileUrlForPath(imgPath);
		var imgHtml = imgSrc
			? '<img src="' + imgSrc + '" alt="' + sliceId + '" />'
			: '<p class="small text-muted">No preview</p>';
		tile.innerHTML =
			"<strong>" +
			sliceId +
			"</strong>" +
			imgHtml +
			'<div class="btn-group btn-group-sm mt-1 w-100" role="group">' +
			'<button type="button" class="btn btn-outline-secondary" data-geo="rot90" data-slice="' +
			sliceId +
			'">↻90°</button>' +
			'<button type="button" class="btn btn-outline-secondary" data-geo="flipX" data-slice="' +
			sliceId +
			'">↔</button>' +
			'<button type="button" class="btn btn-outline-secondary" data-geo="flipY" data-slice="' +
			sliceId +
			'">↕</button>' +
			"</div>" +
			'<p class="small text-muted mb-0 mt-1">rot ' +
			(geom.rotate || 0) +
			"° flipX=" +
			!!geom.flipX +
			" flipY=" +
			!!geom.flipY +
			"</p>";
		grid.appendChild(tile);
	}

	grid.querySelectorAll("button[data-geo]").forEach(function (btn) {
		btn.addEventListener("click", function (ev) {
			var sid = ev.target.getAttribute("data-slice");
			var action = ev.target.getAttribute("data-geo");
			var g = wizardState.cziImport.geometry[sid];
			if (!g) {
				g = defaultGeometry();
				wizardState.cziImport.geometry[sid] = g;
			}
			if (action === "rot90") {
				g.rotate = ((Number(g.rotate) || 0) + 90) % 360;
			} else if (action === "flipX") {
				g.flipX = !g.flipX;
			} else if (action === "flipY") {
				g.flipY = !g.flipY;
			}
			renderOrientationGrid();
		});
	});
}

function writeImportConfig() {
	var meta = path.join(wizardState.bundleRoot, branding.META_DIR);
	fs.mkdirSync(meta, { recursive: true });
	var cfgPath = cziImport.importConfigPath(wizardState.bundleRoot);
	var payload = Object.assign({}, wizardState.cziImport);
	payload.config_fingerprint = cziImport.cziImportFingerprint(payload);
	if (wizardState.repairMode) {
		payload.repair_mode = "previews";
		payload.repair_targets = wizardState.repairTargets || [];
	} else {
		delete payload.repair_mode;
		delete payload.repair_targets;
	}
	fs.writeFileSync(cfgPath, JSON.stringify({ czi_import: payload }, null, 2), "utf8");
	return cfgPath;
}

function persistCziSettings() {
	var proj = project.getProject();
	if (!proj) {
		return;
	}
	if (!proj.settings) {
		proj.settings = {};
	}
	proj.settings.czi_import = wizardState.cziImport;
	if (wizardState.importResult && wizardState.importResult.max_runs) {
		proj.settings.czi_import.max_runs = wizardState.importResult.max_runs;
	}
	proj.settings.czi_import.config_fingerprint = cziImport.cziImportFingerprint(
		wizardState.cziImport,
	);
	proj.settings.czi_import.preview_format_version =
		(wizardState.importResult && wizardState.importResult.preview_format_version) ||
		cziImport.PREVIEW_FORMAT_VERSION;
	proj.sources = proj.sources || {};
	proj.sources.original_scans =
		(wizardState.cziSourceDirs && wizardState.cziSourceDirs[0]) ||
		wizardState.cziImport.source_dir ||
		"";
	project.saveProjectJson();
}

function setActiveMaxRuns() {
	var result = wizardState.importResult || {};
	var maxRuns = result.max_runs || {};
	var primaryRel = cziImport.primaryMaxRunRel(wizardState.cziImport, result);
	if (primaryRel) {
		pipelineRuns.setActiveRunRelForRole("max", primaryRel);
	}
	var keys = Object.keys(maxRuns);
	for (var i = 0; i < keys.length; i++) {
		if (maxRuns[keys[i]] && keys[i] !== wizardState.cziImport.primary_signal_role) {
			/* only one active max leaf — primary wins */
		}
	}
}

/** After extract/repair: set active max run and rebuild file index (DAPI + max). */
async function syncProjectIndexAfterExtract() {
	if (!wizardState.bundleRoot) {
		return { matchedCount: 0 };
	}
	setActiveMaxRuns();
	await project.refreshProjectIndex(wizardState.bundleRoot);
	var index = project.readProjectFileIndex(wizardState.bundleRoot);
	var report = project.computeMatchReport(index, ["dapi", "max"]);
	var matchedCount = (report.matchedSliceIds || []).length;
	verboseExtractLog(
		"File index updated: " + matchedCount + " slice(s) matched between DAPI and max.",
	);
	return { matchedCount: matchedCount };
}

function updateExtractIndexNote(matchedCount) {
	var detail = qs("extractDetail");
	if (!detail) {
		return;
	}
	detail.textContent =
		"File index updated — " +
		matchedCount +
		" slice(s) matched between DAPI and max. " +
		"Refreshes again after you confirm geometry (finish step). " +
		"Detailed lines also appear in the application log window.";
}

function probeSingleDir(dir, scanIndex) {
	var status = qs("probeStatus");
	return new Promise(function (resolve, reject) {
		function onLoadProgress(ev, data) {
			if (status && data[1]) {
				status.textContent = data[1];
			}
		}
		function onResult(ev, payload) {
			ipc.removeListener("updateLoad", onLoadProgress);
			ipc.removeListener("cziProbeResult", onResult);
			if (!payload || payload.ok === false) {
				reject(new Error((payload && payload.error) || "Probe failed for " + dir));
				return;
			}
			cziImport.mergeProbeDirIntoImport(wizardState.cziImport, payload, dir, scanIndex);
			resolve(payload);
		}
		ipc.on("updateLoad", onLoadProgress);
		ipc.once("cziProbeResult", onResult);
		ipc.send("runCziProbe", [dir]);
	});
}

async function runProbeAll() {
	if (probeInFlight) {
		ipc.send("killCziProbe");
		await new Promise(function (resolve) {
			setTimeout(resolve, 150);
		});
	}
	probeInFlight = true;
	setProbeControlsBusy(true);
	var dirs = wizardState.cziSourceDirs || [];
	var status = qs("probeStatus");
	var nextBtn = qs("step2Next");
	if (nextBtn) {
		nextBtn.disabled = true;
	}
	try {
		if (!dirs.length) {
			if (status) {
				status.textContent = "";
			}
			renderCziFileTable([]);
			return;
		}
		wizardState.cziImport.source_dirs = dirs.slice();
		wizardState.cziImport.files = (wizardState.cziImport.files || []).filter(function (f) {
			return dirs.indexOf(f.source_dir) >= 0;
		});
		if (status) {
			status.textContent = "Probing " + dirs.length + " folder(s)…";
		}
		for (var i = 0; i < dirs.length; i++) {
			if (status) {
				status.textContent = "Probing folder " + (i + 1) + "/" + dirs.length + ": " + dirs[i];
			}
			await probeSingleDir(dirs[i], i);
		}
		applySliceNumberingDefault();
		refreshSliceOrder();
		renderSourceDirList();
		renderCziFileTable(wizardState.cziImport.files || []);
		if (status) {
			status.textContent =
				(wizardState.cziImport.files || []).length +
				" file(s) from " +
				dirs.length +
				" folder(s) probed.";
		}
		if (nextBtn) {
			nextBtn.disabled = !(wizardState.cziImport.files && wizardState.cziImport.files.length);
		}
	} finally {
		probeInFlight = false;
		setProbeControlsBusy(false);
	}
}

function hydrateWizardFromSavedCziImport(saved) {
	wizardState.cziImport = JSON.parse(JSON.stringify(saved));
	wizardState.cziSourceDirs = (saved.source_dirs || []).slice();
	if (!wizardState.cziSourceDirs.length && saved.source_dir) {
		wizardState.cziSourceDirs = [saved.source_dir];
	}
	wizardState.importResult = {
		max_runs: saved.max_runs || {},
		primary_signal_role: saved.primary_signal_role,
		preview_format_version: saved.preview_format_version,
	};
}

async function tryResumeCziImportAfterStep1() {
	if (!wizardState.bundleRoot || !fs.existsSync(wizardState.bundleRoot)) {
		return false;
	}
	project.openProject(wizardState.bundleRoot);
	var proj = project.getProject();
	var saved = proj && proj.settings && proj.settings.czi_import;
	if (!saved || !saved.files || !saved.files.length) {
		return false;
	}
	hydrateWizardFromSavedCziImport(saved);
	var expectedFp = cziImport.cziImportFingerprint(saved);
	if (saved.config_fingerprint && saved.config_fingerprint !== expectedFp) {
		verboseExtractLog("Saved CZI import fingerprint mismatch — full wizard");
		return false;
	}
	var audit = cziImport.auditCziImportCompletion(wizardState.bundleRoot, saved, {
		importResult: wizardState.importResult,
	});
	if (!audit.extractComplete) {
		return false;
	}
	if (audit.canSkipToOrient) {
		verboseExtractLog("Resuming — extract already complete.");
		await syncProjectIndexAfterExtract();
		renderOrientationGrid();
		setStep(5);
		return true;
	}
	if (audit.needsPreviewRepair) {
		wizardState.repairMode = true;
		wizardState.repairTargets = cziImport.buildRepairTargetsFromAudit(audit);
		verboseExtractLog(
			"Repairing " + wizardState.repairTargets.length + " preview(s) from existing z-stacks…",
		);
		try {
			await runExtract({ repairOnly: true });
			await syncProjectIndexAfterExtract();
			renderOrientationGrid();
			setStep(5);
			return true;
		} catch (err) {
			wizardState.repairMode = false;
			wizardState.repairTargets = [];
			throw err;
		}
	}
	return false;
}

async function ensureBundleCreated() {
	if (fs.existsSync(wizardState.bundleRoot)) {
		project.openProject(wizardState.bundleRoot);
		return;
	}
	fs.mkdirSync(wizardState.bundleRoot, { recursive: true });
	var name = (qs("projectName") && qs("projectName").value) || path.basename(wizardState.bundleRoot);
	project.createProject({
		bundleRoot: wizardState.bundleRoot,
		name: name,
		projectFilename: wizardState.projectFilename,
		settings: { czi_import: wizardState.cziImport },
	});
	project.openProject(wizardState.bundleRoot);
}

async function runExtract(options) {
	options = options || {};
	extractRunning = true;
	if (!options.repairOnly) {
		wizardState.repairMode = false;
		wizardState.repairTargets = [];
	}
	setStep(4);
	var cancelBtn = qs("cancelExtract");
	var logEl = qs("extractLog");
	if (logEl) {
		logEl.textContent = "";
	}
	if (cancelBtn) {
		cancelBtn.classList.remove("d-none");
	}
	setExtractNavDisabled(true);
	updateWizardCancelVisibility();
	setExtractActivity("Preparing bundle and config…", 2);
	verboseExtractLog(
		wizardState.repairMode ? "Starting preview repair…" : "Starting CZI extraction…",
	);

	await ensureBundleCreated();
	writeImportConfig();
	persistCziSettings();

	var cfg = wizardState.cziImport;
	var workEstimate = cziImport.countExtractWorkItems(cfg);
	var kept = countKeptChannels(cfg);
	verboseExtractLog("Bundle: " + wizardState.bundleRoot);
	verboseExtractLog(
		"CZI source: " +
			((wizardState.cziSourceDirs || []).join("; ") ||
				cfg.source_dirs && cfg.source_dirs.join("; ") ||
				cfg.source_dir ||
				"(none)"),
	);
	verboseExtractLog(
		kept +
			" channel(s) marked to keep; estimated " +
			(workEstimate || "?") +
			" extraction item(s)",
	);
	setExtractActivity("Writing import config…", 4);

	return new Promise(function (resolve, reject) {
		function onJobLog(ev, msg) {
			markPythonActivity();
			verboseExtractLog(msg);
			var status = qs("extractStatus");
			if (status && msg) {
				status.textContent = truncateStatus(msg, 120);
			}
		}
		function onProgress(ev, data) {
			markPythonActivity();
			var rawPct = data[0];
			var message = data[1];
			if (/^Ready —/i.test(String(message || ""))) {
				markPythonActivity();
			}
			var displayPct = mapExtractDisplayPct(rawPct, message);
			setExtractActivity(formatExtractStatus(rawPct, message), displayPct);
		}
		function finishExtractNav() {
			extractRunning = false;
			clearExtractWaitTimers();
			setExtractNavDisabled(false);
			updateWizardCancelVisibility();
			if (cancelBtn) {
				cancelBtn.classList.add("d-none");
			}
		}
		function onResult(ev, payload) {
			ipc.removeListener("updateLoad", onProgress);
			ipc.removeListener("cziJobLog", onJobLog);
			ipc.removeListener("cziImportResult", onResult);
			finishExtractNav();
			if (!payload || payload.ok === false) {
				var errMsg = (payload && payload.error) || "Import failed";
				setExtractActivity("Extract failed: " + errMsg, 0);
				verboseExtractLog("ERROR: " + errMsg);
				reject(new Error(errMsg));
				return;
			}
			wizardState.importResult = payload;
			if (payload.max_runs) {
				wizardState.cziImport.max_runs = payload.max_runs;
			}
			wizardState.cziImport.preview_format_version =
				payload.preview_format_version || cziImport.PREVIEW_FORMAT_VERSION;
			wizardState.repairMode = false;
			wizardState.repairTargets = [];
			persistCziSettings();
			var primary = payload.primary_signal_role || wizardState.cziImport.primary_signal_role;
			var summary =
				"Extract complete — primary signal: " +
				(primary || "(none)") +
				"; max runs: " +
				Object.keys(payload.max_runs || {}).length;
			setExtractActivity(summary, 100);
			verboseExtractLog(summary);
			if (payload.max_runs) {
				var keys = Object.keys(payload.max_runs);
				for (var k = 0; k < keys.length; k++) {
					verboseExtractLog("  " + keys[k] + " → " + payload.max_runs[keys[k]]);
				}
			}
			syncProjectIndexAfterExtract()
				.then(function (info) {
					updateExtractIndexNote(info.matchedCount);
					resolve(payload);
				})
				.catch(function (indexErr) {
					verboseExtractLog(
						"File index update failed (continuing): " + String(indexErr.message || indexErr),
					);
					resolve(payload);
				});
		}
		ipc.on("updateLoad", onProgress);
		ipc.on("cziJobLog", onJobLog);
		ipc.once("cziImportResult", onResult);
		var cfgPath = writeImportConfig();
		verboseExtractLog("Config: " + cfgPath);
		setExtractActivity("Starting Python extract…", 5);
		startExtractWaitFeedback();
		ipc.send("runCziImport", [
			String(wizardState.bundleRoot || "").trim(),
			String(cfgPath || "").trim(),
		]);
	});
}

async function runApplyGeometry() {
	setStep(6);
	var status = qs("finishStatus");
	var wrap = qs("finishProgressWrap");
	var bar = qs("finishProgress");
	if (status) {
		status.textContent = "Applying geometry to all derived TIFFs…";
	}
	if (wrap) {
		wrap.classList.remove("d-none");
	}
	writeImportConfig();
	persistCziSettings();

	return new Promise(function (resolve, reject) {
		function onProgress(ev, data) {
			if (bar) {
				bar.style.width = String(data[0]) + "%";
			}
			if (status) {
				status.textContent = data[1];
			}
		}
		function onResult(ev, payload) {
			ipc.removeListener("updateLoad", onProgress);
			ipc.removeListener("applyGeometryResult", onResult);
			if (!payload || payload.ok === false) {
				if (status) {
					status.textContent = (payload && payload.error) || "Geometry apply failed";
				}
				reject(new Error((payload && payload.error) || "Geometry apply failed"));
				return;
			}
			finishWizard();
			resolve(payload);
		}
		ipc.on("updateLoad", onProgress);
		ipc.once("applyGeometryResult", onResult);
		var cfgPath = cziImport.importConfigPath(wizardState.bundleRoot);
		ipc.send("runApplyGeometry", [
			String(wizardState.bundleRoot || "").trim(),
			String(cfgPath || "").trim(),
		]);
	});
}

async function finishWizard() {
	setActiveMaxRuns();
	await project.refreshProjectIndex(wizardState.bundleRoot);
	var status = qs("finishStatus");
	var openBtn = qs("openWorkspace");
	if (status) {
		var report = project.computeMatchReport(
			project.readProjectFileIndex(wizardState.bundleRoot),
			["dapi", "max"],
		);
		status.textContent =
			"Import complete. " +
			(report.matchedSliceIds || []).length +
			" slice(s) matched between DAPI and max.";
	}
	if (openBtn) {
		openBtn.classList.remove("d-none");
	}
}

function bindStep1() {
	var nameEl = qs("projectName");
	if (nameEl) {
		nameEl.addEventListener("input", updateBundlePathPreview);
	}
	qs("chooseParent").addEventListener("click", function () {
		ipc.once("returnPath", function (event, response) {
			if (response[0]) {
				wizardState.parentDir = response[0];
				qs("parentDir").value = response[0];
				updateBundlePathPreview();
			}
		});
		ipc.send("openDialog", { tag: "cziParent", defaultPath: wizardState.parentDir });
	});
	qs("step1Next").addEventListener("click", function () {
		if (!wizardState.bundleRoot) {
			alert("Choose parent folder and project name.");
			return;
		}
		tryResumeCziImportAfterStep1()
			.then(function (resumed) {
				if (!resumed) {
					setStep(2);
				}
			})
			.catch(function (err) {
				console.error("[CziWizard] resume", err);
				alert(String(err.message || err));
				setStep(2);
			});
	});
}

function bindStep2() {
	qs("addCziDir").addEventListener("click", function () {
		ipc.once("returnPath", function (event, response) {
			if (!response[0]) {
				return;
			}
			var dir = response[0];
			if (wizardState.cziSourceDirs.indexOf(dir) >= 0) {
				alert("That folder is already in the list.");
				return;
			}
			wizardState.cziSourceDirs.push(dir);
			renderSourceDirList();
			runProbeAll().catch(function (err) {
				alert(String(err.message || err));
			});
		});
		ipc.send("openDialog", {
			tag: "cziSource",
			defaultPath:
				(wizardState.cziSourceDirs.length &&
					wizardState.cziSourceDirs[wizardState.cziSourceDirs.length - 1]) ||
				wizardState.parentDir,
		});
	});
	renderSourceDirList();
	qs("step2Back").addEventListener("click", function () {
		setStep(1);
	});
	qs("step2Next").addEventListener("click", function () {
		setStep(3);
		yieldToUi().then(function () {
			renderStep3Panel();
		});
	});
}

function bindStep3() {
	var preserveRadio = qs("sliceNumberingPreserve");
	var renameRadio = qs("sliceNumberingRename");
	function onSliceNumberingChange() {
		wizardState.cziImport.slice_numbering = preserveRadio && preserveRadio.checked
			? cziImport.SLICE_NUMBERING_PRESERVE
			: cziImport.SLICE_NUMBERING_RENAME;
		renderStep3Panel();
	}
	if (preserveRadio) {
		preserveRadio.addEventListener("change", onSliceNumberingChange);
	}
	if (renameRadio) {
		renameRadio.addEventListener("change", onSliceNumberingChange);
	}
	var primarySel = qs("primarySignalRole");
	if (primarySel) {
		primarySel.addEventListener("change", function () {
			wizardState.cziImport.primary_signal_role = primarySel.value;
			updateStep3Validation();
		});
	}
	var globalRole = qs("globalChannelRole");
	if (globalRole) {
		globalRole.addEventListener("change", function () {
			var otherWrap = qs("otherNameGlobalWrap");
			if (otherWrap) {
				if (globalRole.value === cziImport.ROLE_OTHER) {
					otherWrap.classList.remove("d-none");
				} else {
					otherWrap.classList.add("d-none");
				}
			}
		});
	}
	var globalIndex = qs("globalChannelIndex");
	if (globalIndex) {
		globalIndex.addEventListener("change", function () {
			renderGlobalChannelBar();
		});
	}
	var applyBtn = qs("applyChannelDefaults");
	if (applyBtn) {
		applyBtn.addEventListener("click", function () {
			applyGlobalChannelDefaults();
		});
	}
	var keepAll = qs("keepAllChannels");
	if (keepAll) {
		keepAll.addEventListener("change", function () {
			var checked = keepAll.checked;
			var channels = wizardState.cziImport.channels || [];
			for (var i = 0; i < channels.length; i++) {
				channels[i].keep = checked;
			}
			renderChannelTable();
		});
	}
	qs("step3Back").addEventListener("click", function () {
		setStep(2);
	});
	qs("step3Next").addEventListener("click", function () {
		var err = validateStep3();
		if (err) {
			updateStep3Validation();
			return;
		}
		runExtract()
			.then(function () {
				renderOrientationGrid();
				setStep(5);
			})
			.catch(function (err) {
				console.error("[CziWizard]", err);
				if (err && err.stack) {
					verboseExtractLog(err.stack);
				}
				alert(String(err.message || err));
			});
	});
}

function bindStep4() {
	var cancelBtn = qs("cancelExtract");
	if (cancelBtn) {
		cancelBtn.addEventListener("click", function () {
			verboseExtractLog("Cancelling extraction…");
			setExtractActivity("Cancelling extraction…", null);
			ipc.send("killCziImport");
		});
	}
}

function bindStep5() {
	qs("step5Back").addEventListener("click", function () {
		setStep(4);
	});
	qs("orientApplyAll").addEventListener("click", function () {
		var ids = cziImport.collectSliceIds(wizardState.cziImport);
		if (!ids.length) {
			return;
		}
		var first = wizardState.cziImport.geometry[ids[0]];
		for (var i = 1; i < ids.length; i++) {
			wizardState.cziImport.geometry[ids[i]] = {
				rotate: first.rotate,
				flipX: first.flipX,
				flipY: first.flipY,
			};
		}
		renderOrientationGrid();
	});
	qs("step5Next").addEventListener("click", function () {
		runApplyGeometry().catch(function (err) {
			alert(String(err.message || err));
		});
	});
}

pageInit.onReady(function () {
	pageInit.installGlobalErrorHandler();
	bindStep1();
	bindStep2();
	bindStep3();
	bindStep4();
	bindStep5();
	setStep(1);
});
