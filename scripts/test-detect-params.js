#!/usr/bin/env node
"use strict";

var assert = require("assert");
var detectParams = require("../js/detect_params");

function box(overrides) {
	return Object.assign(
		{
			confidence: 0.8,
			area_px2: 400,
			eccentricity: 0.6,
			intensity_p90: 120,
		},
		overrides || {},
	);
}

var defaults = detectParams.DEFAULTS;

assert.strictEqual(
	detectParams.boxPassesFilters(box(), defaults),
	true,
	"defaults keep a typical box",
);
assert.strictEqual(
	detectParams.boxPassesFilters(box({ area_px2: 200 }), defaults),
	false,
	"area equal to the cutoff is dropped",
);
assert.strictEqual(
	detectParams.boxPassesFilters(box({ eccentricity: 0.2 }), defaults),
	false,
	"eccentricity equal to the cutoff is dropped",
);
assert.strictEqual(
	detectParams.boxPassesFilters(box({ eccentricity: null }), defaults),
	true,
	"unknown eccentricity is kept",
);
assert.strictEqual(
	detectParams.boxPassesFilters(
		box({ intensity_p90: 1 }),
		Object.assign({}, defaults, { intensity_min: 0 }),
	),
	true,
	"intensity 0 keeps every box",
);
assert.strictEqual(
	detectParams.boxPassesFilters(
		box({ intensity_p90: 10 }),
		Object.assign({}, defaults, { intensity_min: 40 }),
	),
	false,
);
assert.strictEqual(
	detectParams.boxPassesFilters(
		box({ intensity_p90: null }),
		Object.assign({}, defaults, { intensity_min: 40 }),
	),
	true,
	"unknown intensity is kept",
);
assert.strictEqual(
	detectParams.boxPassesFilters(box({ confidence: 0.5 }), defaults),
	true,
	"confidence equal to the cutoff is kept",
);

var line = detectParams.bannerLine("M528", "s061", {
	confidence: 0.5,
	area: 200,
	eccentricity: 0.2,
	intensity_min: 0,
});
assert.strictEqual(
	line,
	"M528\ts061\tconfidence=0.50\tarea=200\teccentricity=0.20\tintensity=0",
);

var store = detectParams.upsertSection(detectParams.emptyStore(), "M528_s061", {
	confidence: 0.4,
	area: 100,
	eccentricity: 0.3,
	intensity_min: 10,
});
store = detectParams.upsertSection(store, "M528_s061", {
	confidence: 0.55,
	area: 220,
	eccentricity: 0.25,
	intensity_min: 12,
});
assert.strictEqual(detectParams.sectionIds(store).length, 1);
assert.strictEqual(store.sections.M528_s061.confidence, 0.55);
assert.strictEqual(store.sections.M528_s061.area, 220);

store = detectParams.upsertSection(store, "M528_s062", {
	confidence: 0.45,
	area: 180,
	eccentricity: 0.15,
	intensity_min: 20,
});
store = detectParams.withAverages(store);
assert.strictEqual(store.averages.confidence, 0.5);
assert.strictEqual(store.averages.area, 200);
assert.strictEqual(store.averages.intensity_min, 16);

var avgLine = detectParams.bannerLine("M528", "user averages", store.averages);
assert.ok(avgLine.indexOf("user averages") < 0 || avgLine.indexOf("M528") === 0);
assert.ok(avgLine.indexOf("confidence=0.50") >= 0);

store = detectParams.removeSection(store, "M528_s062");
assert.deepStrictEqual(detectParams.sectionIds(store), ["M528_s061"]);
assert.strictEqual(store.averages.confidence, 0.55);
assert.strictEqual(store.averages.area, 220);

store = detectParams.removeSection(store, "M528_s061");
assert.strictEqual(detectParams.sectionIds(store).length, 0);
assert.strictEqual(store.averages, null);

store = detectParams.withAverages(
	detectParams.upsertSection(detectParams.emptyStore(), "M528_s001", defaults),
);
store = detectParams.clearAverages(store);
assert.ok(store.sections.M528_s001);
assert.strictEqual(store.averages, null);

var saved = detectParams.upsertSection(detectParams.emptyStore(), "M528_s001", {
	confidence: 0.4,
	area: 150,
	eccentricity: 0.3,
	intensity_min: 20,
});
saved = detectParams.withAverages(
	detectParams.upsertSection(saved, "M528_s002", {
		confidence: 0.6,
		area: 250,
		eccentricity: 0.1,
		intensity_min: 40,
	}),
);

function policy(mode, sectionId) {
	return detectParams.resolveDetectionPolicy({
		mode: mode,
		sectionId: sectionId,
		saved: saved,
		sliceIds: ["M528_s001", "M528_s002", "M528_s003"],
		defaults: defaults,
	});
}

var defaultsPolicy = policy("defaults");
assert.strictEqual(defaultsPolicy.mixed, false);
assert.strictEqual(defaultsPolicy.global.confidence, 0.5);

var sectionPolicy = policy("section", "M528_s001");
assert.strictEqual(sectionPolicy.global.area, 150);

var averagePolicy = policy("averages");
assert.strictEqual(averagePolicy.global.confidence, 0.5);
assert.strictEqual(averagePolicy.global.area, 200);

var perDefaults = policy("per_section_defaults");
assert.strictEqual(perDefaults.mixed, true);
assert.strictEqual(perDefaults.perSlice.M528_s001.area, 150);
assert.strictEqual(perDefaults.perSlice.M528_s003.confidence, defaults.confidence);
assert.strictEqual(perDefaults.perSlice.M528_s003.area, defaults.area);

var perAverage = policy("per_section_average");
assert.strictEqual(perAverage.perSlice.M528_s002.intensity_min, 40);
assert.strictEqual(perAverage.perSlice.M528_s003.area, averagePolicy.global.area);

var options = detectParams.policyOptions(saved, "M528");
var ids = options.map(function (opt) {
	return opt.id;
});
assert.ok(ids.indexOf("defaults") >= 0);
assert.ok(ids.indexOf("section:M528_s001") >= 0);
assert.ok(ids.indexOf("averages") >= 0);
assert.ok(ids.indexOf("per_section_defaults") >= 0);
assert.ok(ids.indexOf("per_section_average") >= 0);
assert.strictEqual(
	detectParams.completedTasksSummary(saved),
	"2 section(s) saved · averages saved",
);

var roundTrip = detectParams.readStore({
	settings: {
		detection_params: {
			sections: saved.sections,
			averages: saved.averages,
		},
	},
});
assert.strictEqual(roundTrip.sections.M528_s001.area, 150);
assert.strictEqual(roundTrip.averages.intensity_min, saved.averages.intensity_min);

var withSuggestion = detectParams.mergeIntensitySuggestions(saved, {
	M528_s001: { intensity_min: 99, reason: null },
	M528_s003: { intensity_min: 47, reason: null },
	M528_s004: { intensity_min: null, reason: "unimodal" },
});
assert.strictEqual(withSuggestion.sections.M528_s001.intensity_min, 20);
assert.strictEqual(withSuggestion.suggestions.M528_s003.intensity_min, 47);
assert.strictEqual(withSuggestion.suggestions.M528_s001.intensity_min, 99);
var mixed = detectParams.resolveDetectionPolicy({
	mode: "per_section_defaults",
	saved: withSuggestion,
	sliceIds: ["M528_s001", "M528_s003", "M528_s009"],
	defaults: defaults,
});
assert.strictEqual(mixed.perSlice.M528_s001.intensity_min, 20);
assert.strictEqual(mixed.perSlice.M528_s003.intensity_min, 47);
assert.strictEqual(mixed.perSlice.M528_s003.confidence, defaults.confidence);
assert.strictEqual(mixed.perSlice.M528_s009.intensity_min, 0);
var preset = detectParams.sliderPreset(withSuggestion, "M528_s003");
assert.strictEqual(preset.source, "suggestion");
assert.strictEqual(preset.params.intensity_min, 47);
assert.strictEqual(preset.params.area, defaults.area);
var savedPreset = detectParams.sliderPreset(withSuggestion, "M528_s001");
assert.strictEqual(savedPreset.source, "saved");
assert.strictEqual(savedPreset.params.intensity_min, 20);
var labels = detectParams.policyOptions(withSuggestion, "M528").map(function (opt) {
	return opt.label;
});
assert.ok(labels.join("\n").indexOf("suggested intensity") >= 0);
assert.ok(detectParams.suggestionStatusLine(withSuggestion).indexOf("2 section") >= 0);

var sectionHint = detectParams.sectionIntensityHint("M528_s003", {
	suggestions: withSuggestion.suggestions,
	scoutSections: { M528_s009: { intensity_min: null, reason: "unimodal", source: "scout" } },
	pooled: 61,
});
assert.strictEqual(sectionHint.intensity_min, 47);
assert.strictEqual(sectionHint.scope, "section");
var pooledHint = detectParams.sectionIntensityHint("M528_s010", {
	suggestions: {},
	scoutSections: {},
	pooled: 61,
});
assert.strictEqual(pooledHint.intensity_min, 61);
assert.strictEqual(pooledHint.scope, "brain");
var noSplit = detectParams.sectionIntensityHint("M528_s009", {
	suggestions: {},
	scoutSections: { M528_s009: { intensity_min: null, reason: "unimodal", source: "scout" } },
	pooled: 61,
});
assert.strictEqual(noSplit.intensity_min, null);
assert.strictEqual(noSplit.scope, "section");

console.log("test-detect-params.js ok");
