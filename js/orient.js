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
var branding = require("./branding");

project.tryRestoreActiveProject();
pipelineGate.assertPipelineAccess();

var geometryRunning = false;
var orientState = {
	bundleRoot: "",
	cziImport: null,
	displayChannel: cziImport.ORIENT_DISPLAY_DAPI,
};

function qs(id) {
	return document.getElementById(id);
}

function fileUrlForPath(filePath) {
	if (!filePath) {
		return "";
	}
	try {
		return url.pathToFileURL(path.resolve(filePath)).href;
	} catch (e) {
		return url.pathToFileURL(filePath).href;
	}
}

function verboseLog(msg) {
	console.log("[Orient]", msg);
	var el = qs("orientLog");
	if (el) {
		el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
		el.scrollTop = el.scrollHeight;
	}
}

function setActivity(msg, pct) {
	var bar = qs("orientProgress");
	var status = qs("orientStatus");
	if (status && msg) {
		status.textContent = msg;
	}
	if (bar && typeof pct === "number") {
		bar.style.width = String(pct) + "%";
		bar.setAttribute("aria-valuenow", String(pct));
		if (pct >= 100) {
			bar.classList.remove("progress-bar-striped", "progress-bar-animated");
		} else {
			bar.classList.add("progress-bar-striped", "progress-bar-animated");
		}
	}
}

function loadCziImportConfig() {
	var cfgPath = cziImport.importConfigPath(orientState.bundleRoot);
	if (fs.existsSync(cfgPath)) {
		try {
			var raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
			return raw.czi_import || raw;
		} catch (e) {
			console.warn("[Orient] config read failed", e);
		}
	}
	var proj = project.getProject() || {};
	if (proj.settings && proj.settings.czi_import) {
		return JSON.parse(JSON.stringify(proj.settings.czi_import));
	}
	return cziImport.buildDefaultCziImport("");
}

function collectSliceIdsFromIndex() {
	var index = project.readProjectFileIndex(orientState.bundleRoot);
	var byRole = (index && index.byRole) || {};
	var dapi = byRole.dapi || [];
	var ids = [];
	for (var i = 0; i < dapi.length; i++) {
		var stem = path.basename(String(dapi[i].name || dapi[i]), path.extname(String(dapi[i].name || dapi[i])));
		if (stem && ids.indexOf(stem) < 0) {
			ids.push(stem);
		}
	}
	ids.sort(function (a, b) {
		return cziImport.naturalCompare({ sliceId: a }, { sliceId: b });
	});
	return ids;
}

function ensureSlicePlan() {
	var cfg = orientState.cziImport;
	var ids = cziImport.collectSliceIds(cfg);
	if (!ids.length) {
		ids = collectSliceIdsFromIndex();
	}
	if (!ids.length) {
		return [];
	}
	if (!cfg.slice_order || !cfg.slice_order.length) {
		cfg.slice_order = ids.map(function (sid, idx) {
			return { ordinal: idx + 1, sliceId: sid, path: "", scene_index: 0 };
		});
	}
	cfg.geometry = orientGeometry.ensureGeometryMap(cfg.geometry || {}, ids);
	return ids;
}

function writeImportConfig() {
	var meta = path.join(orientState.bundleRoot, branding.META_DIR);
	fs.mkdirSync(meta, { recursive: true });
	var cfgPath = cziImport.importConfigPath(orientState.bundleRoot);
	var payload = Object.assign({}, orientState.cziImport);
	payload.config_fingerprint = cziImport.cziImportFingerprint(payload);
	fs.writeFileSync(cfgPath, JSON.stringify({ czi_import: payload }, null, 2), "utf8");
	return cfgPath;
}

function persistGeometryToProject() {
	var proj = project.getProject();
	if (!proj) {
		return;
	}
	proj.settings = proj.settings || {};
	proj.settings.czi_import = orientState.cziImport;
	project.saveProjectJson();
}

function previewPathForSlice(sliceId) {
	return cziImport.resolveOrientPreviewPath(
		orientState.bundleRoot,
		orientState.cziImport,
		null,
		sliceId,
		orientState.displayChannel,
	);
}

function populateOrientDisplayChannelSelect() {
	var select = qs("orientDisplayChannel");
	if (!select) {
		return;
	}
	var channels = cziImport.listOrientDisplayChannels(
		orientState.bundleRoot,
		orientState.cziImport,
	);
	select.innerHTML = "";
	for (var i = 0; i < channels.length; i++) {
		var opt = document.createElement("option");
		opt.value = channels[i].key;
		opt.textContent = channels[i].label;
		select.appendChild(opt);
	}
	var hasCurrent = channels.some(function (ch) {
		return ch.key === orientState.displayChannel;
	});
	if (!hasCurrent) {
		orientState.displayChannel = cziImport.ORIENT_DISPLAY_DAPI;
	}
	select.value = orientState.displayChannel;
}

function renderOrientationGrid() {
	var grid = qs("orientGrid");
	if (!grid) {
		return;
	}
	var ids = ensureSlicePlan();
	grid.innerHTML = "";
	for (var i = 0; i < ids.length; i++) {
		var sliceId = ids[i];
		var geom = orientState.cziImport.geometry[sliceId];
		var tile = document.createElement("div");
		tile.className = "czi-orient-tile";
		tile.setAttribute("data-slice-id", sliceId);
		var titleEl = document.createElement("strong");
		titleEl.textContent = sliceId;
		tile.appendChild(titleEl);
		var imgPath = previewPathForSlice(sliceId);
		var imgSrc = fileUrlForPath(imgPath);
		if (imgSrc) {
			var img = document.createElement("img");
			img.src = imgSrc;
			img.alt = sliceId;
			img.style.transform = orientGeometry.geometryCssTransform(geom);
			img.style.transformOrigin = "center center";
			img.onerror = function () {
				var msg = document.createElement("p");
				msg.className = "small text-muted";
				msg.textContent = "No preview";
				if (img.parentNode) {
					img.parentNode.replaceChild(msg, img);
				}
			};
			tile.appendChild(img);
		} else {
			var noPrev = document.createElement("p");
			noPrev.className = "small text-muted";
			noPrev.textContent = "No preview";
			tile.appendChild(noPrev);
		}
		var btnGroup = document.createElement("div");
		btnGroup.className = "btn-group btn-group-sm mt-1 w-100";
		btnGroup.setAttribute("role", "group");
		btnGroup.innerHTML =
			'<button type="button" class="btn btn-outline-secondary" data-geo="rot90" data-slice="' +
			sliceId +
			'">↻90°</button>' +
			'<button type="button" class="btn btn-outline-secondary" data-geo="flipX" data-slice="' +
			sliceId +
			'">↔</button>' +
			'<button type="button" class="btn btn-outline-secondary" data-geo="flipY" data-slice="' +
			sliceId +
			'">↕</button>';
		tile.appendChild(btnGroup);
		var status = document.createElement("p");
		status.className = "small text-muted mb-0 mt-1";
		status.textContent =
			"rot " +
			(geom.rotate || 0) +
			"° flipX=" +
			!!geom.flipX +
			" flipY=" +
			!!geom.flipY;
		tile.appendChild(status);
		grid.appendChild(tile);
	}

	grid.querySelectorAll("button[data-geo]").forEach(function (btn) {
		btn.addEventListener("click", function (ev) {
			var sid = ev.target.getAttribute("data-slice");
			var action = ev.target.getAttribute("data-geo");
			orientState.cziImport.geometry[sid] = orientGeometry.applyGeometryAction(
				orientState.cziImport.geometry[sid],
				action,
			);
			renderOrientationGrid();
		});
	});
}

function runApplyGeometry() {
	if (geometryRunning) {
		return Promise.reject(new Error("Geometry apply already running"));
	}
	geometryRunning = true;
	var applyBtn = qs("orientApply");
	if (applyBtn) {
		applyBtn.disabled = true;
	}
	var logEl = qs("orientLog");
	if (logEl) {
		logEl.textContent = "";
	}
	var ids = ensureSlicePlan();
	var geomCount = orientGeometry.countNonIdentityGeometry(orientState.cziImport.geometry, ids);
	verboseLog("Bundle: " + orientState.bundleRoot);
	verboseLog("Slices with rotation/flip: " + geomCount + " of " + ids.length);
	writeImportConfig();
	persistGeometryToProject();
	setActivity("Applying geometry…", 2);

	return new Promise(function (resolve, reject) {
		var fileTotal = 0;
		var fileDone = 0;
		var longJobWarned = false;
		var LONG_JOB_FILE_THRESHOLD = 40;

		function onProgress(ev, data) {
			var rawPct = Number(data[0]) || 0;
			var message = String(data[1] || "");
			var match = message.match(/\[(\d+)\/(\d+)\]/);
			if (match) {
				fileDone = Number(match[1]);
				fileTotal = Number(match[2]);
				rawPct = Math.min(99, Math.round((fileDone / fileTotal) * 100));
			}
			setActivity(message || "Applying geometry…", rawPct);
		}
		function onJobLog(ev, line) {
			var msg = String(line || "").trim();
			if (!msg) {
				return;
			}
			if (/^\d+$/.test(msg) && fileTotal === 0) {
				fileTotal = Number(msg);
				verboseLog("Transforming " + fileTotal + " file(s)…");
				if (fileTotal >= LONG_JOB_FILE_THRESHOLD && !longJobWarned) {
					longJobWarned = true;
					verboseLog(
						"Large geometry job (" +
							fileTotal +
							" files) — this may take several minutes. See Application log for detail.",
					);
					setActivity(
						"Large job: transforming " + fileTotal + " files (see log)…",
						5,
					);
				}
				return;
			}
			verboseLog(msg.replace(/^LOG:\s*/i, ""));
		}
		function onResult(ev, payload) {
			ipc.removeListener("updateLoad", onProgress);
			ipc.removeListener("cziJobLog", onJobLog);
			ipc.removeListener("applyGeometryResult", onResult);
			geometryRunning = false;
			if (applyBtn) {
				applyBtn.disabled = false;
			}
			if (!payload || payload.ok === false) {
				var errMsg = (payload && payload.error) || "Geometry apply failed";
				if (payload && payload.failed && payload.failed.length) {
					errMsg += ": " + payload.failed.join("; ");
				}
				setActivity("Geometry apply failed: " + errMsg, 0);
				verboseLog("ERROR: " + errMsg);
				reject(new Error(errMsg));
				return;
			}
			var summary =
				"Geometry applied — " +
				(payload.changed != null ? payload.changed : "?") +
				" file(s)";
			if (payload.files_total != null) {
				summary += " of " + payload.files_total;
			}
			if (payload.elapsed_sec != null) {
				summary += " in " + payload.elapsed_sec + "s";
			}
			if (payload.bytes_total != null) {
				summary += " (" + Math.round(payload.bytes_total / (1024 * 1024)) + " MB written)";
			}
			setActivity(summary, 100);
			verboseLog(summary);
			resolve(payload);
		}
		ipc.on("updateLoad", onProgress);
		ipc.on("cziJobLog", onJobLog);
		ipc.once("applyGeometryResult", onResult);
		var cfgPath = writeImportConfig();
		verboseLog("Config: " + cfgPath);
		setActivity("Starting Python geometry apply…", 5);
		ipc.send("runApplyGeometry", [
			String(orientState.bundleRoot || "").trim(),
			String(cfgPath || "").trim(),
		]);
	});
}

function init() {
	navTrail.renderTrail(
		[
			{ label: "Start", href: "./menu.html" },
			{ label: "Workspace", href: "./workspace_menu.html" },
			{ label: "Orient slices" },
		],
		"navTrail",
	);

	orientState.bundleRoot = project.getBundleRoot();
	if (!orientState.bundleRoot || !project.isActive()) {
		qs("orientMissing").classList.remove("d-none");
		return;
	}
	orientState.cziImport = loadCziImportConfig();
	var ids = ensureSlicePlan();
	if (!ids.length) {
		qs("orientMissing").classList.remove("d-none");
		qs("orientMissing").textContent =
			"No DAPI slice IDs found in the project index. Import CZI data or add PNG previews under 00_dapi first.";
		return;
	}
	qs("orientPanel").classList.remove("d-none");
	populateOrientDisplayChannelSelect();
	renderOrientationGrid();

	var displaySelect = qs("orientDisplayChannel");
	if (displaySelect) {
		displaySelect.addEventListener("change", function (ev) {
			orientState.displayChannel = ev.target.value;
			renderOrientationGrid();
		});
	}

	qs("orientApplyAll").addEventListener("click", function () {
		var sliceIds = ensureSlicePlan();
		if (!sliceIds.length) {
			return;
		}
		var first = orientState.cziImport.geometry[sliceIds[0]];
		for (var i = 1; i < sliceIds.length; i++) {
			orientState.cziImport.geometry[sliceIds[i]] = {
				rotate: first.rotate,
				flipX: first.flipX,
				flipY: first.flipY,
			};
		}
		renderOrientationGrid();
	});

	qs("orientApply").addEventListener("click", function () {
		runApplyGeometry().catch(function (err) {
			alert(String(err.message || err));
		});
	});
}

pageInit.onReady(function () {
	pageInit.installGlobalErrorHandler();
	init();
});
