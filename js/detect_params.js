"use strict";

/**
 * Detection parameterization: slider defaults, live box filters, saved-section
 * banner lines, and the policy used by Save and run.
 */

var DEFAULTS = {
	confidence: 0.5,
	area: 200,
	eccentricity: 0.2,
	intensity_min: 0,
};

var RAW_CONFIDENCE_FLOOR = 0.05;
var DEFAULT_TILE = 640;
var AREA_SLIDER_FLOOR = 2000;

function normalizeParams(params) {
	params = params || {};
	var confidence = Number(params.confidence);
	var area = Number(params.area);
	var eccentricity = Number(params.eccentricity);
	var intensity =
		params.intensity_min != null
			? Number(params.intensity_min)
			: Number(params.intensityMin);
	if (!isFinite(confidence)) {
		confidence = DEFAULTS.confidence;
	}
	if (!isFinite(area)) {
		area = DEFAULTS.area;
	}
	if (!isFinite(eccentricity)) {
		eccentricity = DEFAULTS.eccentricity;
	}
	if (!isFinite(intensity)) {
		intensity = 0;
	}
	return {
		confidence: confidence,
		area: area,
		eccentricity: eccentricity,
		intensity_min: intensity,
	};
}

function formatParamValue(key, value) {
	var n = Number(value);
	if (!isFinite(n)) {
		n = 0;
	}
	if (key === "confidence" || key === "eccentricity") {
		return n.toFixed(2);
	}
	return String(Math.round(n));
}

function sectionToken(sliceId) {
	var m = String(sliceId || "").match(/_s(\d+)/i);
	return m ? "s" + m[1] : String(sliceId || "");
}

function bannerLine(projectName, sectionLabel, params) {
	var p = normalizeParams(params);
	return [
		String(projectName || ""),
		String(sectionLabel || ""),
		"confidence=" + formatParamValue("confidence", p.confidence),
		"area=" + formatParamValue("area", p.area),
		"eccentricity=" + formatParamValue("eccentricity", p.eccentricity),
		"intensity=" + formatParamValue("intensity_min", p.intensity_min),
	].join("\t");
}

function boxPassesFilters(box, params) {
	var p = normalizeParams(params);
	box = box || {};
	var confidence = Number(box.confidence);
	if (!(confidence >= p.confidence)) {
		return false;
	}
	var area = Number(box.area_px2);
	if (!(area > p.area)) {
		return false;
	}
	if (box.eccentricity != null && box.eccentricity !== "") {
		var ecc = Number(box.eccentricity);
		if (isFinite(ecc) && !(ecc > p.eccentricity)) {
			return false;
		}
	}
	if (p.intensity_min > 0 && box.intensity_p90 != null && box.intensity_p90 !== "") {
		var inten = Number(box.intensity_p90);
		if (isFinite(inten) && inten < p.intensity_min) {
			return false;
		}
	}
	return true;
}

function filterBoxes(boxes, params) {
	var out = [];
	var list = boxes || [];
	for (var i = 0; i < list.length; i++) {
		if (boxPassesFilters(list[i], params)) {
			out.push(list[i]);
		}
	}
	return out;
}

function emptyStore() {
	return { sections: {}, averages: null, suggestions: {} };
}

function normalizeSuggestion(row) {
	if (!row || typeof row !== "object") {
		return { intensity_min: null, reason: null };
	}
	var intensity = row.intensity_min != null ? Number(row.intensity_min) : null;
	if (intensity != null && (!isFinite(intensity) || intensity <= 0)) {
		intensity = null;
	}
	if (intensity != null) {
		intensity = Math.round(intensity);
	}
	return {
		intensity_min: intensity,
		reason: row.reason ? String(row.reason) : null,
	};
}

function normalizeSuggestions(raw) {
	var out = {};
	var src = raw && typeof raw === "object" ? raw : {};
	var keys = Object.keys(src);
	for (var i = 0; i < keys.length; i++) {
		out[keys[i]] = normalizeSuggestion(src[keys[i]]);
	}
	return out;
}

function readStore(projectData) {
	var settings = projectData && projectData.settings;
	var raw = settings && settings.detection_params;
	if (!raw || typeof raw !== "object") {
		return emptyStore();
	}
	var sections = {};
	var src = raw.sections && typeof raw.sections === "object" ? raw.sections : {};
	var keys = Object.keys(src);
	for (var i = 0; i < keys.length; i++) {
		sections[keys[i]] = normalizeParams(src[keys[i]]);
	}
	return {
		sections: sections,
		averages: raw.averages ? normalizeParams(raw.averages) : null,
		suggestions: normalizeSuggestions(raw.suggestions),
	};
}

function sectionIds(store) {
	return Object.keys((store && store.sections) || {}).sort();
}

function averageParams(sections) {
	var ids = Object.keys(sections || {});
	if (!ids.length) {
		return null;
	}
	var sums = { confidence: 0, area: 0, eccentricity: 0, intensity_min: 0 };
	for (var i = 0; i < ids.length; i++) {
		var p = normalizeParams(sections[ids[i]]);
		sums.confidence += p.confidence;
		sums.area += p.area;
		sums.eccentricity += p.eccentricity;
		sums.intensity_min += p.intensity_min;
	}
	var n = ids.length;
	return {
		confidence: Math.round((sums.confidence / n) * 100) / 100,
		area: Math.round(sums.area / n),
		eccentricity: Math.round((sums.eccentricity / n) * 100) / 100,
		intensity_min: Math.round(sums.intensity_min / n),
	};
}

function cloneStore(store) {
	var src = store || emptyStore();
	return {
		sections: JSON.parse(JSON.stringify(src.sections || {})),
		averages: src.averages ? normalizeParams(src.averages) : null,
		suggestions: normalizeSuggestions(src.suggestions),
	};
}

function suggestionCount(store) {
	var sug = (store && store.suggestions) || {};
	var keys = Object.keys(sug);
	var n = 0;
	for (var i = 0; i < keys.length; i++) {
		if (sug[keys[i]] && Number(sug[keys[i]].intensity_min) > 0) {
			n += 1;
		}
	}
	return n;
}

function sectionIntensityHint(sliceId, sources) {
	sources = sources || {};
	var id = String(sliceId || "");
	var suggestions = sources.suggestions || {};
	var scoutSections = sources.scoutSections || {};
	var saved = id && suggestions[id];
	if (saved && Number(saved.intensity_min) > 0) {
		return {
			intensity_min: Math.round(Number(saved.intensity_min)),
			scope: "section",
			source: "saved",
			reason: null,
		};
	}
	if (id && Object.prototype.hasOwnProperty.call(scoutSections, id)) {
		var row = scoutSections[id] || {};
		var cutoff = Number(row.intensity_min);
		if (cutoff > 0) {
			return {
				intensity_min: Math.round(cutoff),
				scope: "section",
				source: row.source || "scout",
				reason: null,
			};
		}
		return {
			intensity_min: null,
			scope: "section",
			source: row.source || "scout",
			reason: row.reason || "unimodal",
		};
	}
	if (Number(sources.pooled) > 0) {
		return {
			intensity_min: Math.round(Number(sources.pooled)),
			scope: "brain",
			source: "pooled",
			reason: null,
		};
	}
	return { intensity_min: null, scope: null, source: null, reason: null };
}

function suggestionStatusLine(store) {
	var n = suggestionCount(store);
	if (!n) {
		return "";
	}
	return (
		"Intensity suggested for " +
		n +
		" section(s). " +
		sectionIds(store).length +
		" section(s) saved by you."
	);
}

function sliderPreset(store, sliceId) {
	var saved = store || emptyStore();
	var id = String(sliceId || "");
	if (id && saved.sections[id]) {
		return { params: normalizeParams(saved.sections[id]), source: "saved" };
	}
	var params = normalizeParams(DEFAULTS);
	var sug = id && saved.suggestions ? saved.suggestions[id] : null;
	if (sug && Number(sug.intensity_min) > 0) {
		params.intensity_min = Math.round(Number(sug.intensity_min));
		return { params: params, source: "suggestion" };
	}
	return { params: params, source: "defaults" };
}

function mergeIntensitySuggestions(store, perSlice) {
	var next = cloneStore(store);
	var src = perSlice && typeof perSlice === "object" ? perSlice : {};
	var keys = Object.keys(src);
	for (var i = 0; i < keys.length; i++) {
		var row = src[keys[i]] || {};
		next.suggestions[String(keys[i])] = normalizeSuggestion({
			intensity_min: row.intensity_min,
			reason: row.reason || (Number(row.intensity_min) > 0 ? null : row.reason || "unimodal"),
		});
	}
	return next;
}

function upsertSection(store, sliceId, params) {
	var next = cloneStore(store);
	next.sections[String(sliceId)] = normalizeParams(params);
	return next;
}

function removeSection(store, sliceId) {
	var next = cloneStore(store);
	delete next.sections[String(sliceId)];
	if (!sectionIds(next).length) {
		next.averages = null;
	} else if (next.averages) {
		next.averages = averageParams(next.sections);
	}
	return next;
}

function clearAverages(store) {
	var next = cloneStore(store);
	next.averages = null;
	return next;
}

function withAverages(store) {
	var next = cloneStore(store);
	if (!sectionIds(next).length) {
		next.averages = null;
		return next;
	}
	next.averages = averageParams(next.sections);
	return next;
}

function paramsEqual(a, b) {
	var left = normalizeParams(a);
	var right = normalizeParams(b);
	return (
		left.confidence === right.confidence &&
		left.area === right.area &&
		left.eccentricity === right.eccentricity &&
		left.intensity_min === right.intensity_min
	);
}

/**
 * @returns {{mixed: boolean, global: object|null, perSlice: object|null, fallback: object|null, error?: string}}
 */
function resolveDetectionPolicy(options) {
	options = options || {};
	var mode = String(options.mode || "defaults");
	var saved = options.saved || emptyStore();
	var defaults = normalizeParams(options.defaults || DEFAULTS);
	var sliceIds = options.sliceIds || [];
	var sectionId = String(options.sectionId || "");

	if (mode === "defaults") {
		return { mixed: false, global: defaults, perSlice: null, fallback: defaults };
	}
	if (mode === "section") {
		var row = saved.sections[sectionId];
		if (!row) {
			return {
				mixed: false,
				global: null,
				perSlice: null,
				fallback: null,
				error: "No saved parameters for that section.",
			};
		}
		return {
			mixed: false,
			global: normalizeParams(row),
			perSlice: null,
			fallback: normalizeParams(row),
		};
	}
	if (mode === "averages") {
		if (!saved.averages) {
			return {
				mixed: false,
				global: null,
				perSlice: null,
				fallback: null,
				error: "Calculate averages of saved parameters first.",
			};
		}
		return {
			mixed: false,
			global: normalizeParams(saved.averages),
			perSlice: null,
			fallback: normalizeParams(saved.averages),
		};
	}
	if (mode === "per_section_defaults" || mode === "per_section_average") {
		var fill = mode === "per_section_average" ? saved.averages : defaults;
		if (!fill) {
			return {
				mixed: false,
				global: null,
				perSlice: null,
				fallback: null,
				error: "Calculate averages of saved parameters first.",
			};
		}
		fill = normalizeParams(fill);
		var per = {};
		for (var i = 0; i < sliceIds.length; i++) {
			var id = sliceIds[i];
			if (saved.sections[id]) {
				per[id] = normalizeParams(saved.sections[id]);
				continue;
			}
			var row = normalizeParams(fill);
			if (mode === "per_section_defaults") {
				var sug = saved.suggestions && saved.suggestions[id];
				if (sug && Number(sug.intensity_min) > 0) {
					row.intensity_min = Math.round(Number(sug.intensity_min));
				}
			}
			per[id] = row;
		}
		return { mixed: true, global: null, perSlice: per, fallback: fill };
	}
	return {
		mixed: false,
		global: null,
		perSlice: null,
		fallback: null,
		error: "Unknown detection parameter policy.",
	};
}

function policyOptions(store, projectName) {
	var saved = store || emptyStore();
	var opts = [{ id: "defaults", label: "Use defaults for all" }];
	var ids = sectionIds(saved);
	for (var i = 0; i < ids.length; i++) {
		opts.push({
			id: "section:" + ids[i],
			label: bannerLine(projectName, sectionToken(ids[i]), saved.sections[ids[i]]),
		});
	}
	if (saved.averages) {
		opts.push({
			id: "averages",
			label: bannerLine(projectName, "user averages", saved.averages),
		});
	}
	if (ids.length || suggestionCount(saved) > 0) {
		var perLabel = "User defined per section + defaults where missing";
		if (suggestionCount(saved) > 0) {
			perLabel += " (suggested intensity)";
		}
		opts.push({
			id: "per_section_defaults",
			label: perLabel,
		});
	}
	if (ids.length && saved.averages) {
		opts.push({
			id: "per_section_average",
			label: "User defined per section + average where missing",
		});
	}
	return opts;
}

function parsePolicyId(policyId) {
	var id = String(policyId || "defaults");
	if (id.indexOf("section:") === 0) {
		return { mode: "section", sectionId: id.slice("section:".length) };
	}
	return { mode: id, sectionId: "" };
}

function completedTasksSummary(store) {
	var ids = sectionIds(store);
	if (!ids.length) {
		return "";
	}
	var text = ids.length + " section(s) saved";
	if (store && store.averages) {
		text += " · averages saved";
	}
	return text;
}

function areaSliderMax(boxes) {
	var maxArea = AREA_SLIDER_FLOOR;
	var list = boxes || [];
	for (var i = 0; i < list.length; i++) {
		var area = Number(list[i] && list[i].area_px2);
		if (isFinite(area) && area > maxArea) {
			maxArea = area;
		}
	}
	return Math.ceil(maxArea);
}

module.exports = {
	DEFAULTS: DEFAULTS,
	RAW_CONFIDENCE_FLOOR: RAW_CONFIDENCE_FLOOR,
	DEFAULT_TILE: DEFAULT_TILE,
	AREA_SLIDER_FLOOR: AREA_SLIDER_FLOOR,
	normalizeParams: normalizeParams,
	formatParamValue: formatParamValue,
	sectionToken: sectionToken,
	bannerLine: bannerLine,
	boxPassesFilters: boxPassesFilters,
	filterBoxes: filterBoxes,
	emptyStore: emptyStore,
	readStore: readStore,
	sectionIds: sectionIds,
	averageParams: averageParams,
	upsertSection: upsertSection,
	removeSection: removeSection,
	clearAverages: clearAverages,
	withAverages: withAverages,
	paramsEqual: paramsEqual,
	resolveDetectionPolicy: resolveDetectionPolicy,
	policyOptions: policyOptions,
	parsePolicyId: parsePolicyId,
	completedTasksSummary: completedTasksSummary,
	areaSliderMax: areaSliderMax,
	suggestionCount: suggestionCount,
	suggestionStatusLine: suggestionStatusLine,
	sectionIntensityHint: sectionIntensityHint,
	sliderPreset: sliderPreset,
	mergeIntensitySuggestions: mergeIntensitySuggestions,
};
