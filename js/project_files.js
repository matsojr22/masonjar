"use strict";

var project = require("./project");
var fileIndex = require("./file_index");
var pipelineRuns = require("./pipeline_runs");
var activeRunControls = require("./active_run_controls");
var dialogs = require("./dialogs");

function sectionNumberFromSliceId(sliceId) {
	var m = String(sliceId).match(/_s(\d+)/i);
	return m ? m[1] : sliceId;
}

function populateSubsetList(container, selectedIds) {
	if (!container) {
		return;
	}
	container.innerHTML = "";
	var index = project.readProjectFileIndex();
	if (!index) {
		return;
	}
	var report = fileIndex.computeMatchReport(index, fileIndex.INPUT_MATCH_ROLES);
	var ids = report.matchedSliceIds || [];
	selectedIds = selectedIds || [];
	var selected = {};
	for (var i = 0; i < selectedIds.length; i++) {
		selected[selectedIds[i]] = true;
	}
	for (var s = 0; s < ids.length; s++) {
		var sid = ids[s];
		var div = document.createElement("div");
		div.className = "form-check";
		div.innerHTML =
			'<input class="form-check-input subset-slice" type="checkbox" value="' +
			sid +
			'" id="subset_' +
			sid +
			'"' +
			(selected[sid] ? " checked" : "") +
			"/>" +
			'<label class="form-check-label" for="subset_' +
			sid +
			'">' +
			sid +
			" (s" +
			sectionNumberFromSliceId(sid) +
			")</label>";
		container.appendChild(div);
	}
}

function bindActiveRunControls(containerId) {
	var container = document.getElementById(containerId);
	if (!container || !project.isActive()) {
		if (container) {
			container.classList.add("d-none");
		}
		return;
	}
	container.classList.remove("d-none");
	container.innerHTML = "";
	var heading = document.createElement("h2");
	heading.className = "h6 text-muted mb-2";
	heading.textContent = "Active pipeline runs (project)";
	container.appendChild(heading);

	for (var i = 0; i < pipelineRuns.OUTPUT_ROLES.length; i++) {
		(function (role) {
			project.ensureDefaultActiveRunForRole(role);
			var choices = project.listRunChoicesForRole(role);
			if (!choices.length) {
				return;
			}
			var row = document.createElement("div");
			row.className = "row align-items-center mb-2";
			var labelCol = document.createElement("div");
			labelCol.className = "col-4 col-sm-3 text-start small";
			labelCol.textContent = role;
			var selectCol = document.createElement("div");
			selectCol.className = "col d-flex align-items-center";
			var select = document.createElement("select");
			select.className = "form-select form-select-sm active-run-select flex-grow-1";
			select.dataset.role = role;
			var active = pipelineRuns.getActiveRunRelForRole(role);
			for (var c = 0; c < choices.length; c++) {
				var opt = document.createElement("option");
				opt.value = choices[c].rel;
				opt.textContent = choices[c].label || choices[c].rel || "(flat)";
				if (choices[c].rel === active) {
					opt.selected = true;
				}
				select.appendChild(opt);
			}
			select.addEventListener("change", function () {
				project.setActiveRunForRole(role, select.value);
				project.refreshProjectIndex().catch(function () {});
			});
			selectCol.appendChild(select);
			selectCol.appendChild(
				activeRunControls.attachRunDeleteButton(select, role, {
					onDeleted: function () {
						bindActiveRunControls(containerId);
					},
				}),
			);
			row.appendChild(labelCol);
			row.appendChild(selectCol);
			container.appendChild(row);
		})(pipelineRuns.OUTPUT_ROLES[i]);
	}
}

function bindProjectFileControls(options) {
	options = options || {};
	var subsetSection = document.getElementById("projectSubsetSection");
	var subsetToggle = document.getElementById("subsetEnabled");
	var subsetList = document.getElementById("subsetSliceList");
	var rescanBtn = document.getElementById("rescanProject");
	var addFilesBtn = document.getElementById("addFilesToRole");

	if (!project.isActive()) {
		if (subsetSection) {
			subsetSection.classList.add("d-none");
		}
		if (rescanBtn) {
			rescanBtn.classList.add("d-none");
		}
		if (addFilesBtn) {
			addFilesBtn.classList.add("d-none");
		}
		return;
	}

	if (subsetSection) {
		subsetSection.classList.remove("d-none");
	}
	if (rescanBtn) {
		rescanBtn.classList.remove("d-none");
	}
	if (addFilesBtn) {
		addFilesBtn.classList.remove("d-none");
	}

	bindActiveRunControls("projectActiveRunsSection");

	var proj = project.getProject();
	var proc = proj.processing || project.defaultProcessing();
	if (subsetToggle) {
		subsetToggle.checked = !!proc.subset_enabled;
		if (subsetList) {
			subsetList.classList.toggle("d-none", !proc.subset_enabled);
		}
		populateSubsetList(subsetList, proc.slice_ids || []);
		subsetToggle.addEventListener("change", function () {
			if (!proj.processing) {
				proj.processing = project.defaultProcessing();
			}
			proj.processing.subset_enabled = subsetToggle.checked;
			if (subsetList) {
				subsetList.classList.toggle("d-none", !subsetToggle.checked);
			}
			project.saveProjectJson();
		});
	}

	function saveSubsetIds() {
		if (!subsetList) {
			return;
		}
		var boxes = subsetList.querySelectorAll(".subset-slice:checked");
		var ids = [];
		for (var i = 0; i < boxes.length; i++) {
			ids.push(boxes[i].value);
		}
		if (!proj.processing) {
			proj.processing = project.defaultProcessing();
		}
		proj.processing.slice_ids = ids;
		project.saveProjectJson();
	}

	if (subsetList) {
		subsetList.addEventListener("change", function (ev) {
			if (ev.target && ev.target.classList.contains("subset-slice")) {
				saveSubsetIds();
			}
		});
	}

	if (rescanBtn) {
		rescanBtn.addEventListener("click", function () {
			rescanBtn.disabled = true;
			project
				.refreshProjectIndex()
				.then(function () {
					populateSubsetList(
						subsetList,
						(proj.processing && proj.processing.slice_ids) || [],
					);
					if (typeof options.onRescan === "function") {
						options.onRescan();
					}
					alert("Project file index refreshed.");
				})
				.catch(function (err) {
					alert(String(err.message || err));
				})
				.finally(function () {
					rescanBtn.disabled = false;
				});
		});
	}

	if (addFilesBtn) {
		addFilesBtn.addEventListener("click", function () {
			var chosenRole = "";
			dialogs
				.pickProjectRole(project.CANONICAL_ROLES, "dapi")
				.then(function (role) {
					if (!role) {
						return null;
					}
					if (!project.CANONICAL_ROLES[role]) {
						alert("Unknown role: " + role);
						return null;
					}
					chosenRole = role;
					return dialogs.pickDirectory({ tag: "addFiles_" + role });
				})
				.then(function (selected) {
					if (!selected || !chosenRole) {
						return;
					}
					var bundleRoot = project.getBundleRoot();
					var roles = proj.roles || project.CANONICAL_ROLES;
					var destDir = project.resolveRolePath(chosenRole);
					if (!destDir) {
						alert("Could not resolve role path.");
						return;
					}
					project.importSourceToRoleWithLayout(
						selected,
						chosenRole,
						"copy",
						bundleRoot,
						roles,
					);
					return project.refreshProjectIndex();
				})
				.then(function (refreshed) {
					if (!refreshed) {
						return;
					}
					populateSubsetList(
						subsetList,
						(proj.processing && proj.processing.slice_ids) || [],
					);
					alert("Files imported into " + chosenRole + "; index refreshed.");
				})
				.catch(function (err) {
					alert(String(err.message || err));
				});
		});
	}
}

module.exports = {
	bindProjectFileControls: bindProjectFileControls,
	bindActiveRunControls: bindActiveRunControls,
	populateSubsetList: populateSubsetList,
};
