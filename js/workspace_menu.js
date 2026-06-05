"use strict";

var ipc = require("electron").ipcRenderer;
var pageInit = require("./page_init");
var navTrail = require("./nav_trail");
var project = require("./project");
var pipelineGate = require("./pipeline_gate");
var projectFiles = require("./project_files");
var appLogToggle = require("./app_log_toggle");
var ioFairshareSettings = require("./io_fairshare_settings");

var projectChip = document.getElementById("projectChip");

function refreshProjectChip() {
	if (!projectChip) {
		return;
	}
	var ctx = pipelineGate.getContextLabel();
	if (!ctx) {
		projectChip.classList.add("d-none");
		projectChip.innerHTML = "";
		return;
	}
	var closeHtml = "";
	if (ctx.type === "project") {
		closeHtml =
			' <button type="button" class="btn btn-link btn-sm p-0" id="closeProjectChip">Close</button>';
	}
	projectChip.classList.remove("d-none");
	projectChip.innerHTML =
		'<span class="menu-project-chip-label">Current: <strong>' +
		ctx.label +
		"</strong> (" +
		ctx.detail +
		")</span>" +
		closeHtml;
	var closeBtn = document.getElementById("closeProjectChip");
	if (closeBtn) {
		closeBtn.addEventListener("click", function () {
			project.clearActiveProject();
			window.location.replace("./menu.html");
		});
	}
}

pageInit.onReady(function () {
	pageInit.installGlobalErrorHandler();
	project.tryRestoreActiveProject();
	pipelineGate.assertPipelineAccess();
	appLogToggle.bindAppLogToggle(document.getElementById("toggleAppLog"));
	navTrail.renderTrail(
		[
			{ label: "Start", href: "./menu.html" },
			{ label: "Workspace" },
		],
		"navTrail",
	);
	refreshProjectChip();
	project.addProcessingStateListener(function () {
		projectFiles.renderStepFailures();
	});
	projectFiles.bindProjectFileControls();
	var compact = document.getElementById("ioFairshareStatusCompact");
	if (compact) {
		var ipc = require("electron").ipcRenderer;
		ipc.on("ioFairshareStatus", function (_event, status) {
			if (!status || !status.enabled) {
				compact.textContent = "";
				return;
			}
			compact.textContent =
				"Network share: " +
				(status.active_jobs || 0) +
				" active job(s) on this machine · ~" +
				Math.round(status.limit_mbps || 0) +
				" Mbps for new pipeline I/O";
		});
		ioFairshareSettings.refreshStatus();
	}
});
