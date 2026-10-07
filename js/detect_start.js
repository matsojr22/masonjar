"use strict";

var manualChoice = document.getElementById("manualChoice");
var exploreChoice = document.getElementById("exploreChoice");
var proceedBtn = document.getElementById("choiceProceed");

function syncProceed() {
	if (!proceedBtn) {
		return;
	}
	var picked =
		(manualChoice && manualChoice.checked) ||
		(exploreChoice && exploreChoice.checked);
	proceedBtn.disabled = !picked;
}

function chooseExclusive(which) {
	if (which === "manual" && manualChoice && manualChoice.checked && exploreChoice) {
		exploreChoice.checked = false;
	}
	if (which === "explore" && exploreChoice && exploreChoice.checked && manualChoice) {
		manualChoice.checked = false;
	}
	syncProceed();
}

if (manualChoice) {
	manualChoice.addEventListener("change", function () {
		chooseExclusive("manual");
	});
}
if (exploreChoice) {
	exploreChoice.addEventListener("change", function () {
		chooseExclusive("explore");
	});
}
if (proceedBtn) {
	proceedBtn.addEventListener("click", function () {
		if (manualChoice && manualChoice.checked) {
			window.location.href = "./detect_wizard.html";
			return;
		}
		if (exploreChoice && exploreChoice.checked) {
			window.location.href = "./detect_params_wizard.html";
		}
	});
}
syncProceed();
