var fs = require("fs");
var path = require("path");
var ipc = require("electron").ipcRenderer;
var workspace = require("./workspace");
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var pipelineRun = require("./pipeline_run");
var pipelineRuns = require("./pipeline_runs");
project.tryRestoreActiveProject();
pipelineGate.assertPipelineAccess();
var run = document.getElementById("run");
var indir = document.getElementById("indir");
var annodir = document.getElementById("annodir");
var outdir = document.getElementById("outdir");
var dapidir = document.getElementById("dapidir");
var usedapi = document.getElementById("usedapi");
var loadbar = document.getElementById("loadbar");
var loadmessage = document.getElementById("loadmessage");
var back = document.getElementById("back");
var whole = document.getElementById("whole");
var half = document.getElementById("half");
var flatOutput = document.getElementById("flatOutput");
var alignmentMethod = "True";
var methods = document.querySelector("#methods");
var lastRunRel = "";

pipelineRun.ensureRunModeUi("runModePanel", "intensity");

if (usedapi && dapidir) {
	usedapi.addEventListener("change", function () {
		dapidir.disabled = !usedapi.checked;
		if (!usedapi.checked) {
			dapidir.value = "";
		}
	});
}

whole.addEventListener("click", function () {
	methods.textContent = "Whole Slice";
	alignmentMethod = "True";
});

half.addEventListener("click", function () {
	methods.textContent = "Hemisphere Only";
	alignmentMethod = "False";
});

run.addEventListener("click", function () {
	if (indir && outdir && indir.value && outdir.value && annodir && annodir.value) {
		if (usedapi && usedapi.checked) {
			if (!dapidir || !dapidir.value) {
				alert("Select a DAPI PNG folder, or uncheck Include DAPI.");
				return;
			}
		}
		if (project.isActive()) {
			var maxLeaf = pipelineRuns.resolveActiveRunLeafAbs("max");
			var slicesLeaf = pipelineRuns.resolveActiveRunLeafAbs("slices");
			if (maxLeaf) {
				indir.value = maxLeaf;
			}
			if (slicesLeaf) {
				annodir.value = slicesLeaf;
			}
			if (!slicesLeaf || !pipelineRuns.hasRunMarkers(slicesLeaf, "align")) {
				alert(
					"No alignment output with annotation PKLs. Choose slices on the workspace menu under Completed tasks (01_slices/align/...).",
				);
				return;
			}
		}
		var mode = pipelineRun.getSelectedRunMode("intensity");
		var plan = pipelineRun.preparePipelineRun("intensity", mode);
		if (project.isActive() && !plan.toProcess.length) {
			alert("No slices to process (all outputs exist or subset is empty).");
			return;
		}
		var sortedStems = pipelineRuns.listImageSliceStems(indir.value);
		var slug = pipelineRuns.buildRunSlug("intensity", {
			sortedStems: sortedStems,
			whole: alignmentMethod,
			useDapi: usedapi && usedapi.checked,
			subsetCount: plan.toProcess.length,
		});
		var useFlat = flatOutput && flatOutput.checked;
		var outBase =
			project.isActive() && pipelineRuns.resolveRoleBaseAbs("pkls")
				? pipelineRuns.resolveRoleBaseAbs("pkls")
				: outdir.value;
		var finalOut = pipelineRuns.resolveRunLeaf(
			outBase,
			"intensity",
			slug,
			useFlat,
		);
		try {
			fs.mkdirSync(finalOut, { recursive: true });
		} catch (mkdirErr) {
			alert("Could not create output directory: " + (mkdirErr.message || mkdirErr));
			return;
		}
		lastRunRel = useFlat ? "" : pipelineRuns.relFromRoleBase("intensity", finalOut);

		run.classList.add("disabled");
		back.classList.remove("btn-warning");
		back.classList.add("btn-danger");
		back.innerHTML = "Cancel";
		run.innerHTML = "<i class='fas fa-spinner fa-spin'></i>";
		if (plan.summary && loadmessage) {
			loadmessage.textContent = plan.summary;
		}
		var dapiPath =
			usedapi && usedapi.checked && dapidir && dapidir.value ? dapidir.value : "";
		ipc.send("runIntensity", [
			indir.value,
			finalOut,
			annodir.value,
			alignmentMethod,
			dapiPath,
			plan.sliceListPath || "",
		]);
	}
});

back.addEventListener("click", function (event) {
	if (back.classList.contains("btn-danger")) {
		event.preventDefault();
		ipc.send("killIntensity", []);
		back.classList.add("btn-warning");
		back.classList.remove("btn-danger");
		back.innerHTML = "Back";
		run.innerHTML = "Run";
		run.classList.remove("disabled");
		loadmessage.innerHTML = "";
		loadbar.style.width = "0";
	}
});

ipc.on("intensityResult", function (event, response) {
	run.innerHTML = "Run";
	run.classList.remove("disabled");
	back.classList.add("btn-warning");
	back.classList.remove("btn-danger");
	back.innerHTML = "Back";
	loadmessage.innerHTML = "";
	loadbar.style.width = "0";
	if (project.isActive() && lastRunRel) {
		pipelineRuns.setActiveRunRel("intensity", lastRunRel);
		project.refreshProjectIndex().catch(function () {});
	}
});

ipc.on("intensityError", function (event, response) {
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
});

workspace.applyPreset("intensity");
if (project.isActive()) {
	if (outdir) {
		var pklsBase = pipelineRuns.resolveRoleBaseAbs("pkls");
		if (pklsBase) {
			outdir.value = pklsBase;
		}
	}
	if (annodir) {
		var slicesLeafPreset = pipelineRuns.resolveActiveRunLeafAbs("slices");
		if (slicesLeafPreset) {
			annodir.value = slicesLeafPreset;
		}
	}
}
workspace.bindPathPicker(indir, "indir", "max");
workspace.bindPathPicker(outdir, "outdir", "pkls");
workspace.bindPathPicker(annodir, "annodir", "slices");
if (dapidir) {
	workspace.bindPathPicker(dapidir, "dapidir", "dapi");
}
