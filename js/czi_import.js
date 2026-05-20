"use strict";

var path = require("path");

var ROLE_DAPI = "dapi";
var ROLE_SIGNAL_SOMATA = "signal_somata";
var ROLE_SIGNAL_NUCLEI = "signal_nuclei";
var ROLE_SIGNAL_AXONS = "signal_axons";
var ROLE_OTHER = "other";
var ROLE_UNUSED = "unused";

var ROLE_TO_BRANCH = {
	signal_somata: "somata",
	signal_nuclei: "nuclei",
	signal_axons: "axons",
};

var CHANNEL_ROLE_OPTIONS = [
	{ value: ROLE_DAPI, label: "DAPI (counterstain)" },
	{ value: ROLE_SIGNAL_SOMATA, label: "Signal — somata / rabies" },
	{ value: ROLE_SIGNAL_NUCLEI, label: "Signal — nuclei" },
	{ value: ROLE_SIGNAL_AXONS, label: "Signal — axons" },
	{ value: ROLE_OTHER, label: "Other (custom signal)" },
	{ value: ROLE_UNUSED, label: "Unused (skip)" },
];

var DEFAULT_PREVIEW_SCALE = 0.05;

function branchForRole(role) {
	return ROLE_TO_BRANCH[role] || "";
}

function sanitizeOtherName(raw) {
	var s = String(raw || "").trim();
	if (!s) {
		return null;
	}
	s = s.replace(/\s+/g, "_");
	s = s.replace(/[^a-zA-Z0-9_-]/g, "");
	s = s.replace(/_+/g, "_").replace(/^_|_$/g, "");
	if (!s || s.length > 32) {
		return null;
	}
	return s;
}

function branchForChannel(ch) {
	if (!ch) {
		return "";
	}
	var role = ch.role;
	if (role === ROLE_DAPI || role === ROLE_UNUSED) {
		return "";
	}
	if (role === ROLE_OTHER) {
		return sanitizeOtherName(ch.other_name) || "";
	}
	return ROLE_TO_BRANCH[role] || "";
}

function roleKeyForChannel(ch) {
	if (!ch) {
		return ROLE_UNUSED;
	}
	if (ch.role === ROLE_OTHER) {
		var name = sanitizeOtherName(ch.other_name);
		return name ? "other:" + name : ROLE_OTHER;
	}
	return ch.role;
}

function isSignalChannel(ch) {
	if (!ch || !ch.keep) {
		return false;
	}
	if (
		ch.role === ROLE_SIGNAL_SOMATA ||
		ch.role === ROLE_SIGNAL_NUCLEI ||
		ch.role === ROLE_SIGNAL_AXONS
	) {
		return true;
	}
	return ch.role === ROLE_OTHER && !!sanitizeOtherName(ch.other_name);
}

function collectChannelIndices(cziImport) {
	var seen = {};
	var channels = (cziImport && cziImport.channels) || [];
	for (var i = 0; i < channels.length; i++) {
		seen[String(channels[i].index)] = true;
	}
	return Object.keys(seen)
		.map(function (k) {
			return Number(k);
		})
		.sort(function (a, b) {
			return a - b;
		});
}

function applyChannelDefaults(cziImport, channelIndex, defaults) {
	if (!cziImport.channel_defaults) {
		cziImport.channel_defaults = {};
	}
	cziImport.channel_defaults[String(channelIndex)] = {
		role: defaults.role,
		other_name: defaults.other_name || "",
	};
	var channels = cziImport.channels || [];
	for (var i = 0; i < channels.length; i++) {
		if (channels[i].index !== channelIndex) {
			continue;
		}
		channels[i].role = defaults.role;
		if (defaults.role === ROLE_OTHER) {
			channels[i].other_name = defaults.other_name || "";
		} else {
			delete channels[i].other_name;
		}
	}
	return cziImport;
}

var SLICE_NUMBERING_PRESERVE = "preserve";
var SLICE_NUMBERING_RENAME = "rename";

function sanitizeSliceStem(stem) {
	var s = String(stem || "")
		.trim()
		.replace(/[/\\:*?"<>|]+/g, "_")
		.replace(/\s+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
	return s || "slice";
}

function parseSectionSuffix(sliceIdOrStem) {
	var text = String(sliceIdOrStem || "");
	var m = text.match(/_s(\d+)/i);
	if (m) {
		return Number(m[1]);
	}
	var trail = text.match(/(\d+)\s*$/);
	return trail ? Number(trail[1]) : null;
}

function naturalSortKey(entry) {
	var sliceId = entry.sliceId || entry.originalSliceId || "";
	var basename = entry.basename || "";
	var sceneIndex =
		entry.scene_index != null
			? Number(entry.scene_index)
			: entry.index != null
				? Number(entry.index)
				: 0;
	var section = parseSectionSuffix(sliceId || basename);
	var sectionKey = section != null ? section : 1e9;
	return [
		sectionKey,
		String(basename || path.basename(entry.path || sliceId || "")).toLowerCase(),
		sceneIndex,
		String(entry.path || "").toLowerCase(),
	];
}

function naturalCompare(a, b) {
	var ka = naturalSortKey(a);
	var kb = naturalSortKey(b);
	for (var i = 0; i < ka.length; i++) {
		if (ka[i] < kb[i]) {
			return -1;
		}
		if (ka[i] > kb[i]) {
			return 1;
		}
	}
	return 0;
}

function formatOrdinalSuffix(ordinal) {
	var n = Number(ordinal) || 0;
	if (n < 10) {
		return "00" + String(n);
	}
	if (n < 100) {
		return "0" + String(n);
	}
	return String(n);
}

function isValidSliceId(sliceId) {
	var s = sanitizeSliceStem(sliceId);
	return !!s && s === String(sliceId || "").trim();
}

function defaultSliceId(basename, sceneIndex, sceneCount) {
	var stem = sanitizeSliceStem(String(basename || "slice").replace(/\.czi$/i, ""));
	if (sceneCount > 1) {
		return stem + "_s" + formatOrdinalSuffix(sceneIndex);
	}
	return stem;
}

function normalizeProbeFileEntry(file, sourceDir, scanIndex) {
	var scenes = (file.scenes || []).map(function (sc) {
		var originalSliceId =
			sc.originalSliceId ||
			sc.sliceId ||
			defaultSliceId(file.basename, sc.index, file.scene_count || (file.scenes || []).length || 1);
		return {
			index: sc.index,
			sliceId: originalSliceId,
			originalSliceId: originalSliceId,
		};
	});
	return {
		path: file.path,
		basename: file.basename,
		source_dir: sourceDir || "",
		scan_index: scanIndex != null ? scanIndex : 0,
		dims: file.dims,
		scene_count: file.scene_count,
		channel_count: file.channel_count,
		z_count: file.z_count,
		is_mosaic: file.is_mosaic,
		has_m_dim: file.has_m_dim,
		m_tile_count: file.m_tile_count,
		likely_unstitched: file.likely_unstitched,
		mosaic_stitch_status: file.mosaic_stitch_status || "unknown",
		mosaic_warnings: file.mosaic_warnings || [],
		scenes: scenes,
		channels: file.channels || [],
		error: file.error,
	};
}

function collectMosaicWarnings(files) {
	var out = [];
	var seen = {};
	var list = files || [];
	for (var i = 0; i < list.length; i++) {
		var f = list[i];
		if (f.error) {
			continue;
		}
		if (!f.likely_unstitched && f.mosaic_stitch_status !== "suspect") {
			continue;
		}
		var warnings = f.mosaic_warnings || [];
		for (var w = 0; w < warnings.length; w++) {
			var msg = String(warnings[w] || "").trim();
			if (!msg || msg.indexOf("normal for ZEN-stitched") >= 0) {
				continue;
			}
			var key = (f.basename || f.path || "file") + "|" + msg;
			if (seen[key]) {
				continue;
			}
			seen[key] = true;
			out.push({
				basename: f.basename || "",
				message: msg,
			});
		}
		if (f.likely_unstitched && !warnings.length) {
			var fallback =
				(f.basename || "CZI") +
				": mosaic tiles may be unstitched — stitch in ZEN before import.";
			if (!seen[fallback]) {
				seen[fallback] = true;
				out.push({ basename: f.basename || "", message: fallback });
			}
		}
	}
	return out;
}

function collectMosaicInfo(files) {
	var out = [];
	var seen = {};
	var list = files || [];
	for (var i = 0; i < list.length; i++) {
		var f = list[i];
		if (f.error || f.is_mosaic !== true) {
			continue;
		}
		if (f.likely_unstitched || f.mosaic_stitch_status === "suspect") {
			continue;
		}
		var tiles = f.m_tile_count != null ? f.m_tile_count : f.has_m_dim ? "2+" : null;
		if (!tiles || tiles === 1) {
			continue;
		}
		var key = (f.basename || f.path || "file") + "|" + tiles;
		if (seen[key]) {
			continue;
		}
		seen[key] = true;
		out.push({
			basename: f.basename || "",
			message:
				"Mosaic with " +
				tiles +
				" tile index(es) in file structure (normal for ZEN-stitched exports).",
		});
	}
	return out;
}

function hasLikelyUnstitchedMosaic(files) {
	var list = files || [];
	for (var i = 0; i < list.length; i++) {
		if (list[i].likely_unstitched) {
			return true;
		}
	}
	return false;
}

function rebuildChannelsFromFiles(cziImport) {
	var files = cziImport.files || [];
	var channels = [];
	for (var i = 0; i < files.length; i++) {
		var file = files[i];
		if (file.error) {
			continue;
		}
		var chans = file.channels || [];
		for (var c = 0; c < chans.length; c++) {
			var ch = chans[c];
			channels.push({
				file: file.basename,
				index: ch.index,
				label: ch.label || "",
				role: ch.suggested_role || suggestRoleFromLabel(ch.label),
				other_name: "",
				keep: true,
			});
		}
	}
	var existingDefaults = cziImport.channel_defaults || {};
	var channelDefaults = {};
	for (var j = 0; j < channels.length; j++) {
		var key = String(channels[j].index);
		if (!existingDefaults[key] && !channelDefaults[key]) {
			channelDefaults[key] = {
				role: channels[j].role,
				other_name: "",
			};
		}
	}
	cziImport.channel_defaults = Object.assign({}, existingDefaults, channelDefaults);
	for (var k = 0; k < channels.length; k++) {
		var def = cziImport.channel_defaults[String(channels[k].index)];
		if (def) {
			channels[k].role = def.role;
			channels[k].other_name = def.other_name || "";
		}
	}
	cziImport.channels = channels;
	return cziImport;
}

function syncScenesFromSliceOrder(cziImport) {
	var order = cziImport.slice_order || [];
	if (!order.length) {
		return cziImport;
	}
	var byKey = {};
	for (var i = 0; i < order.length; i++) {
		var entry = order[i];
		byKey[String(entry.path) + "|" + String(entry.scene_index)] = entry.sliceId;
	}
	var files = cziImport.files || [];
	for (var f = 0; f < files.length; f++) {
		var file = files[f];
		var scenes = file.scenes || [];
		for (var s = 0; s < scenes.length; s++) {
			var sc = scenes[s];
			var key = String(file.path) + "|" + String(sc.index);
			if (byKey[key]) {
				sc.sliceId = byKey[key];
			}
		}
	}
	return cziImport;
}

function buildSliceOrder(cziImport, projectStem) {
	var entries = [];
	var files = cziImport.files || [];
	for (var f = 0; f < files.length; f++) {
		var file = files[f];
		if (file.error) {
			continue;
		}
		var scenes = file.scenes || [];
		for (var s = 0; s < scenes.length; s++) {
			var sc = scenes[s];
			var sceneCount = file.scene_count || scenes.length || 1;
			var originalSliceId =
				sc.originalSliceId ||
				sc.sliceId ||
				defaultSliceId(file.basename, sc.index, sceneCount);
			entries.push({
				path: file.path,
				basename: file.basename,
				scene_index: sc.index,
				source_dir: file.source_dir || cziImport.source_dir || "",
				scan_index: file.scan_index != null ? file.scan_index : 0,
				originalSliceId: originalSliceId,
				sliceId: originalSliceId,
			});
		}
	}
	entries.sort(naturalCompare);
	var numbering = cziImport.slice_numbering || SLICE_NUMBERING_PRESERVE;
	var stem = sanitizeSliceStem(projectStem || "project");
	for (var i = 0; i < entries.length; i++) {
		entries[i].ordinal = i + 1;
		if (numbering === SLICE_NUMBERING_RENAME) {
			entries[i].sliceId = stem + "_s" + formatOrdinalSuffix(entries[i].ordinal);
		} else {
			entries[i].sliceId = entries[i].originalSliceId;
		}
	}
	cziImport.slice_order = entries;
	syncScenesFromSliceOrder(cziImport);
	return entries;
}

function validateSliceOrder(cziImport) {
	var order = cziImport.slice_order || [];
	if (!order.length) {
		return "No scenes probed yet.";
	}
	var seen = {};
	for (var i = 0; i < order.length; i++) {
		var entry = order[i];
		var sliceId = String(entry.sliceId || "").trim();
		if (!sliceId) {
			return "Every scene needs a slice ID.";
		}
		if (!isValidSliceId(sliceId)) {
			return "Invalid slice ID: " + sliceId + " (use letters, numbers, _ and -).";
		}
		if (seen[sliceId]) {
			return "Duplicate slice ID: " + sliceId;
		}
		seen[sliceId] = true;
		entry.sliceId = sliceId;
	}
	syncScenesFromSliceOrder(cziImport);
	return "";
}

function mergeProbeDirIntoImport(cziImport, probeResult, sourceDir, scanIndex) {
	var incoming = (probeResult.files || []).map(function (f) {
		return normalizeProbeFileEntry(f, sourceDir, scanIndex);
	});
	var files = (cziImport.files || []).filter(function (f) {
		return f.source_dir !== sourceDir;
	});
	cziImport.files = files.concat(incoming);
	if (!cziImport.source_dirs) {
		cziImport.source_dirs = [];
	}
	if (cziImport.source_dirs.indexOf(sourceDir) < 0) {
		cziImport.source_dirs.push(sourceDir);
	}
	cziImport.source_dir = cziImport.source_dirs[0] || sourceDir || "";
	rebuildChannelsFromFiles(cziImport);
	return cziImport;
}

function collectKeptSignalRoleKeys(cziImport) {
	var channels = cziImport.channels || [];
	var seen = [];
	for (var i = 0; i < channels.length; i++) {
		var ch = channels[i];
		if (!isSignalChannel(ch)) {
			continue;
		}
		var key = roleKeyForChannel(ch);
		if (seen.indexOf(key) < 0) {
			seen.push(key);
		}
	}
	return seen;
}

function suggestRoleFromLabel(label) {
	var text = String(label || "");
	if (/dapi/i.test(text)) {
		return ROLE_DAPI;
	}
	if (/soma|rabies/i.test(text)) {
		return ROLE_SIGNAL_SOMATA;
	}
	if (/nucle/i.test(text)) {
		return ROLE_SIGNAL_NUCLEI;
	}
	if (/axon/i.test(text)) {
		return ROLE_SIGNAL_AXONS;
	}
	return ROLE_UNUSED;
}

function buildDefaultCziImport(sourceDir) {
	return {
		version: 1,
		source_dir: sourceDir || "",
		source_dirs: sourceDir ? [sourceDir] : [],
		slice_numbering: SLICE_NUMBERING_PRESERVE,
		slice_order: [],
		files: [],
		channels: [],
		channel_defaults: {},
		geometry: {},
		preview_scale: DEFAULT_PREVIEW_SCALE,
		primary_signal_role: ROLE_SIGNAL_SOMATA,
	};
}

function mergeProbeIntoImport(cziImport, probeResult) {
	var sourceDir = cziImport.source_dir || "";
	cziImport.files = [];
	cziImport.source_dirs = sourceDir ? [sourceDir] : [];
	return mergeProbeDirIntoImport(cziImport, probeResult, sourceDir, 0);
}

function importConfigPath(bundleRoot) {
	return path.join(bundleRoot, ".masonjar", "czi_import_config.json");
}

function maxRunRelForRole(roleKey, slug) {
	var branch = "";
	if (String(roleKey).indexOf("other:") === 0) {
		branch = roleKey.slice(6);
	} else {
		branch = branchForRole(roleKey);
	}
	if (!branch) {
		return "";
	}
	return branch + "/max/" + slug;
}

function countExtractWorkItems(cfg) {
	var channels = (cfg.channels || []).filter(function (ch) {
		return ch.keep && ch.role !== ROLE_UNUSED;
	});
	var filesByName = {};
	var files = cfg.files || [];
	for (var f = 0; f < files.length; f++) {
		var entry = files[f];
		filesByName[entry.basename] = entry;
		filesByName[path.basename(entry.path || "")] = entry;
	}
	var count = 0;
	for (var i = 0; i < channels.length; i++) {
		var ch = channels[i];
		if (ch.role === ROLE_OTHER && !sanitizeOtherName(ch.other_name)) {
			continue;
		}
		var fileKey = ch.file || "";
		var fileEntry =
			filesByName[fileKey] || filesByName[path.basename(fileKey)] || null;
		if (!fileEntry) {
			continue;
		}
		var scenes = fileEntry.scenes || [{ index: 0 }];
		count += scenes.length;
	}
	return count;
}

function collectSliceIds(cziImport) {
	var order = cziImport.slice_order || [];
	if (order.length) {
		return order.map(function (entry) {
			return entry.sliceId;
		}).filter(Boolean);
	}
	var ids = [];
	var files = cziImport.files || [];
	for (var i = 0; i < files.length; i++) {
		var scenes = files[i].scenes || [];
		for (var s = 0; s < scenes.length; s++) {
			if (scenes[s].sliceId && ids.indexOf(scenes[s].sliceId) < 0) {
				ids.push(scenes[s].sliceId);
			}
		}
	}
	ids.sort(function (a, b) {
		return naturalCompare({ sliceId: a }, { sliceId: b });
	});
	return ids;
}

function primaryMaxRunRel(cziImport, importResult) {
	var role =
		(importResult && importResult.primary_signal_role) ||
		cziImport.primary_signal_role ||
		ROLE_SIGNAL_SOMATA;
	var maxRuns = (importResult && importResult.max_runs) || cziImport.max_runs || {};
	return maxRuns[role] || "";
}

module.exports = {
	ROLE_DAPI: ROLE_DAPI,
	ROLE_SIGNAL_SOMATA: ROLE_SIGNAL_SOMATA,
	ROLE_SIGNAL_NUCLEI: ROLE_SIGNAL_NUCLEI,
	ROLE_SIGNAL_AXONS: ROLE_SIGNAL_AXONS,
	ROLE_OTHER: ROLE_OTHER,
	ROLE_UNUSED: ROLE_UNUSED,
	ROLE_TO_BRANCH: ROLE_TO_BRANCH,
	CHANNEL_ROLE_OPTIONS: CHANNEL_ROLE_OPTIONS,
	DEFAULT_PREVIEW_SCALE: DEFAULT_PREVIEW_SCALE,
	SLICE_NUMBERING_PRESERVE: SLICE_NUMBERING_PRESERVE,
	SLICE_NUMBERING_RENAME: SLICE_NUMBERING_RENAME,
	branchForRole: branchForRole,
	sanitizeOtherName: sanitizeOtherName,
	sanitizeSliceStem: sanitizeSliceStem,
	parseSectionSuffix: parseSectionSuffix,
	naturalCompare: naturalCompare,
	branchForChannel: branchForChannel,
	roleKeyForChannel: roleKeyForChannel,
	isSignalChannel: isSignalChannel,
	collectChannelIndices: collectChannelIndices,
	applyChannelDefaults: applyChannelDefaults,
	defaultSliceId: defaultSliceId,
	suggestRoleFromLabel: suggestRoleFromLabel,
	buildDefaultCziImport: buildDefaultCziImport,
	mergeProbeIntoImport: mergeProbeIntoImport,
	mergeProbeDirIntoImport: mergeProbeDirIntoImport,
	buildSliceOrder: buildSliceOrder,
	syncScenesFromSliceOrder: syncScenesFromSliceOrder,
	validateSliceOrder: validateSliceOrder,
	collectKeptSignalRoleKeys: collectKeptSignalRoleKeys,
	importConfigPath: importConfigPath,
	maxRunRelForRole: maxRunRelForRole,
	collectSliceIds: collectSliceIds,
	countExtractWorkItems: countExtractWorkItems,
	primaryMaxRunRel: primaryMaxRunRel,
	collectMosaicWarnings: collectMosaicWarnings,
	collectMosaicInfo: collectMosaicInfo,
	hasLikelyUnstitchedMosaic: hasLikelyUnstitchedMosaic,
};
