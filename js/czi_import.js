"use strict";

var crypto = require("crypto");
var fs = require("fs");
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
var PREVIEWS_REL = "data/counting/_previews";
var PREVIEW_FORMAT_VERSION = 4;

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
		bit_depth_by_role: {},
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

function originalScansPath(bundleRoot, channel, sliceId) {
	var branch = branchForChannel(channel);
	var base = path.join(bundleRoot, "data/original_scans");
	if (branch) {
		return path.join(base, branch, sliceId + ".tif");
	}
	return path.join(base, sliceId + ".tif");
}

function dapiPreviewPath(bundleRoot, sliceId) {
	return path.join(bundleRoot, "data/counting/00_dapi", sliceId + ".png");
}

function orientDapiPreviewPath(bundleRoot, sliceId) {
	return dapiPreviewPath(bundleRoot, sliceId);
}

function signalPreviewPath(bundleRoot, sliceId, channel) {
	var branch = branchForChannel(channel);
	var suffix = branch || roleKeyForChannel(channel);
	return path.join(bundleRoot, PREVIEWS_REL, sliceId + "_" + suffix + ".png");
}

function previewPathForChannel(bundleRoot, sliceId, channel) {
	if (!channel || !channel.keep || channel.role === ROLE_UNUSED) {
		return "";
	}
	if (channel.role === ROLE_DAPI) {
		return dapiPreviewPath(bundleRoot, sliceId);
	}
	if (branchForChannel(channel)) {
		return signalPreviewPath(bundleRoot, sliceId, channel);
	}
	return "";
}

function findKeptChannelForRoleKey(cziImport, roleKey) {
	var channels = cziImport.channels || [];
	for (var i = 0; i < channels.length; i++) {
		var ch = channels[i];
		if (!ch.keep || ch.role === ROLE_UNUSED) {
			continue;
		}
		if (roleKeyForChannel(ch) === roleKey) {
			return ch;
		}
	}
	return null;
}

function orientPreviewPathForChannel(bundleRoot, sliceId, channel) {
	if (!channel || !channel.keep || channel.role === ROLE_UNUSED) {
		return "";
	}
	if (channel.role === ROLE_DAPI) {
		return orientDapiPreviewPath(bundleRoot, sliceId);
	}
	if (branchForChannel(channel)) {
		return signalPreviewPath(bundleRoot, sliceId, channel);
	}
	return "";
}

function resolveOrientPreviewPath(bundleRoot, cziImport, importResult, sliceId) {
	if (!bundleRoot || !sliceId) {
		return "";
	}
	var primaryRole =
		(importResult && importResult.primary_signal_role) ||
		cziImport.primary_signal_role ||
		ROLE_SIGNAL_SOMATA;
	var primaryCh = findKeptChannelForRoleKey(cziImport, primaryRole);
	if (primaryCh) {
		var primaryPrev = signalPreviewPath(bundleRoot, sliceId, primaryCh);
		if (fs.existsSync(primaryPrev)) {
			return primaryPrev;
		}
		var legacyPrimaryPrev = path.join(
			bundleRoot,
			PREVIEWS_REL,
			sliceId + "_" + (branchForChannel(primaryCh) || roleKeyForChannel(primaryCh)) + ".tif",
		);
		if (fs.existsSync(legacyPrimaryPrev)) {
			return legacyPrimaryPrev;
		}
	}
	var dapi = dapiPreviewPath(bundleRoot, sliceId);
	if (fs.existsSync(dapi)) {
		return dapi;
	}
	var legacyDapiTif = path.join(bundleRoot, "data/counting/00_dapi", sliceId + ".tif");
	if (fs.existsSync(legacyDapiTif)) {
		return legacyDapiTif;
	}
	var prevDir = path.join(bundleRoot, PREVIEWS_REL);
	if (fs.existsSync(prevDir)) {
		var prefix = sliceId + "_";
		var entries = fs.readdirSync(prevDir);
		for (var i = 0; i < entries.length; i++) {
			if (entries[i].indexOf(prefix) === 0 && entries[i].toLowerCase().endsWith(".png")) {
				return path.join(prevDir, entries[i]);
			}
		}
		for (var j = 0; j < entries.length; j++) {
			if (entries[j].indexOf(prefix) === 0 && entries[j].toLowerCase().endsWith(".tif")) {
				return path.join(prevDir, entries[j]);
			}
		}
	}
	return "";
}

function normalizeSourceDirs(cziImport) {
	var dirs = (cziImport.source_dirs || []).slice();
	if (!dirs.length && cziImport.source_dir) {
		dirs = [cziImport.source_dir];
	}
	return dirs
		.map(function (d) {
			try {
				return path.resolve(String(d || ""));
			} catch (e) {
				return String(d || "");
			}
		})
		.sort();
}

function fingerprintPayload(cziImport) {
	var keptChannels = (cziImport.channels || [])
		.filter(function (ch) {
			return ch.keep;
		})
		.map(function (ch) {
			return {
				file: ch.file || "",
				index: ch.index,
				role: ch.role,
				other_name: ch.other_name || "",
				keep: true,
			};
		})
		.sort(function (a, b) {
			var fa = String(a.file);
			var fb = String(b.file);
			if (fa < fb) {
				return -1;
			}
			if (fa > fb) {
				return 1;
			}
			return a.index - b.index;
		});
	var sliceOrder = (cziImport.slice_order || []).map(function (entry) {
		return {
			ordinal: entry.ordinal,
			sliceId: entry.sliceId,
			path: entry.path || "",
			scene_index: entry.scene_index,
			basename: entry.basename || "",
		};
	});
	return {
		source_dirs: normalizeSourceDirs(cziImport),
		slice_numbering: cziImport.slice_numbering || SLICE_NUMBERING_PRESERVE,
		slice_order: sliceOrder,
		channels: keptChannels,
		primary_signal_role: cziImport.primary_signal_role || ROLE_SIGNAL_SOMATA,
		preview_scale: cziImport.preview_scale != null ? cziImport.preview_scale : DEFAULT_PREVIEW_SCALE,
	};
}

function cziImportFingerprint(cziImport) {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(fingerprintPayload(cziImport)))
		.digest("hex");
}

function importStatePath(bundleRoot) {
	var mason = path.join(bundleRoot, ".masonjar", "czi_import_state.json");
	if (fs.existsSync(mason)) {
		return mason;
	}
	var legacy = path.join(bundleRoot, ".belljar", "czi_import_state.json");
	if (fs.existsSync(legacy)) {
		return legacy;
	}
	return mason;
}

function readImportState(bundleRoot) {
	var statePath = importStatePath(bundleRoot);
	if (!fs.existsSync(statePath)) {
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(statePath, "utf8"));
	} catch (e) {
		return null;
	}
}

function scenesForFileEntry(fileEntry, cziImport) {
	if (!fileEntry) {
		return [];
	}
	var order = cziImport.slice_order || [];
	var filePath = String(fileEntry.path || "");
	var basename = fileEntry.basename || "";
	var fromOrder = [];
	for (var i = 0; i < order.length; i++) {
		var entry = order[i];
		if (filePath && entry.path && String(entry.path) !== filePath) {
			continue;
		}
		if (basename && entry.basename && entry.basename !== basename) {
			continue;
		}
		fromOrder.push({
			sliceId: entry.sliceId,
			scene_index: entry.scene_index,
		});
	}
	if (fromOrder.length) {
		return fromOrder;
	}
	var scenes = fileEntry.scenes || [];
	return scenes.map(function (sc) {
		return {
			sliceId: sc.sliceId,
			scene_index: sc.index,
		};
	});
}

function iterKeptChannelScenes(cziImport) {
	var filesByName = {};
	var files = cziImport.files || [];
	for (var f = 0; f < files.length; f++) {
		var entry = files[f];
		filesByName[entry.basename] = entry;
		filesByName[path.basename(entry.path || "")] = entry;
	}
	var channels = (cziImport.channels || []).filter(function (ch) {
		return ch.keep && ch.role !== ROLE_UNUSED;
	});
	var items = [];
	for (var c = 0; c < channels.length; c++) {
		var ch = channels[c];
		if (ch.role === ROLE_OTHER && !sanitizeOtherName(ch.other_name)) {
			continue;
		}
		var fileKey = ch.file || "";
		var fileRef =
			filesByName[fileKey] || filesByName[path.basename(fileKey)] || null;
		var scenes = scenesForFileEntry(fileRef, cziImport);
		for (var si = 0; si < scenes.length; si++) {
			var scene = scenes[si];
			if (!scene.sliceId) {
				continue;
			}
			items.push({
				slice_id: scene.sliceId,
				scene_index: scene.scene_index != null ? scene.scene_index : 0,
				channel_index: ch.index,
				channel: ch,
				role_key: roleKeyForChannel(ch),
				file: fileRef ? fileRef.basename : ch.file,
				czi_path: fileRef ? fileRef.path : "",
			});
		}
	}
	return items;
}

function isPreviewFileValid(previewPath, previewFormatVersion) {
	if (previewFormatVersion == null || previewFormatVersion < PREVIEW_FORMAT_VERSION) {
		return false;
	}
	if (!previewPath || !fs.existsSync(previewPath)) {
		return false;
	}
	if (previewFormatVersion >= PREVIEW_FORMAT_VERSION && !previewPath.toLowerCase().endsWith(".png")) {
		return false;
	}
	try {
		return fs.statSync(previewPath).size > 0;
	} catch (e) {
		return false;
	}
}

function findLowResTiffIssues(bundleRoot) {
	var issues = [];
	var dapiDir = path.join(bundleRoot, "data/counting/00_dapi");
	if (fs.existsSync(dapiDir)) {
		var dapiEntries = fs.readdirSync(dapiDir);
		for (var d = 0; d < dapiEntries.length; d++) {
			var dname = dapiEntries[d];
			var lower = dname.toLowerCase();
			if (lower.endsWith(".tif") || lower.endsWith(".tiff")) {
				issues.push({
					kind: "dapi_tif",
					path: path.join(dapiDir, dname),
					slice_id: path.basename(dname, path.extname(dname)),
				});
			}
		}
	}
	var prevDir = path.join(bundleRoot, PREVIEWS_REL);
	if (fs.existsSync(prevDir)) {
		var prevEntries = fs.readdirSync(prevDir);
		for (var p = 0; p < prevEntries.length; p++) {
			var pname = prevEntries[p];
			var plower = pname.toLowerCase();
			if (plower.endsWith(".tif") || plower.endsWith(".tiff")) {
				issues.push({
					kind: "preview_tif",
					path: path.join(prevDir, pname),
				});
			}
		}
		for (var r = 0; r < prevEntries.length; r++) {
			var rname = prevEntries[r];
			if (!/_dapi\.png$/i.test(rname)) {
				continue;
			}
			var sid = rname.replace(/_dapi\.png$/i, "");
			var canonical = dapiPreviewPath(bundleRoot, sid);
			if (fs.existsSync(canonical)) {
				issues.push({
					kind: "redundant_dapi_preview",
					path: path.join(prevDir, rname),
					slice_id: sid,
				});
			}
		}
	}
	return issues;
}

function auditCziImportCompletion(bundleRoot, cziImport, options) {
	options = options || {};
	var importResult = options.importResult || null;
	var state = readImportState(bundleRoot);
	var previewFormatVersion =
		(state && state.preview_format_version) ||
		(cziImport && cziImport.preview_format_version) ||
		0;
	var extractComplete =
		!!state &&
		state.phase === "complete" &&
		Number(state.done) === Number(state.total) &&
		state.total > 0;
	var missingZstacks = [];
	var invalidPreviews = [];
	var missingMaxRuns = [];
	var lowResTiffIssues = findLowResTiffIssues(bundleRoot);
	var workItems = iterKeptChannelScenes(cziImport);

	for (var i = 0; i < workItems.length; i++) {
		var item = workItems[i];
		var zPath = originalScansPath(bundleRoot, item.channel, item.slice_id);
		if (!fs.existsSync(zPath)) {
			missingZstacks.push({
				slice_id: item.slice_id,
				path: zPath,
				role_key: item.role_key,
			});
		}
		var prevPath = orientPreviewPathForChannel(bundleRoot, item.slice_id, item.channel);
		if (prevPath && !isPreviewFileValid(prevPath, previewFormatVersion)) {
			invalidPreviews.push({
				slice_id: item.slice_id,
				channel_index: item.channel_index,
				role_key: item.role_key,
				file: item.file,
				scene_index: item.scene_index,
				czi_path: item.czi_path,
				preview_path: prevPath,
			});
		}
	}

	var maxRuns = (importResult && importResult.max_runs) || cziImport.max_runs || {};
	var signalKeys = collectKeptSignalRoleKeys(cziImport);
	var sliceIds = collectSliceIds(cziImport);
	for (var r = 0; r < signalKeys.length; r++) {
		var roleKey = signalKeys[r];
		var rel = maxRuns[roleKey] || maxRunRelForRole(roleKey, sliceIds[0] || "run");
		if (!rel) {
			missingMaxRuns.push({ role_key: roleKey, reason: "no max run registered" });
			continue;
		}
		var maxDir = path.join(bundleRoot, "data/counting/03_max", rel);
		if (!fs.existsSync(maxDir)) {
			missingMaxRuns.push({ role_key: roleKey, path: maxDir });
			continue;
		}
		var missingSlice = false;
		for (var s = 0; s < sliceIds.length; s++) {
			var maxTif = path.join(maxDir, sliceIds[s] + ".tif");
			if (!fs.existsSync(maxTif)) {
				missingSlice = true;
				break;
			}
		}
		if (missingSlice) {
			missingMaxRuns.push({ role_key: roleKey, path: maxDir, reason: "missing slice tifs" });
		}
	}

	var canSkipToOrient =
		extractComplete &&
		missingZstacks.length === 0 &&
		invalidPreviews.length === 0 &&
		missingMaxRuns.length === 0 &&
		lowResTiffIssues.length === 0;
	var needsPreviewRepair =
		(extractComplete && missingZstacks.length === 0 && invalidPreviews.length > 0) ||
		(extractComplete && lowResTiffIssues.length > 0);

	return {
		extractComplete: extractComplete,
		missingZstacks: missingZstacks,
		invalidPreviews: invalidPreviews,
		missingMaxRuns: missingMaxRuns,
		lowResTiffIssues: lowResTiffIssues,
		canSkipToOrient: canSkipToOrient,
		needsPreviewRepair: needsPreviewRepair,
		previewFormatVersion: previewFormatVersion,
		importState: state,
	};
}

function buildRepairTargetsFromAudit(audit) {
	return (audit.invalidPreviews || []).map(function (item) {
		return {
			slice_id: item.slice_id,
			channel_index: item.channel_index,
			role_key: item.role_key,
			file: item.file,
			scene_index: item.scene_index,
			czi_path: item.czi_path,
		};
	});
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
	PREVIEWS_REL: PREVIEWS_REL,
	PREVIEW_FORMAT_VERSION: PREVIEW_FORMAT_VERSION,
	originalScansPath: originalScansPath,
	dapiPreviewPath: dapiPreviewPath,
	orientDapiPreviewPath: orientDapiPreviewPath,
	signalPreviewPath: signalPreviewPath,
	previewPathForChannel: previewPathForChannel,
	orientPreviewPathForChannel: orientPreviewPathForChannel,
	resolveOrientPreviewPath: resolveOrientPreviewPath,
	cziImportFingerprint: cziImportFingerprint,
	importStatePath: importStatePath,
	readImportState: readImportState,
	findLowResTiffIssues: findLowResTiffIssues,
	auditCziImportCompletion: auditCziImportCompletion,
	buildRepairTargetsFromAudit: buildRepairTargetsFromAudit,
	iterKeptChannelScenes: iterKeptChannelScenes,
};
