"use strict";

function onReady(fn) {
	if (typeof fn !== "function") {
		return;
	}
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", fn);
	} else {
		fn();
	}
}

function installGlobalErrorHandler() {
	if (window.__masonjarErrorHandlerInstalled) {
		return;
	}
	window.__masonjarErrorHandlerInstalled = true;
	window.onerror = function (_message, _source, _lineno, _colno, err) {
		var msg = err && err.message ? err.message : String(_message || "Unknown error");
		alert("Mason Jar: " + msg);
	};
	window.addEventListener("unhandledrejection", function (event) {
		var reason = event.reason;
		var msg =
			reason && reason.message
				? reason.message
				: String(reason || "Unhandled promise rejection");
		alert("Mason Jar: " + msg);
	});
}

module.exports = {
	onReady: onReady,
	installGlobalErrorHandler: installGlobalErrorHandler,
};
