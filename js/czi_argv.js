"use strict";

/** Mirror of appendCziPathArgs / appendCziInputArg in src/main.ts (for tests). */
function appendCziPathArgs(args, bundleRoot, configPath) {
	args.push("-b", String(bundleRoot || "").trim());
	if (configPath != null && String(configPath).trim().length > 0) {
		args.push("-j", String(configPath).trim());
	}
}

function appendCziInputArg(args, inputDir) {
	args.push("-i", String(inputDir || "").trim());
}

module.exports = {
	appendCziPathArgs: appendCziPathArgs,
	appendCziInputArg: appendCziInputArg,
};
