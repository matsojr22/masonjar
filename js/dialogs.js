"use strict";

var ipc = require("electron").ipcRenderer;

/**
 * @param {{ tag: string, defaultPath?: string }} opts
 * @returns {Promise<string|null>} Selected directory path, or null if canceled.
 */
function pickDirectory(opts) {
	opts = opts || {};
	var tag = opts.tag || "input";
	var payload = opts.defaultPath ? { tag: tag, defaultPath: opts.defaultPath } : tag;
	return ipc
		.invoke("showOpenDirectoryDialog", payload)
		.then(function (result) {
			if (!result) {
				alert("Folder dialog failed: no response from the app.");
				return null;
			}
			if (result.error) {
				alert("Could not open folder dialog:\n" + result.error);
				return null;
			}
			if (result.canceled || !result.path) {
				return null;
			}
			return result.path;
		})
		.catch(function (err) {
			alert("Could not open folder dialog:\n" + String(err.message || err));
			return null;
		});
}

module.exports = {
	pickDirectory: pickDirectory,
};
