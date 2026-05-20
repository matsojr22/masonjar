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
var outdir = document.getElementById("outdir");
var loadbar = document.getElementById("loadbar");
var loadmessage = document.getElementById("loadmessage");
var back = document.getElementById("back");
var radius = document.getElementById("radius");
var amount = document.getElementById("amount");
var equalizeCheckbox = document.getElementById("equalize");
var flatOutput = document.getElementById("flatOutput");
var lastRunRel = "";

pipelineRun.ensureRunModeUi("runModePanel", "sharpen");

function checkNumber(value, message) {
	var str = value.toString();
	if (!str.match(/^-?\d*\.?\d*$/)) {
		alert(`${message}`);
		return false;
	}
	return true;
}

run.addEventListener("click", function () {
	if (indir && outdir && indir.value && outdir.value) {
		var maxInput =
			pipelineRuns.resolveInputLeafAbsForStep("sharpen", "max") || indir.value;
		if (project.isActive()) {
			indir.value = maxInput;
		}
		var mode = pipelineRun.getSelectedRunMode("sharpen");
		var plan = pipelineRun.preparePipelineRun("sharpen", mode);
		if (project.isActive() && !plan.toProcess.length) {
			alert("No slices to process (subset empty or all filtered).");
			return;
		}
		var sortedStems = pipelineRuns.listImageSliceStems(maxInput);
		var slug = pipelineRuns.buildRunSlug("sharpen", {
			sortedStems: sortedStems,
			radius: parseFloat(radius.value),
			amount: parseFloat(amount.value),
			equalize: equalizeCheckbox.checked,
			subsetCount: plan.toProcess.length,
		});
		var useFlat = flatOutput && flatOutput.checked;
		var finalOut = pipelineRuns.resolveRunLeaf(
			outdir.value,
			"sharpen",
			slug,
			useFlat,
		);
		try {
			fs.mkdirSync(finalOut, { recursive: true });
		} catch (mkdirErr) {
			alert("Could not create output directory: " + (mkdirErr.message || mkdirErr));
			return;
		}
		lastRunRel = useFlat ? "" : pipelineRuns.relFromRoleBase("sharpen", finalOut);

		run.classList.add("disabled");
		back.classList.remove("btn-warning");
		back.classList.add("btn-danger");
		back.innerHTML = "Cancel";
		run.innerHTML = "<i class='fas fa-spinner fa-spin'></i>";
		var data = [
			maxInput,
			finalOut,
			parseFloat(radius.value),
			parseFloat(amount.value),
		];
		if (equalizeCheckbox.checked) {
			data.push("equalize");
		}
		if (loadmessage) {
			loadmessage.innerHTML = plan.summary || "Initializing...";
		}
		ipc.send("runSharpen", data);
	}
});

back.addEventListener("click", function (event) {
	if (back.classList.contains("btn-danger")) {
		event.preventDefault();
		ipc.send("killSharpen", []);
		back.classList.add("btn-warning");
		back.classList.remove("btn-danger");
		back.innerHTML = "Back";
		run.innerHTML = "Run";
		run.classList.remove("disabled");
		loadmessage.innerHTML = "";
		loadbar.style.width = "0";
	}
});

ipc.on("sharpenResult", function (event, response) {
	back.classList.add("btn-warning");
	back.classList.remove("btn-danger");
	back.innerHTML = "Back";
	run.innerHTML = "Run";
	run.classList.remove("disabled");
	loadmessage.innerHTML = "";
	loadbar.style.width = "0";
	if (project.isActive() && lastRunRel) {
		pipelineRuns.setActiveRunRel("sharpen", lastRunRel);
		project.refreshProjectIndex().catch(function () {});
	}
});

ipc.once("detectError", function (event, response) {
	run.innerHTML = "Run";
	run.classList.remove("disabled");
});

ipc.on("updateLoad", function (event, response) {
	loadbar.style.width = String(response[0]) + "%";
	loadmessage.innerHTML = response[1];
});

workspace.applyPreset("sharpen");
workspace.bindPathPicker(indir, "indir", "max");
workspace.bindPathPicker(outdir, "outdir", "max");
