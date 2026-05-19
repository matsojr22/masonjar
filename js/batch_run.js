"use strict";

var ipc = require("electron").ipcRenderer;
var registry = require("./batch_registry");

var plan = registry.loadBatchPlan();
if (!plan || !plan.projects || !plan.steps) {
	window.location.href = "./batch_select.html";
}

var runSummary = document.getElementById("runSummary");
var elapsedEl = document.getElementById("elapsed");
var statusLine = document.getElementById("statusLine");
var loadbar = document.getElementById("loadbar");
var loadmessage = document.getElementById("loadmessage");
var logBody = document.getElementById("logBody");
var errorSummary = document.getElementById("errorSummary");
var startBatchBtn = document.getElementById("startBatch");
var cancelBatchBtn = document.getElementById("cancelBatch");
var backLink = document.getElementById("backLink");

var elapsedTimer = null;
var elapsedStart = null;
var running = false;

function formatElapsed(ms) {
	var s = Math.floor(ms / 1000);
	var h = Math.floor(s / 3600);
	var m = Math.floor((s % 3600) / 60);
	var sec = s % 60;
	return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

function appendLog(text) {
	if (!logBody) {
		return;
	}
	var tr = document.createElement("tr");
	var now = new Date().toLocaleTimeString();
	tr.innerHTML =
		"<td class=\"text-muted\">" + now + '</td><td>' + escapeHtml(text) + "</td>";
	logBody.appendChild(tr);
	logBody.parentElement.scrollTop = logBody.parentElement.scrollHeight;
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderSummary() {
	if (!runSummary) {
		return;
	}
	var lines = [
		"<strong>" +
			plan.projects.length +
			"</strong> project(s), <strong>" +
			plan.steps.length +
			"</strong> step(s): " +
			plan.steps.map(registry.getStepLabel).join(", "),
	];
	if (plan.warnings && plan.warnings.length) {
		lines.push(
			'<span class="text-warning">' +
				plan.warnings.length +
				" preflight warning(s) — see log after start.</span>",
		);
	}
	runSummary.innerHTML = lines.join("<br />");
}

function setRunning(isRunning) {
	running = isRunning;
	if (startBatchBtn) {
		startBatchBtn.classList.toggle("d-none", isRunning);
	}
	if (cancelBatchBtn) {
		cancelBatchBtn.classList.toggle("d-none", !isRunning);
	}
	if (backLink) {
		backLink.classList.toggle("disabled", isRunning);
		if (isRunning) {
			backLink.setAttribute("aria-disabled", "true");
			backLink.onclick = function (e) {
				e.preventDefault();
			};
		} else {
			backLink.removeAttribute("aria-disabled");
			backLink.onclick = null;
		}
	}
}

function startElapsed() {
	elapsedStart = Date.now();
	if (elapsedTimer) {
		clearInterval(elapsedTimer);
	}
	elapsedTimer = setInterval(function () {
		if (elapsedEl && elapsedStart) {
			elapsedEl.textContent = formatElapsed(Date.now() - elapsedStart);
		}
	}, 1000);
}

function stopElapsed() {
	if (elapsedTimer) {
		clearInterval(elapsedTimer);
		elapsedTimer = null;
	}
}

if (startBatchBtn) {
	startBatchBtn.addEventListener("click", function () {
		setRunning(true);
		if (statusLine) {
			statusLine.textContent = "Running…";
		}
		appendLog("Starting batch…");
		startElapsed();
		ipc.send("runBatch", plan);
	});
}

if (cancelBatchBtn) {
	cancelBatchBtn.addEventListener("click", function () {
		appendLog("Cancel requested…");
		ipc.send("killBatch", []);
	});
}

ipc.on("batchJobStart", function (event, info) {
	var msg =
		"Job: " +
		(info.project || "?") +
		" — " +
		registry.getStepLabel(info.step || info.stepId || "");
	appendLog(msg);
	if (statusLine) {
		statusLine.textContent = msg;
	}
	if (!elapsedStart) {
		startElapsed();
	}
});

ipc.on("batchProgress", function (event, data) {
	var pct = data[0];
	var message = data[1] || "";
	var detail = data[2] || "";
	if (loadbar) {
		loadbar.style.width = String(pct) + "%";
	}
	if (loadmessage) {
		loadmessage.textContent = message + (detail ? " — " + detail : "");
	}
});

ipc.on("batchComplete", function (event, result) {
	setRunning(false);
	stopElapsed();
	if (statusLine) {
		statusLine.textContent = result && result.errors && result.errors.length
			? "Finished with errors"
			: "Complete";
	}
	if (loadbar) {
		loadbar.style.width = "100%";
	}
	appendLog("Batch complete.");
	if (result && result.errors && result.errors.length) {
		if (errorSummary) {
			errorSummary.classList.remove("d-none");
			errorSummary.innerHTML =
				"<strong>Errors</strong><ul class=\"mb-0 ps-3\"><li>" +
				result.errors.map(escapeHtml).join("</li><li>") +
				"</li></ul>";
		}
		for (var i = 0; i < result.errors.length; i++) {
			appendLog("ERROR: " + result.errors[i]);
		}
	}
});

renderSummary();
