"use strict";

/** stdout lines from py/map.py / py/adjust.py that complete viewer-tool IPC. */
var ALIGN_MSG_DONE = "Done!";
var ALIGN_MSG_VIEWER_CLOSED = "Viewer closed";
var VIEWER_TOOL_MSG_DONE = ALIGN_MSG_DONE;
var VIEWER_TOOL_MSG_VIEWER_CLOSED = ALIGN_MSG_VIEWER_CLOSED;

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

function classifyViewerToolStdoutMessage(message) {
	return classifyAlignStdoutMessage(message);
}

/**
 * Payload sent to the renderer on adjustResult / alignResult.
 * @param {"done"|"viewer_closed"} kind
 * @returns {{ cancelled: boolean }}
 */
function viewerToolResultPayloadForKind(kind) {
	return alignResultPayloadForKind(kind);
}

function shouldApplyViewerToolSideEffects(response) {
	return shouldApplyAlignRunSideEffects(response);
}

module.exports = {
	ALIGN_MSG_DONE: ALIGN_MSG_DONE,
	ALIGN_MSG_VIEWER_CLOSED: ALIGN_MSG_VIEWER_CLOSED,
	VIEWER_TOOL_MSG_DONE: VIEWER_TOOL_MSG_DONE,
	VIEWER_TOOL_MSG_VIEWER_CLOSED: VIEWER_TOOL_MSG_VIEWER_CLOSED,
	classifyAlignStdoutMessage: classifyAlignStdoutMessage,
	classifyViewerToolStdoutMessage: classifyViewerToolStdoutMessage,
	alignResultPayloadForKind: alignResultPayloadForKind,
	viewerToolResultPayloadForKind: viewerToolResultPayloadForKind,
	shouldApplyAlignRunSideEffects: shouldApplyAlignRunSideEffects,
	shouldApplyViewerToolSideEffects: shouldApplyViewerToolSideEffects,
};
