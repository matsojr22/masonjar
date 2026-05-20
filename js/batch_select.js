"use strict";

var path = require("path");
var ipc = require("electron").ipcRenderer;
var dialogs = require("./dialogs");
var registry = require("./batch_registry");
var project = require("./project");

var projectListEl = document.getElementById("projectList");
var stepListEl = document.getElementById("stepList");
var nextParamsBtn = document.getElementById("nextParams");
var preflightEl = document.getElementById("preflightWarnings");
var addProjectBtn = document.getElementById("addProject");
var scanFolderBtn = document.getElementById("scanFolder");

var selectedProjects = {};
var selectedSteps = {};

function loadStateFromPlan() {
	var plan = registry.loadBatchPlan();
	if (!plan) {
		return;
	}
	if (plan.projects) {
		for (var i = 0; i < plan.projects.length; i++) {
			var p = plan.projects[i];
			selectedProjects[p.path] = p;
		}
	}
	if (plan.steps) {
		for (var j = 0; j < plan.steps.length; j++) {
			selectedSteps[plan.steps[j]] = true;
		}
	}
}

function getSelectedProjectList() {
	return Object.keys(selectedProjects).map(function (k) {
		return selectedProjects[k];
	});
}

function getSelectedStepList() {
	return registry.sortSteps(
		registry.BATCH_STEP_ORDER.filter(function (id) {
			return !!selectedSteps[id];
		}),
	);
}

function updateNextButton() {
	var hasProjects = Object.keys(selectedProjects).length > 0;
	var hasSteps = getSelectedStepList().length > 0;
	if (nextParamsBtn) {
		nextParamsBtn.disabled = !(hasProjects && hasSteps);
	}
}

function refreshPreflight() {
	if (!preflightEl) {
		return;
	}
	var steps = getSelectedStepList();
	var projects = getSelectedProjectList();
	if (!projects.length || !steps.length) {
		preflightEl.classList.add("d-none");
		preflightEl.textContent = "";
		return;
	}
	var warnings = project.preflightBatchPlan({ projects: projects, steps: steps });
	if (!warnings.length) {
		preflightEl.classList.add("d-none");
		return;
	}
	preflightEl.classList.remove("d-none");
	preflightEl.innerHTML =
		"<strong>Preflight warnings</strong><ul class=\"mb-0 ps-3\"><li>" +
		warnings.map(function (w) {
			return escapeHtml(w);
		}).join("</li><li>") +
		"</li></ul>";
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderProjects() {
	if (!projectListEl) {
		return;
	}
	projectListEl.innerHTML = "";
	var entries = getSelectedProjectList();
	if (!entries.length) {
		projectListEl.innerHTML = '<p class="text-muted small mb-0">No projects added.</p>';
		updateNextButton();
		refreshPreflight();
		return;
	}
	for (var i = 0; i < entries.length; i++) {
		(function (entry) {
			var row = document.createElement("div");
			row.className = "form-check";
			var id = "proj-" + i;
			row.innerHTML =
				'<input class="form-check-input" type="checkbox" id="' +
				id +
				'" checked />' +
				'<label class="form-check-label" for="' +
				id +
				'">' +
				escapeHtml(entry.name) +
				" <span class=\"text-muted\">(" +
				escapeHtml(path.basename(entry.path)) +
				")</span></label>";
			var cb = row.querySelector("input");
			cb.addEventListener("change", function () {
				if (!cb.checked) {
					delete selectedProjects[entry.path];
					renderProjects();
				}
			});
			projectListEl.appendChild(row);
		})(entries[i]);
	}
	updateNextButton();
	refreshPreflight();
}

function renderSteps() {
	if (!stepListEl) {
		return;
	}
	stepListEl.innerHTML = "";
	for (var i = 0; i < registry.BATCH_STEP_ORDER.length; i++) {
		(function (stepId) {
			var meta = registry.getStepMeta(stepId);
			var row = document.createElement("div");
			row.className = "form-check";
			var checked = !!selectedSteps[stepId];
			row.innerHTML =
				'<input class="form-check-input" type="checkbox" id="step-' +
				stepId +
				'" ' +
				(checked ? "checked" : "") +
				" />" +
				'<label class="form-check-label" for="step-' +
				stepId +
				'">' +
				meta.label +
				"</label>";
			var cb = row.querySelector("input");
			cb.addEventListener("change", function () {
				if (cb.checked) {
					selectedSteps[stepId] = true;
				} else {
					delete selectedSteps[stepId];
				}
				updateNextButton();
				refreshPreflight();
			});
			stepListEl.appendChild(row);
		})(registry.BATCH_STEP_ORDER[i]);
	}
}

function addProjectPath(bundleRoot) {
	if (!bundleRoot || !project.isBundleRoot(bundleRoot)) {
		alert(
			"Not a valid project bundle (missing a .masonjar project file or legacy project.belljar).",
		);
		return;
	}
	var data;
	try {
		data = project.readProjectJson(bundleRoot);
	} catch (err) {
		alert(String(err.message || err));
		return;
	}
	selectedProjects[bundleRoot] = {
		path: bundleRoot,
		name: data.name || path.basename(bundleRoot),
	};
	renderProjects();
}

function seedFromRecent() {
	var recent = project.getRecentProjects();
	for (var i = 0; i < recent.length; i++) {
		if (project.isBundleRoot(recent[i].path) && !selectedProjects[recent[i].path]) {
			selectedProjects[recent[i].path] = {
				path: recent[i].path,
				name: recent[i].name,
			};
		}
	}
}

if (addProjectBtn) {
	addProjectBtn.addEventListener("click", function () {
		dialogs.pickDirectory({ tag: "projectBundle" }).then(function (selected) {
			if (selected) {
				addProjectPath(selected);
			}
		});
	});
}

if (scanFolderBtn) {
	scanFolderBtn.addEventListener("click", function () {
		ipc.once("returnPath", function (event, response) {
			var tag = response[1];
			if (typeof tag === "object" && tag !== null && tag.tag) {
				tag = tag.tag;
			}
			if (tag !== "dir" && tag !== "input") {
				return;
			}
			var folder = response[0];
			if (!folder) {
				return;
			}
			var bundles = project.listBundlesInDirectory(folder);
			if (!bundles.length) {
				alert("No .masonjar / .belljar bundles found in that folder.");
				return;
			}
			for (var i = 0; i < bundles.length; i++) {
				addProjectPath(bundles[i]);
			}
		});
		ipc.send("openDialog", "input");
	});
}

if (nextParamsBtn) {
	nextParamsBtn.addEventListener("click", function () {
		var steps = getSelectedStepList();
		var projects = getSelectedProjectList();
		if (!projects.length || !steps.length) {
			return;
		}
		var existing = registry.loadBatchPlan() || {};
		registry.saveBatchPlan({
			projects: projects,
			steps: steps,
			params: existing.params || registry.mergeParams(steps),
			warnings: project.preflightBatchPlan({ projects: projects, steps: steps }),
		});
		window.location.href = "./batch_params.html";
	});
}

loadStateFromPlan();
seedFromRecent();
renderSteps();
renderProjects();
