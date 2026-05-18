"use strict";

var path = require("path");
var workspace = require("./workspace");
var project = require("./project");
var branding = require("./branding");

var wizardState = {
	mode: "new",
	step: 1,
	bundleRoot: "",
	sources: {},
};

var ROLE_LABELS = [
	{ role: "original_scans", label: "Original scans", logical: "originalScans" },
	{ role: "dapi", label: "00 DAPI", logical: "dapi" },
	{ role: "slices", label: "01 Slices", logical: "slices" },
	{ role: "max", label: "03 Max", logical: "max" },
	{ role: "predictions", label: "05 Predictions", logical: "predictions" },
	{ role: "quantification", label: "06 Quantification", logical: "quantification" },
	{ role: "pkls", label: "07 PKLs", logical: "pkls" },
	{ role: "dual", label: "08 Dual", logical: "dual" },
];

function qs(id) {
	return document.getElementById(id);
}

function getQueryMode() {
	var params = new URLSearchParams(window.location.search);
	return params.get("mode") || "new";
}

function setStep(step) {
	wizardState.step = step;
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
		} else if (pillStep < step) {
			pills[p].classList.add("active");
		} else {
			pills[p].classList.add("disabled");
		}
	}
}

function buildSourceFields() {
	var container = qs("sourceFields");
	if (!container) {
		return;
	}
	container.innerHTML = "";
	for (var i = 0; i < ROLE_LABELS.length; i++) {
		var def = ROLE_LABELS[i];
		var col = document.createElement("div");
		col.className = "col-md-6";
		col.innerHTML =
			'<label class="form-label">' +
			def.label +
			"</label>" +
			'<input type="text" class="form-control source-input" data-role="' +
			def.role +
			'" data-logical="' +
			def.logical +
			'" readonly />';
		container.appendChild(col);
		var input = col.querySelector("input");
		input.addEventListener("click", function (ev) {
			pickSourceForInput(ev.target);
		});
		if (wizardState.sources[def.role]) {
			input.value = wizardState.sources[def.role];
		}
	}
}

function pickSourceForInput(inputEl) {
	var ipc = require("electron").ipcRenderer;
	var tag = "wizardSource_" + inputEl.getAttribute("data-role");
	ipc.once("returnPath", function (event, response) {
		var responseTag = response[1];
		if (typeof responseTag === "object" && responseTag !== null && responseTag.tag) {
			responseTag = responseTag.tag;
		}
		if (responseTag === tag) {
			inputEl.value = response[0] || "";
			wizardState.sources[inputEl.getAttribute("data-role")] = inputEl.value;
		}
	});
	ipc.send("openDialog", {
		tag: tag,
		defaultPath: inputEl.value || undefined,
	});
}

function fillSourcesFromWorkspace() {
	workspace.loadWorkspace();
	var ws = workspace.getWorkspace();
	wizardState.sources = {};
	for (var i = 0; i < ROLE_LABELS.length; i++) {
		var def = ROLE_LABELS[i];
		var resolved = workspace.resolveLogicalPath(def.logical);
		if (resolved) {
			wizardState.sources[def.role] = resolved;
		}
	}
	if (ws.brainRoot) {
		wizardState.legacyRoot = ws.brainRoot;
	}
	buildSourceFields();
}

function getImportMode() {
	var selected = document.querySelector('input[name="importMode"]:checked');
	return selected ? selected.value : "copy";
}

function updateImportWarning() {
	var warn = qs("importWarning");
	if (!warn) {
		return;
	}
	var mode = getImportMode();
	if (mode === "symlink") {
		warn.textContent =
			"Symlinks point at your original folders. Moving or deleting those folders will break this project. On Windows, symlinks may require Developer Mode or administrator rights.";
		warn.classList.remove("d-none");
	} else if (mode === "reference") {
		warn.textContent =
			"Reference-only mode stores absolute paths in project.masonjar. The bundle layout is created but files are not copied.";
		warn.classList.remove("d-none");
	} else {
		warn.classList.add("d-none");
	}
}

function logWizard(msg) {
	var el = qs("wizardLog");
	if (el) {
		el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
	}
}

function setProgress(pct, msg) {
	var bar = qs("wizardProgress");
	var status = qs("finishStatus");
	if (bar) {
		bar.style.width = String(pct) + "%";
	}
	if (status && msg) {
		status.textContent = msg;
	}
}

function runBuild() {
	setStep(4);
	setProgress(0, "Creating project bundle…");

	var bundleRoot = wizardState.bundleRoot;
	var name = (qs("projectName") && qs("projectName").value) || path.basename(bundleRoot);
	var mode = getImportMode();
	var referenceOnly = mode === "reference";
	var roles = Object.assign({}, project.CANONICAL_ROLES);

	if (referenceOnly) {
		var absRoles = Object.assign({}, project.CANONICAL_ROLES);
		var roleKeys = Object.keys(wizardState.sources);
		for (var r = 0; r < roleKeys.length; r++) {
			var rk = roleKeys[r];
			if (wizardState.sources[rk]) {
				absRoles[rk] = wizardState.sources[rk];
			}
		}
		roles = absRoles;
	}

	project.createProject({
		bundleRoot: bundleRoot,
		name: name,
		referenceOnly: referenceOnly,
		roles: roles,
		sources: Object.assign({}, wizardState.sources),
	});

	setProgress(10, "Importing sources…");
	var entries = [];
	var importRoles = Object.keys(wizardState.sources);
	var total = importRoles.length || 1;

	if (mode !== "reference") {
		for (var i = 0; i < importRoles.length; i++) {
			var role = importRoles[i];
			var src = wizardState.sources[role];
			if (!src) {
				continue;
			}
			var pct = 10 + Math.round(((i + 1) / total) * 60);
			setProgress(pct, "Import " + role + "…");
			var entry = project.importSourceToRole(src, role, mode, bundleRoot, roles);
			entries.push(entry);
			logWizard(role + ": " + (entry.error || "ok"));
		}
	}

	project.writeImportLog(bundleRoot, mode, entries);
	stateSaveRoles(bundleRoot, roles, referenceOnly);

	setProgress(75, "Building manifest…");
	project.buildManifest(bundleRoot, function (pct, msg) {
		setProgress(75 + Math.round(pct * 0.2), msg);
	});

	setProgress(100, "Project ready: " + name);
	var openMenu = qs("openMenu");
	if (openMenu) {
		openMenu.classList.remove("d-none");
	}
	project.openProject(bundleRoot);
}

function stateSaveRoles(bundleRoot, roles, referenceOnly) {
	var data = project.getProject();
	if (data) {
		data.roles = roles;
		data.reference_only = referenceOnly;
		data.sources = Object.assign({}, wizardState.sources);
		project.saveProjectJson();
	}
}

function init() {
	wizardState.mode = getQueryMode();
	var intro = qs("wizardIntro");
	if (wizardState.mode === "migrate") {
		if (intro) {
			intro.textContent =
				"Migrate a legacy brain folder into a new .masonjar bundle (non-destructive). Legacy .belljar projects still supported.";
		}
		fillSourcesFromWorkspace();
	} else if (intro) {
		intro.textContent =
			"Create a new .masonjar project bundle. Legacy .belljar projects still supported.";
	}

	buildSourceFields();
	setStep(1);

	qs("chooseBundle").addEventListener("click", function () {
		project.chooseNewBundleLocation(function (selected) {
			if (selected) {
				wizardState.bundleRoot = selected;
				qs("bundlePath").value = selected;
				if (!qs("projectName").value) {
					qs("projectName").value = path
						.basename(selected)
						.replace(/\.(masonjar|belljar)$/i, "");
				}
			}
		});
	});

	qs("step1Next").addEventListener("click", function () {
		var bundle = qs("bundlePath").value;
		if (!bundle) {
			alert("Choose a bundle folder.");
			return;
		}
		wizardState.bundleRoot = bundle;
		setStep(2);
	});

	qs("scanLegacy").addEventListener("click", function () {
		workspace.chooseBrainFolder(function () {
			fillSourcesFromWorkspace();
		});
	});

	qs("step2Back").addEventListener("click", function () {
		setStep(1);
	});
	qs("step2Next").addEventListener("click", function () {
		var inputs = document.querySelectorAll(".source-input");
		wizardState.sources = {};
		for (var i = 0; i < inputs.length; i++) {
			var role = inputs[i].getAttribute("data-role");
			if (inputs[i].value) {
				wizardState.sources[role] = inputs[i].value;
			}
		}
		setStep(3);
		updateImportWarning();
	});

	qs("step3Back").addEventListener("click", function () {
		setStep(2);
	});
	qs("step3Next").addEventListener("click", function () {
		runBuild();
	});

	document.querySelectorAll('input[name="importMode"]').forEach(function (el) {
		el.addEventListener("change", updateImportWarning);
	});
}

init();
