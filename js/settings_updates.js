"use strict";

var ipc = require("electron").ipcRenderer;
var pageInit = require("./page_init");
var navTrail = require("./nav_trail");

var LS_ALLOW_PRERELEASE = "masonjar.update.allowPrerelease";

var state = {
	cached: null,
	applyInfo: null,
	currentVersion: "",
	busy: false,
};

function qs(id) {
	return document.getElementById(id);
}

function setFeedback(msg, isError) {
	var el = qs("updateFeedback");
	if (!el) {
		return;
	}
	el.textContent = msg || "";
	el.classList.toggle("text-danger", !!isError);
	el.classList.toggle("text-muted", !isError && !!msg);
}

function setProgress(visible, percent, message) {
	var wrap = qs("updateProgressWrap");
	var bar = qs("updateProgressBar");
	var status = qs("updateProgressStatus");
	if (wrap) {
		wrap.classList.toggle("d-none", !visible);
	}
	if (bar) {
		var pct = Math.max(0, Math.min(100, Number(percent) || 0));
		bar.style.width = pct + "%";
		bar.setAttribute("aria-valuenow", String(pct));
	}
	if (status) {
		status.classList.toggle("d-none", !visible);
		status.textContent = message || "";
	}
}

function openedFromStartupPrompt() {
	try {
		var params = new URLSearchParams(window.location.search || "");
		return params.get("pending") === "1";
	} catch (_e) {
		return false;
	}
}

function renderVersionLabels() {
	var currentEl = qs("currentVersionLabel");
	var latestEl = qs("latestVersionLabel");
	var badge = qs("prereleaseBadge");
	var summary = qs("updateSummaryLine");
	var notesBlock = qs("releaseNotesBlock");
	var notesText = qs("releaseNotesText");

	if (currentEl) {
		currentEl.textContent = state.currentVersion || "—";
	}

	var cached = state.cached;
	var latest = cached && cached.latest;
	if (latestEl) {
		latestEl.textContent = latest || "—";
	}
	if (badge) {
		badge.classList.toggle("d-none", !(cached && cached.isPrerelease));
	}
	if (summary) {
		if (!cached) {
			summary.textContent = "Could not load update information.";
		} else if (cached.error) {
			summary.textContent = cached.error;
		} else if (cached.updateAvailable) {
			summary.textContent =
				"A newer version (" + cached.latest + ") is available.";
		} else if (latest) {
			summary.textContent = "You're up to date.";
		} else {
			summary.textContent = "No published releases found on GitHub.";
		}
	}
	if (notesBlock && notesText) {
		var excerpt = (cached && cached.releaseNotesExcerpt) || "";
		var showNotes = !!excerpt && !!(cached && cached.updateAvailable);
		notesBlock.classList.toggle("d-none", !showNotes);
		notesText.textContent = excerpt;
	}
}

function renderActionButtons() {
	var checkBtn = qs("checkAgainBtn");
	var updateNowBtn = qs("updateNowBtn");
	var macBtn = qs("macDownloadBtn");
	var releaseBtn = qs("openReleaseBtn");
	var info = state.applyInfo || {};
	var cached = state.cached || {};
	var canWinApply = !!info.canApplyInApp;
	var isDarwin = info.platform === "darwin";
	var hasUpdate = !!cached.updateAvailable;

	if (checkBtn) {
		checkBtn.disabled = state.busy;
	}
	if (updateNowBtn) {
		updateNowBtn.classList.toggle("d-none", !canWinApply || !hasUpdate);
		updateNowBtn.disabled =
			state.busy || !hasUpdate || !!info.updateInProgress;
	}
	if (macBtn) {
		macBtn.classList.toggle("d-none", !isDarwin || !hasUpdate);
		macBtn.disabled = state.busy;
	}
	if (releaseBtn) {
		releaseBtn.classList.toggle("d-none", !cached.releaseUrl);
		releaseBtn.disabled = state.busy;
	}
}

function renderUpdateTestBanner() {
	var banner = qs("updateTestBanner");
	if (!banner) {
		return;
	}
	if (state.currentVersion === "6.0.3") {
		banner.textContent =
			"Pre-release build — validates Update Now from 6.0.2.";
		banner.classList.remove("d-none");
	} else {
		banner.textContent = "";
		banner.classList.add("d-none");
	}
}

function applyStatusPayload(payload) {
	if (!payload) {
		return;
	}
	state.cached = payload.cached || payload.result || state.cached;
	state.applyInfo = payload.applyInfo || state.applyInfo;
	if (payload.currentVersion) {
		state.currentVersion = payload.currentVersion;
	}
	renderVersionLabels();
	renderActionButtons();
	renderUpdateTestBanner();
}

function refreshFromMain(useCacheOnly) {
	if (useCacheOnly) {
		return ipc.invoke("getUpdateStatus").then(applyStatusPayload);
	}
	var allowEl = qs("allowPrerelease");
	var allowPrerelease = allowEl ? !!allowEl.checked : false;
	return ipc
		.invoke("checkForUpdatesDetailed", { allowPrerelease: allowPrerelease })
		.then(applyStatusPayload);
}

function savePreferencesAndRefresh() {
	var allowEl = qs("allowPrerelease");
	var allow = allowEl ? !!allowEl.checked : false;
	try {
		localStorage.setItem(LS_ALLOW_PRERELEASE, allow ? "1" : "0");
	} catch (_e) {
		// ignore
	}
	setFeedback("");
	return ipc
		.invoke("saveUpdatePreferences", { allowPrerelease: allow })
		.then(function () {
			return refreshFromMain(false);
		});
}

function confirmUpdateNow() {
	var cached = state.cached || {};
	var lines = [
		"Mason Jar will download the update, quit, and restart with version " +
			(cached.latest || "?") +
			".",
		"Finish or cancel any running pipeline jobs first.",
	];
	if (cached.isPrerelease) {
		lines.unshift("This is a pre-release build.");
	}
	return Promise.resolve(
		window.confirm("Update Now?\n\n" + lines.join("\n\n")),
	);
}

function onUpdateNowClick() {
	if (state.busy) {
		return;
	}
	confirmUpdateNow().then(function (ok) {
		if (!ok) {
			return;
		}
		state.busy = true;
		setFeedback("");
		setProgress(true, 0, "Preparing update…");
		renderActionButtons();
		ipc
			.invoke("runWindowsUpdateNow")
			.then(function (result) {
				if (!result || !result.ok) {
					setFeedback((result && result.error) || "Update failed.", true);
					setProgress(false, 0, "");
					state.busy = false;
					renderActionButtons();
					return ipc.invoke("getUpdateStatus");
				}
				setFeedback("Installing update… Mason Jar will restart.");
				setProgress(true, 100, "Installing update…");
			})
			.then(function (payload) {
				if (payload) {
					applyStatusPayload(payload);
				}
			})
			.catch(function (err) {
				setFeedback(String(err && err.message ? err.message : err), true);
				setProgress(false, 0, "");
				state.busy = false;
				renderActionButtons();
			});
	});
}

function openReleasePage() {
	var url = state.cached && state.cached.releaseUrl;
	if (!url) {
		return;
	}
	ipc.invoke("openExternalUrl", url);
}

function openUpdateLog() {
	ipc.invoke("openUpdateLog").then(function (result) {
		if (result && result.message) {
			setFeedback(result.message, false);
		}
	}).catch(function (err) {
		setFeedback(String(err && err.message ? err.message : err), true);
	});
}

function restorePrereleaseToggle(prefs) {
	var allowEl = qs("allowPrerelease");
	if (!allowEl) {
		return;
	}
	var fromPrefs = prefs && prefs.allow_prerelease;
	var stored = null;
	try {
		stored = localStorage.getItem(LS_ALLOW_PRERELEASE);
	} catch (_e) {
		stored = null;
	}
	if (stored === "1" || stored === "0") {
		allowEl.checked = stored === "1";
	} else if (fromPrefs != null) {
		allowEl.checked = !!fromPrefs;
	}
}

pageInit.onReady(function () {
	pageInit.installGlobalErrorHandler();
	navTrail.renderTrail(
		[
			{ label: "Start", href: "./menu.html" },
			{ label: "Settings", href: "./settings.html" },
			{ label: "Updates" },
		],
		"navTrail",
	);

	ipc.on("updateDownloadProgress", function (_event, data) {
		var pct = data && data[0];
		var msg = data && data[1];
		setProgress(true, pct, msg);
	});

	var checkBtn = qs("checkAgainBtn");
	var updateNowBtn = qs("updateNowBtn");
	var macBtn = qs("macDownloadBtn");
	var releaseBtn = qs("openReleaseBtn");
	var allowEl = qs("allowPrerelease");
	var logBtn = qs("openUpdateLogBtn");

	if (checkBtn) {
		checkBtn.addEventListener("click", function () {
			setFeedback("");
			state.busy = true;
			renderActionButtons();
			refreshFromMain(false)
				.catch(function (err) {
					setFeedback(String(err && err.message ? err.message : err), true);
				})
				.finally(function () {
					state.busy = false;
					renderActionButtons();
				});
		});
	}
	if (updateNowBtn) {
		updateNowBtn.addEventListener("click", onUpdateNowClick);
	}
	if (macBtn) {
		macBtn.addEventListener("click", openReleasePage);
	}
	if (releaseBtn) {
		releaseBtn.addEventListener("click", openReleasePage);
	}
	if (logBtn) {
		logBtn.addEventListener("click", openUpdateLog);
	}
	if (allowEl) {
		allowEl.addEventListener("change", function () {
			state.busy = true;
			renderActionButtons();
			savePreferencesAndRefresh()
				.catch(function (err) {
					setFeedback(String(err && err.message ? err.message : err), true);
				})
				.finally(function () {
					state.busy = false;
					renderActionButtons();
				});
		});
	}

	ipc.invoke("getUpdateStatus").then(function (payload) {
		restorePrereleaseToggle(payload && payload.preferences);
		applyStatusPayload(payload);
		var useCache =
			openedFromStartupPrompt() &&
			state.cached &&
			state.cached.updateAvailable;
		if (useCache) {
			setFeedback("Update available — click Update Now when ready.");
			return null;
		}
		return refreshFromMain(false);
	}).catch(function (err) {
		setFeedback(String(err && err.message ? err.message : err), true);
	});
});
