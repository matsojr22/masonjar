"use strict";

var ipc = require("electron").ipcRenderer;

var enabledEl = null;
var linkModeEl = null;
var linkManualEl = null;
var statusEl = null;
var refreshTimer = null;

function qs(id) {
	return document.getElementById(id);
}

function formatMbps(n) {
	var v = Number(n);
	if (!Number.isFinite(v)) {
		return "—";
	}
	if (v >= 1000) {
		return (v / 1000).toFixed(1) + " Gbps budget share";
	}
	return Math.round(v) + " Mbps";
}

function renderStatus(status) {
	if (!statusEl || !status) {
		return;
	}
	if (!status.enabled) {
		statusEl.textContent = "Network fair-share is off for this user.";
		return;
	}
	var jobs = status.active_jobs || 0;
	var limit = formatMbps(status.limit_mbps);
	var link = formatMbps(status.link_mbps).replace(" budget share", "");
	statusEl.textContent =
		"Link " +
		link +
		" · " +
		jobs +
		" active job" +
		(jobs === 1 ? "" : "s") +
		" on this machine · your share ~" +
		limit;
}

function refreshStatus() {
	ipc.send("getIoFairshareStatus");
}

function bindNetworkSharing(rootId) {
	var root = qs(rootId || "ioFairsharePanel");
	if (!root) {
		return;
	}
	enabledEl = qs("ioFairshareEnabled");
	linkModeEl = qs("ioFairshareLinkMode");
	linkManualEl = qs("ioFairshareLinkMbps");
	statusEl = qs("ioFairshareStatus");
	if (!enabledEl || !statusEl) {
		return;
	}

	ipc.on("ioFairshareStatus", function (_event, status) {
		renderStatus(status);
		if (enabledEl && typeof status.enabled === "boolean") {
			enabledEl.checked = status.enabled;
		}
	});

	enabledEl.addEventListener("change", function () {
		ipc.send("saveIoFairshareUserConfig", { enabled: enabledEl.checked });
	});

	if (linkModeEl) {
		linkModeEl.addEventListener("change", function () {
			var manualWrap = qs("ioFairshareManualWrap");
			if (manualWrap) {
				manualWrap.classList.toggle("d-none", linkModeEl.value !== "manual");
			}
		});
	}

	var saveLinkBtn = qs("ioFairshareSaveLink");
	if (saveLinkBtn) {
		saveLinkBtn.addEventListener("click", function () {
			var patch = {};
			if (linkModeEl && linkModeEl.value === "manual" && linkManualEl) {
				var mbps = Number(linkManualEl.value);
				if (Number.isFinite(mbps) && mbps > 0) {
					patch.link_mbps = mbps;
				}
			} else {
				patch.link_mbps = "auto";
			}
			ipc.send("saveIoFairshareUserConfig", patch);
		});
	}

	refreshStatus();
	if (refreshTimer) {
		clearInterval(refreshTimer);
	}
	refreshTimer = setInterval(refreshStatus, 10000);
}

module.exports = {
	bindNetworkSharing: bindNetworkSharing,
	refreshStatus: refreshStatus,
	renderStatus: renderStatus,
};
