"use strict";

/**
 * Floating “Loading project index…” overlay for inter-menu page populate only.
 * Never call show() from job-start handlers or wizard run steps.
 */

var project = require("./project");

// Append more lines anytime — picker reads .length.
var FUNNY_INDEX_MESSAGES = [
	"Counting mason jars…",
	"Herding Annotation files into neat piles…",
	"Asking the NAS politely for bandwidth…",
	"Warming up the amber UI…",
	"Untangling tangled slices…",
	"Convincing signals to sit still for their pictures…",
	"Dusting off structure_map…",
	"Aligning expectations…",
	"Checking for spare parts…",
	"Politely ignoring `errors errors errors`…",
	"Measuring how many PKLs fit in a mason jar…",
	"Teaching the file index to say “matched slice”…",
	"Trying to pronounce GIF...",
	"Rolling CCF labels like a very patient atlas…",
	"Percolating some kind of juice that makes this code work…",
	"Making sure Completed tasks remember their names…",
	"Scanning for hackers…",
	"Reminding the subset list who is invited…",
	"Fluffing the runs catalog…",
	"Counting neurons that someone asked for last week…",
	"Negotiating with SMB over coffee…",
	"Putting every leaf back where it belongs…",
	"Whispering “uint8 PNG only” to `00_dapi`…",
	"Double-checking that whole means the whole left half and the whole right half…",
	"Finding the active run before it finds me…",
	"Polishing the pipeline gate…",
	"Stacking manifests and storing them for the coming winter…",
	"Letting the spinner spin, this is his enrichment…",
	"Almost done—just let me catch my breath…",
	"Loading project index so I don't mess up your files…",
];

var OVERLAY_ID = "projectIndexBusyOverlay";
var LINE_COUNT = 4;
var LINE_OPACITIES = [0.25, 0.5, 0.75, 1];

var _visible = false;
var _consoleTimer = null;
var _lines = ["", "", "", ""];
var _lastMessage = "";
var _lineEls = null;

var RUN_LOG_SELECTORS = [
	"#extractLog",
	"#finishLog",
	"#probeLog",
	"#batchLog",
	"#wizardLog",
	"#runLog",
	"#repairLog",
	"#orientLog",
	"#geometryRepairLog",
];

function _qs(id) {
	if (typeof document === "undefined") {
		return null;
	}
	return document.getElementById(id);
}

function shouldRefuseShow() {
	if (typeof document === "undefined" || !document.body) {
		return true;
	}
	if (document.body.classList.contains("wizard-busy")) {
		return true;
	}
	for (var i = 0; i < RUN_LOG_SELECTORS.length; i++) {
		var el = document.querySelector(RUN_LOG_SELECTORS[i]);
		if (!el) {
			continue;
		}
		var step = el.closest(".wizard-step, [data-wizard-step], .tab-pane");
		if (step && step.classList.contains("d-none")) {
			continue;
		}
		if (el.offsetParent === null && !el.classList.contains("wizard-log")) {
			continue;
		}
		// If a verbose log has substantial content, a job is likely mid-run.
		if ((el.textContent || "").trim().length > 80) {
			return true;
		}
	}
	return false;
}

function pickFunnyMessage(avoid) {
	var list = FUNNY_INDEX_MESSAGES;
	if (!list.length) {
		return "";
	}
	if (list.length === 1) {
		return list[0];
	}
	var msg = list[Math.floor(Math.random() * list.length)];
	if (avoid && list.length > 1) {
		var guard = 0;
		while (msg === avoid && guard < 12) {
			msg = list[Math.floor(Math.random() * list.length)];
			guard++;
		}
	}
	return msg;
}

function randomConsoleDelayMs() {
	return 500 + Math.floor(Math.random() * 1501); // 500–2000 ms
}

/** Pure shift: returns a new 4-slot array (oldest drops off; newest at bottom). */
function shiftConsoleLines(lines, newBottom) {
	var src = lines && lines.length ? lines : ["", "", "", ""];
	return [src[1] || "", src[2] || "", src[3] || "", newBottom || ""];
}

function _renderLines() {
	if (!_lineEls) {
		return;
	}
	for (var i = 0; i < LINE_COUNT; i++) {
		_lineEls[i].textContent = _lines[i] || "\u00a0";
		_lineEls[i].style.opacity = String(LINE_OPACITIES[i]);
	}
}

function _scheduleNextConsoleLine() {
	_clearConsoleTimer();
	_consoleTimer = setTimeout(function () {
		_consoleTimer = null;
		if (!_visible) {
			return;
		}
		var next = pickFunnyMessage(_lastMessage);
		_lastMessage = next;
		_lines = shiftConsoleLines(_lines, next);
		_renderLines();
		_scheduleNextConsoleLine();
	}, randomConsoleDelayMs());
}

function _clearConsoleTimer() {
	if (_consoleTimer != null) {
		clearTimeout(_consoleTimer);
		_consoleTimer = null;
	}
}

function _ensureOverlay() {
	if (typeof document === "undefined") {
		return null;
	}
	var existing = _qs(OVERLAY_ID);
	if (existing) {
		_lineEls = existing.querySelectorAll(".project-index-busy-line");
		return existing;
	}
	var root = document.createElement("div");
	root.id = OVERLAY_ID;
	root.className = "project-index-busy-overlay";
	root.setAttribute("role", "status");
	root.setAttribute("aria-live", "polite");
	root.setAttribute("aria-busy", "true");
	root.hidden = true;

	var panel = document.createElement("div");
	panel.className = "project-index-busy-panel";

	var spinner = document.createElement("div");
	spinner.className = "project-index-busy-spinner";
	spinner.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>';

	var title = document.createElement("div");
	title.className = "project-index-busy-title";
	title.textContent = "Loading project index…";

	var consoleEl = document.createElement("div");
	consoleEl.className = "project-index-busy-console";
	consoleEl.setAttribute("aria-hidden", "true");
	_lineEls = [];
	for (var i = 0; i < LINE_COUNT; i++) {
		var line = document.createElement("div");
		line.className = "project-index-busy-line";
		line.style.opacity = String(LINE_OPACITIES[i]);
		line.textContent = "\u00a0";
		consoleEl.appendChild(line);
		_lineEls.push(line);
	}

	panel.appendChild(spinner);
	panel.appendChild(title);
	panel.appendChild(consoleEl);
	root.appendChild(panel);
	document.body.appendChild(root);
	return root;
}

function show() {
	if (typeof document === "undefined" || !document.body) {
		return false;
	}
	if (shouldRefuseShow()) {
		return false;
	}
	var root = _ensureOverlay();
	if (!root) {
		return false;
	}
	_visible = true;
	_lines = ["", "", "", ""];
	_lastMessage = pickFunnyMessage("");
	_lines[3] = _lastMessage;
	_renderLines();
	document.body.classList.add("project-index-busy");
	document.body.setAttribute("aria-busy", "true");
	root.hidden = false;
	_scheduleNextConsoleLine();
	return true;
}

function hide() {
	_clearConsoleTimer();
	_visible = false;
	_lines = ["", "", "", ""];
	_lastMessage = "";
	if (typeof document !== "undefined" && document.body) {
		document.body.classList.remove("project-index-busy");
		document.body.removeAttribute("aria-busy");
	}
	var root = _qs(OVERLAY_ID);
	if (root) {
		root.hidden = true;
	}
	_renderLines();
}

function beginPagePopulate() {
	return show();
}

function isVisible() {
	return _visible;
}

function afterPaint(fn) {
	return new Promise(function (resolve, reject) {
		function run() {
			try {
				Promise.resolve(typeof fn === "function" ? fn() : undefined).then(
					resolve,
					reject,
				);
			} catch (err) {
				reject(err);
			}
		}
		if (typeof requestAnimationFrame !== "function") {
			setTimeout(run, 0);
			return;
		}
		requestAnimationFrame(function () {
			requestAnimationFrame(run);
		});
	});
}

function awaitIndexReady() {
	var p = null;
	try {
		if (project && typeof project.getIndexRefreshPromise === "function") {
			p = project.getIndexRefreshPromise();
		}
	} catch (_err) {
		p = null;
	}
	if (!p || typeof p.then !== "function") {
		return Promise.resolve(null);
	}
	return p.then(
		function (result) {
			return result;
		},
		function () {
			return null;
		},
	);
}

/**
 * Show overlay, wait for paint, run workFn, join index refresh, then hide.
 * workFn may be sync or return a Promise.
 */
function populatePage(workFn) {
	beginPagePopulate();
	return afterPaint(function () {
		return Promise.resolve(typeof workFn === "function" ? workFn() : undefined);
	})
		.then(function (result) {
			return awaitIndexReady().then(function () {
				return result;
			});
		})
		.finally(function () {
			hide();
		});
}

module.exports = {
	FUNNY_INDEX_MESSAGES: FUNNY_INDEX_MESSAGES,
	LINE_OPACITIES: LINE_OPACITIES,
	pickFunnyMessage: pickFunnyMessage,
	shiftConsoleLines: shiftConsoleLines,
	randomConsoleDelayMs: randomConsoleDelayMs,
	shouldRefuseShow: shouldRefuseShow,
	show: show,
	hide: hide,
	beginPagePopulate: beginPagePopulate,
	isVisible: isVisible,
	afterPaint: afterPaint,
	awaitIndexReady: awaitIndexReady,
	populatePage: populatePage,
};
