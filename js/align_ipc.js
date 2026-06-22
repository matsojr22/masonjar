"use strict";

/** stdout lines from py/map.py that complete the Align IPC handshake. */
var ALIGN_MSG_DONE = "Done!";
var ALIGN_MSG_VIEWER_CLOSED = "Viewer closed";

/**
 * Classify a python-shell stdout line from map.py.
 * @param {string} message
 * @returns {"done"|"viewer_closed"|"other"}
 */
function classifyAlignStdoutMessage(message) {
	var text = String(message || "").trim();
	if (text === ALIGN_MSG_DONE) {
		return "done";
	}
	if (text === ALIGN_MSG_VIEWER_CLOSED) {
		return "viewer_closed";
	}
	return "other";
}

/**
 * Payload sent to the renderer on alignResult.
 * @param {"done"|"viewer_closed"} kind
 * @returns {{ cancelled: boolean }}
 */
function alignResultPayloadForKind(kind) {
	return { cancelled: kind === "viewer_closed" };
}

/**
 * Whether alignResult should update active runs / warp report.
 * @param {{ cancelled?: boolean }|null|undefined} response
 * @returns {boolean}
 */
function shouldApplyAlignRunSideEffects(response) {
	return !(response && response.cancelled);
}

module.exports = {
	ALIGN_MSG_DONE: ALIGN_MSG_DONE,
	ALIGN_MSG_VIEWER_CLOSED: ALIGN_MSG_VIEWER_CLOSED,
	classifyAlignStdoutMessage: classifyAlignStdoutMessage,
	alignResultPayloadForKind: alignResultPayloadForKind,
	shouldApplyAlignRunSideEffects: shouldApplyAlignRunSideEffects,
};
