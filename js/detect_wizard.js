"use strict";

var fs = require("fs");
var path = require("path");
var url = require("url");
var ipc = require("electron").ipcRenderer;
var workspace = require("./workspace");
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var pipelineRun = require("./pipeline_run");
var pipelineRuns = require("./pipeline_runs");
var maxDatasets = require("./max_datasets");
var maxDatasetPicker = require("./max_dataset_picker");
var detectCommon = require("./detect_common");

project.tryRestoreActiveProject();
pipelineGate.assertPipelineAccess();

var LAST_RUN_KEY = "masonjar.detect.lastRun";
var PER_SLICE_QC_KEY = "masonjar.detect.perSliceQc";
var LOG_MAX = 1500;

var detectionMethod = "somata";
var running = false;
var lastDetectionRunRel = "";
var lastAnalysis = null;
var datasetPicker = null;

function qs(id) {
	return document.getElementById(id);
}

function formRefs() {
	return {
		indir: qs("indir"),
		outdir: qs("outdir"),
		tile: qs("tile"),
		confidence: qs("confidence"),
		area: qs("area"),
		eccentricity: qs("eccentricity"),
		intensityMin: qs("intensityMin"),
		model: qs("model"),
		multichannel: qs("multichannel"),
		flatOutput: qs("flatOutput"),
		perSliceQc: qs("perSliceQc"),
	};
}

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

function setStep(n) {
	var panels = [qs("step1"), qs("step2"), qs("step3")];
	for (var i = 0; i < panels.length; i++) {
		if (panels[i]) {
			panels[i].classList.toggle("d-none", i + 1 !== n);
		}
	}
	var pills = document.querySelectorAll("#wizardSteps .nav-link");
	for (var p = 0; p < pills.length; p++) {
		var pillStep = Number(pills[p].getAttribute("data-step"));
		pills[p].classList.remove("active", "disabled");
		if (pillStep === n) {
			pills[p].classList.add("active");
		} else {
			pills[p].classList.add("disabled");
		}
	}
}

function appendLog(line) {
	var logEl = qs("wizardLog");
	if (!logEl) {
		return;
	}
	var text = String(line || "") + "\n";
	logEl.textContent = (logEl.textContent + text).slice(-LOG_MAX);
	logEl.scrollTop = logEl.scrollHeight;
}

function stashLastRun(payload, runRel) {
	try {
		sessionStorage.setItem(
			LAST_RUN_KEY,
			JSON.stringify({
				outputAbs: payload.finalOut,
				slug: payload.slug,
				params: payload.params,
				runRel: runRel,
			}),
		);
	} catch (_err) {
		/* ignore */
	}
}

function loadLastRun() {
	try {
		var raw = sessionStorage.getItem(LAST_RUN_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch (_err) {
		return null;
	}
}

function formatParamValue(key, val) {
	if (val === null || val === undefined || val === "") {
		return "—";
	}
	if (key === "confidence" || key === "eccentricity") {
		return Number(val).toFixed(2);
	}
	return String(val);
}

function renderAnalysisSummary(summaryJson) {
	var container = qs("qcAnalysisSummary");
	var applyBtn = qs("applySuggestions");
	if (!container) {
		return;
	}
	container.innerHTML = "";
	lastAnalysis = (summaryJson && summaryJson.analysis) || null;

	if (!lastAnalysis) {
		container.innerHTML =
			'<p class="text-muted small">QC summary not available for this run.</p>';
		if (applyBtn) {
			applyBtn.classList.add("d-none");
		}
		return;
	}

	var lines = lastAnalysis.summary_lines || [];
	if (lines.length) {
		var ul = document.createElement("ul");
		ul.className = "small";
		for (var i = 0; i < lines.length; i++) {
			var li = document.createElement("li");
			li.textContent = lines[i];
			ul.appendChild(li);
		}
		container.appendChild(ul);
	}

	var suggestions = lastAnalysis.suggestions || {};
	var current = lastAnalysis.current || {};
	var hasSuggestions = Object.keys(suggestions).length > 0;

	if (hasSuggestions) {
		var table = document.createElement("table");
		table.className = "table table-sm detect-suggestions-table";
		var thead = document.createElement("thead");
		thead.innerHTML =
			"<tr><th>Parameter</th><th>Current</th><th>Suggested</th></tr>";
		table.appendChild(thead);
		var tbody = document.createElement("tbody");
		var rows = [
			{ key: "confidence", label: "Confidence", cur: current.confidence, sug: suggestions.confidence },
			{ key: "area", label: "Area cutoff (px²)", cur: current.area, sug: suggestions.area },
			{ key: "eccentricity", label: "Eccentricity", cur: current.eccentricity, sug: suggestions.eccentricity },
			{
				key: "intensity_min",
				label: "Intensity cutoff",
				cur: current.intensity_min || 0,
				sug: suggestions.intensity_min,
			},
		];
		for (var r = 0; r < rows.length; r++) {
			var row = rows[r];
			if (row.sug === undefined) {
				continue;
			}
			var tr = document.createElement("tr");
			tr.innerHTML =
				"<td>" +
				row.label +
				"</td><td>" +
				formatParamValue(row.key, row.cur) +
				"</td><td><strong>" +
				formatParamValue(row.key, row.sug) +
				"</strong></td>";
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		container.appendChild(table);
		if (applyBtn) {
			applyBtn.classList.remove("d-none");
		}
	} else if (!lines.length) {
		var p = document.createElement("p");
		p.className = "text-muted small";
		p.textContent = "Not enough data in this run to recommend parameter changes.";
		container.appendChild(p);
		if (applyBtn) {
			applyBtn.classList.add("d-none");
		}
	} else if (applyBtn) {
		applyBtn.classList.add("d-none");
	}
}

function renderQcGallery(outputAbs) {
	var gallery = qs("qcGallery");
	if (!gallery || !outputAbs) {
		return;
	}
	gallery.innerHTML = "";
	var files = [
		"detect_qc_confidence.png",
		"detect_qc_area_px2.png",
		"detect_qc_eccentricity.png",
	];
	for (var i = 0; i < files.length; i++) {
		var abs = path.join(outputAbs, files[i]);
		if (!fs.existsSync(abs)) {
			continue;
		}
		var wrap = document.createElement("div");
		wrap.className = "mb-3";
		var cap = document.createElement("div");
		cap.className = "small text-muted mb-1";
		cap.textContent = files[i];
		var img = document.createElement("img");
		img.alt = files[i];
		img.src = fileUrlForPath(abs) + "?t=" + Date.now();
		wrap.appendChild(cap);
		wrap.appendChild(img);
		gallery.appendChild(wrap);
	}
}

function showSummaryStep(success, message) {
	setStep(3);
	var alertEl = qs("summaryAlert");
	if (alertEl) {
		alertEl.className = "alert text-start " + (success ? "alert-success" : "alert-danger");
		alertEl.textContent = message || (success ? "Cell detection finished." : "Cell detection failed.");
	}

	var lastRun = loadLastRun();
	var outputAbs = lastRun && lastRun.outputAbs;
	var summaryJson = null;
	if (outputAbs) {
		var summaryPath = path.join(outputAbs, "detect_qc_summary.json");
		if (fs.existsSync(summaryPath)) {
			try {
				summaryJson = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
			} catch (_err) {
				summaryJson = null;
			}
		}
		renderQcGallery(outputAbs);
		renderAnalysisSummary(summaryJson);
	}
}

function applySuggestionsToForm() {
	if (!lastAnalysis || !lastAnalysis.suggestions) {
		return;
	}
	var sug = lastAnalysis.suggestions;
	var form = formRefs();
	if (sug.confidence !== undefined && form.confidence) {
		form.confidence.value = String(sug.confidence);
	}
	if (sug.area !== undefined && form.area) {
		form.area.value = String(sug.area);
	}
	if (sug.eccentricity !== undefined && form.eccentricity) {
		form.eccentricity.value = String(sug.eccentricity);
	}
	if (form.intensityMin) {
		form.intensityMin.value =
			sug.intensity_min !== undefined && sug.intensity_min > 0
				? String(sug.intensity_min)
				: "";
	}
	setStep(1);
}

function startDetection() {
	var form = formRefs();
	if (!form.indir || !form.outdir || !form.indir.value || !form.outdir.value) {
		alert("Input and output paths are required.");
		return;
	}

	var payload = detectCommon.buildRunPayload({
		form: form,
		detectionMethod: detectionMethod,
	});
	if (payload.error) {
		alert(payload.error);
		return;
	}

	lastDetectionRunRel = payload.lastDetectionRunRel;
	stashLastRun(payload, lastDetectionRunRel);
	running = true;
	setStep(2);

	var prog = qs("processProgress");
	var msg = qs("processMessage");
	if (prog) {
		prog.style.width = "0%";
	}
	if (msg) {
		var planMsg = payload.plan.summary || "";
		if (!payload.useFlat && lastDetectionRunRel) {
			planMsg =
				(planMsg ? planMsg + " " : "") + "Run folder: " + lastDetectionRunRel;
		}
		msg.textContent = planMsg || "Running cell detection…";
	}
	var logEl = qs("wizardLog");
	if (logEl) {
		logEl.textContent = "";
	}

	ipc.send("runDetection", payload.ipcArgs);
}

pipelineRun.ensureRunModeUi("runModePanel", "detect");

var somata = qs("somata");
var nuclei = qs("nuclei");
var methods = qs("methods");
var advance = qs("advance");
var arrow = qs("arrow");
var perSliceQc = qs("perSliceQc");

if (somata) {
	somata.addEventListener("click", function () {
		if (methods) {
			methods.textContent = "Somata";
		}
		detectionMethod = "somata";
		if (datasetPicker) {
			datasetPicker.refresh();
		}
	});
}

if (nuclei) {
	nuclei.addEventListener("click", function () {
		if (methods) {
			methods.textContent = "Nuclei";
		}
		detectionMethod = "nuclei";
		if (datasetPicker) {
			datasetPicker.refresh();
		}
	});
}

if (advance && arrow) {
	advance.addEventListener("click", function () {
		arrow.classList.toggle("down");
	});
}

if (perSliceQc) {
	try {
		perSliceQc.checked = localStorage.getItem(PER_SLICE_QC_KEY) === "1";
	} catch (_err) {
		/* ignore */
	}
	perSliceQc.addEventListener("change", function () {
		try {
			localStorage.setItem(PER_SLICE_QC_KEY, perSliceQc.checked ? "1" : "0");
		} catch (_err) {
			/* ignore */
		}
	});
}

var step1Next = qs("step1Next");
if (step1Next) {
	step1Next.addEventListener("click", startDetection);
}

var step2Cancel = qs("step2Cancel");
if (step2Cancel) {
	step2Cancel.addEventListener("click", function () {
		if (running) {
			ipc.send("killDetect", []);
		}
	});
}

var applyBtn = qs("applySuggestions");
if (applyBtn) {
	applyBtn.addEventListener("click", applySuggestionsToForm);
}

ipc.on("detectResult", function () {
	running = false;
	if (project.isActive() && lastDetectionRunRel) {
		pipelineRuns.setActiveRunRel("detect", lastDetectionRunRel);
		project.refreshProjectIndex().catch(function () {});
	}
	showSummaryStep(true, "Cell detection finished.");
});

ipc.on("detectError", function () {
	running = false;
	showSummaryStep(false, "Cell detection failed. Check the Application log for details.");
});

ipc.on("updateLoad", function (_event, response) {
	var pct = Math.min(100, Math.max(0, Number(response[0]) || 0));
	var prog = qs("processProgress");
	var msg = qs("processMessage");
	if (prog) {
		prog.style.width = String(pct) + "%";
		prog.setAttribute("aria-valuenow", String(pct));
	}
	if (msg && response[1]) {
		msg.textContent = response[1];
		appendLog(response[1]);
	}
});

workspace.applyPreset("detect");
datasetPicker = maxDatasetPicker.wireMaxDatasetPicker({
	storageKey: "masonjar.detect.maxDataset",
	indirInput: qs("indir"),
	sectionId: "detectDatasetSection",
	branchSelectId: "detectSignalBranch",
	datasetSelectId: "detectMaxDataset",
	defaultBranch: function () {
		return maxDatasets.defaultBranchForDetectMethod(detectionMethod);
	},
});
workspace.bindPathPicker(qs("indir"), "indir", "max");
workspace.bindPathPicker(qs("outdir"), "outdir", "predictions");
workspace.bindPathPicker(qs("model"), "model", null, true);

setStep(1);
