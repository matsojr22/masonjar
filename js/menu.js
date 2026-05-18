"use strict";

var workspace = require("./workspace");
var project = require("./project");

var brainRootInput = document.getElementById("brainRoot");
var workspaceStatus = document.getElementById("workspaceStatus");
var projectStatus = document.getElementById("projectStatus");
var chooseBrain = document.getElementById("chooseBrain");
var rescanBrain = document.getElementById("rescanBrain");
var openProjectBtn = document.getElementById("openProject");
var closeProjectBtn = document.getElementById("closeProject");
var recentProjectsList = document.getElementById("recentProjects");

function refreshWorkspaceUi() {
	var ws = workspace.loadWorkspace();
	if (brainRootInput) {
		brainRootInput.value = ws.brainRoot || "";
	}
	if (workspaceStatus) {
		if (project.isActive()) {
			workspaceStatus.textContent =
				"Legacy workspace inactive while a project is open.";
		} else {
			workspaceStatus.textContent = workspace.getScanStatusMessage();
		}
	}
}

function refreshProjectUi() {
	if (projectStatus) {
		projectStatus.textContent = project.isActive()
			? project.getStatusMessage() + " — " + project.getBundleRoot()
			: "No project open.";
	}
	if (closeProjectBtn) {
		closeProjectBtn.disabled = !project.isActive();
	}
	refreshRecentList();
	refreshWorkspaceUi();
}

function refreshRecentList() {
	if (!recentProjectsList) {
		return;
	}
	recentProjectsList.innerHTML = "";
	var recent = project.getRecentProjects();
	if (!recent.length) {
		var empty = document.createElement("li");
		empty.className = "list-group-item text-muted";
		empty.textContent = "No recent projects.";
		recentProjectsList.appendChild(empty);
		return;
	}
	for (var i = 0; i < recent.length; i++) {
		(function (entry) {
			var li = document.createElement("li");
			li.className = "list-group-item d-flex justify-content-between align-items-center";
			var label = document.createElement("span");
			label.textContent = entry.name + " — " + entry.path;
			var btn = document.createElement("button");
			btn.type = "button";
			btn.className = "btn btn-sm btn-outline-primary";
			btn.textContent = "Open";
			btn.addEventListener("click", function () {
				try {
					project.openProject(entry.path);
					refreshProjectUi();
				} catch (err) {
					alert(String(err.message || err));
				}
			});
			li.appendChild(label);
			li.appendChild(btn);
			recentProjectsList.appendChild(li);
		})(recent[i]);
	}
}

if (chooseBrain) {
	chooseBrain.addEventListener("click", function () {
		workspace.chooseBrainFolder(refreshWorkspaceUi);
	});
}

if (rescanBrain) {
	rescanBrain.addEventListener("click", function () {
		var ws = workspace.loadWorkspace();
		if (ws.brainRoot) {
			workspace.scanBrainRoot(ws.brainRoot);
		}
		refreshWorkspaceUi();
	});
}

if (openProjectBtn) {
	openProjectBtn.addEventListener("click", function () {
		project.chooseProjectBundle(function (err) {
			if (err) {
				alert(String(err.message || err));
				return;
			}
			refreshProjectUi();
		});
	});
}

if (closeProjectBtn) {
	closeProjectBtn.addEventListener("click", function () {
		project.clearActiveProject();
		refreshProjectUi();
	});
}

project.tryRestoreActiveProject();
refreshProjectUi();
