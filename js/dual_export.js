var ipc = require("electron").ipcRenderer;
var workspace = require("./workspace");
var project = require("./project");
project.tryRestoreActiveProject();
var run = document.getElementById("run");
var indir = document.getElementById("indir");
var outdir = document.getElementById("outdir");
var loadbar = document.getElementById("loadbar");
var loadmessage = document.getElementById("loadmessage");
var back = document.getElementById("back");

run.addEventListener("click", function () {
	if (indir && outdir && indir.value && outdir.value) {
		run.classList.add("disabled");
		back.classList.remove("btn-warning");
		back.classList.add("btn-danger");
		back.innerHTML = "Cancel";
		run.innerHTML = "<i class='fas fa-spinner fa-spin'></i>";
		ipc.send("runExportDualTif", [indir.value, outdir.value]);
		loadmessage.innerHTML = "Initializing...";
	}
});

back.addEventListener("click", function (event) {
	if (back.classList.contains("btn-danger")) {
		event.preventDefault();
		ipc.send("killExportDualTif", []);
		back.classList.add("btn-warning");
		back.classList.remove("btn-danger");
		back.innerHTML = "Back";
		run.innerHTML = "Run";
		run.classList.remove("disabled");
		loadmessage.innerHTML = "";
		loadbar.style.width = "0";
	}
});

ipc.on("exportDualTifResult", function (_event, errDetail) {
	run.innerHTML = "Run";
	run.classList.remove("disabled");
	back.classList.add("btn-warning");
	back.classList.remove("btn-danger");
	back.innerHTML = "Back";
	loadbar.style.width = "0";
	if (errDetail) {
		loadmessage.textContent = String(errDetail);
	} else {
		loadmessage.innerHTML = "";
	}
});

ipc.on("updateLoad", function (event, response) {
	loadbar.style.width = String(response[0]) + "%";
	loadmessage.innerHTML = response[1];
});

workspace.applyPreset("dual");
workspace.bindPathPicker(indir, "indir", "pkls");
workspace.bindPathPicker(outdir, "outdir", "dual");
