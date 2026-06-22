var fs = require("fs");
var path = require("path");
var ipc = require("electron").ipcRenderer;
var workspace = require("./workspace");
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var pipelineRun = require("./pipeline_run");
var pipelineRuns = require("./pipeline_runs");
var alignIpc = require("./align_ipc");
project.tryRestoreActiveProject();
pipelineGate.assertPipelineAccess();
var run = document.getElementById("run");
var indir = document.getElementById("indir");
var outdir = document.getElementById("outdir");
var loadbar = document.getElementById("loadbar");
var loadmessage = document.getElementById("loadmessage");
var back = document.getElementById("back");
var autoMode = document.getElementById("auto");
var whole = document.getElementById("whole");
var half = document.getElementById("half");
var spacing = document.getElementById("spacing");
var legacy = document.getElementById("legacy");
var flatOutput = document.getElementById("flatOutput");
var alignmentMethod = "auto";
var useLegacy = "False";
var methods = document.querySelector("#methods");
var lastRunRel = "";

pipelineRun.ensureRunModeUi("runModePanel", "align");

autoMode.addEventListener("click", function () {
	methods.textContent = "Automatic (recommended)";
	alignmentMethod = "auto";
});

whole.addEventListener("click", function () {
	methods.textContent = "Both hemispheres (all sections)";
	alignmentMethod = "True";
});

half.addEventListener("click", function () {
	methods.textContent = "Single hemisphere (all sections)";
	alignmentMethod = "False";
});

run.addEventListener("click", function () {
	if (indir && outdir && indir.value && outdir.value) {
		var a = spacing.value;
		try {
			a = Number(a);
		} catch (err) {
			alert("Spacing must be a integer!");
			return;
		}

		if (a % 1 != 0) {
			a = Math.round(a);
		}

		if (legacy.checked) {
			useLegacy = "True";
		} else {
			useLegacy = "False";
		}

		var mode = pipelineRun.getSelectedRunMode("align");
		var plan = pipelineRun.preparePipelineRun("align", mode);
		if (project.isActive() && !plan.toProcess.length) {
			alert("No slices to process (all outputs exist or subset is empty).");
			return;
		}

		var sortedStems = pipelineRuns.listImageSliceStems(indir.value);
		var slug = pipelineRuns.buildRunSlug("align", {
			sortedStems: sortedStems,
			spacing: a,
			whole: alignmentMethod,
			legacy: useLegacy,
			subsetCount: plan.toProcess.length,
		});
		var useFlat = flatOutput && flatOutput.checked;
		var finalOut = pipelineRuns.resolveRunLeaf(outdir.value, "align", slug, useFlat);
		try {
			fs.mkdirSync(finalOut, { recursive: true });
		} catch (mkdirErr) {
			alert("Could not create output directory: " + (mkdirErr.message || mkdirErr));
			return;
		}
		lastRunRel = useFlat ? "" : pipelineRuns.relFromRoleBase("align", finalOut);

		run.classList.add("disabled");
		back.classList.remove("btn-warning");
		back.classList.add("btn-danger");
		back.innerHTML = "Cancel";
		run.innerHTML = "<i class='fas fa-spinner fa-spin'></i>";
		var msg = plan.summary || "";
		if (!useFlat && lastRunRel) {
			msg = (msg ? msg + " " : "") + "Run folder: " + lastRunRel;
		}
		if (loadmessage) {
			loadmessage.innerHTML = msg;
		}
		ipc.send("runAlign", [
			indir.value,
			finalOut,
			alignmentMethod,
			a,
			useLegacy,
			plan.sliceListPath || "",
			project.isActive() ? project.getBundleRoot() || "" : "",
		]);
	}
});

back.addEventListener("click", function (event) {
	if (back.classList.contains("btn-danger")) {
		event.preventDefault();
		ipc.send("saveAndExitAlign", []);
	}
});

ipc.on("alignResult", function (event, response) {
	run.innerHTML = "Run";
	run.classList.remove("disabled");
	back.classList.add("btn-warning");
	back.classList.remove("btn-danger");
	back.innerHTML = "Back";
	loadbar.style.width = "0";
	if (response && response.cancelled) {
		loadmessage.textContent =
			"Tuning saved. Run Align again and click Finish to warp sections.";
		return;
	}
	loadmessage.innerHTML = "";
	if (project.isActive() && lastRunRel && alignIpc.shouldApplyAlignRunSideEffects(response)) {
		pipelineRuns.setActiveRunRel("align", lastRunRel);
		var alignLeaf = pipelineRuns.resolveActiveRunLeafAbs("slices");
		project.mergeAlignWarpReport(project.getBundleRoot(), alignLeaf);
		project.refreshProjectIndex().catch(function () {});
		project.notifyProcessingStateChanged();
	}
});

ipc.on("alignError", function (event, response) {
	run.innerHTML = "Run";
	run.classList.remove("disabled");
	back.classList.add("btn-warning");
	back.classList.remove("btn-danger");
	back.innerHTML = "Back";
	loadbar.style.width = "0";
	if (response && response[0]) {
		loadmessage.textContent = String(response[0]);
	}
});

ipc.on("updateLoad", function (event, response) {
	loadbar.style.width = String(response[0]) + "%";
	loadmessage.innerHTML = response[1];
	var detail = String(response[1] || "");
	if (
		detail.indexOf("align_session_discarded") >= 0 ||
		detail.indexOf("cleared a bad autosave") >= 0
	) {
		loadmessage.textContent =
			"Refreshed alignment predictions (cleared a bad autosave from a prior run).";
	}
});

workspace.applyPreset("align");
workspace.bindPathPicker(indir, "indir", "dapi");
workspace.bindPathPicker(outdir, "outdir", "slices");
