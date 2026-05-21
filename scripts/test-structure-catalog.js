"use strict";

var assert = require("assert");
var path = require("path");
var structureCatalog = require("../js/structure_catalog");

var appRoot = path.join(__dirname, "..");

function testFlattenAndLevels() {
	structureCatalog.resetCatalogForTests();
	var catalog = structureCatalog.loadCatalog(appRoot);
	assert.ok(catalog.nodes.length > 1000, "expected large flattened catalog");
	var levels = structureCatalog.listLevels(catalog);
	assert.ok(levels.length >= 5, "expected multiple CCF levels");
	var l6 = structureCatalog.listRegionsAtLevel(6, "", catalog);
	assert.ok(l6.length > 10, "level 6 should list areas");
	var visSearch = structureCatalog.listRegionsAtLevel(8, "visp", catalog);
	assert.ok(
		visSearch.some(function (n) {
			return n.acronym === "VISp";
		}),
		"search should find VISp",
	);
}

function testVisSiblingsShareGroupParent() {
	structureCatalog.resetCatalogForTests();
	var catalog = structureCatalog.loadCatalog(appRoot);
	var visp = catalog.byAcronym["VISp"];
	var visl = catalog.byAcronym["VISl"];
	assert.ok(visp && visl, "VISp and VISl should exist");
	assert.strictEqual(
		visp.groupParentId,
		visl.groupParentId,
		"VIS siblings should share group parent",
	);
	var ssp = catalog.byAcronym["SSp"];
	if (ssp) {
		assert.notStrictEqual(
			visp.groupParentId,
			ssp.groupParentId,
			"VIS and SS families should differ",
		);
	}
}

function testPresetVisRsp() {
	structureCatalog.resetCatalogForTests();
	var ids = structureCatalog.presetVisRspIds(structureCatalog.loadCatalog(appRoot));
	assert.ok(ids.length >= 10, "preset should include legacy VIS/RSP set");
}

function main() {
	testFlattenAndLevels();
	testVisSiblingsShareGroupParent();
	testPresetVisRsp();
	console.log("test-structure-catalog: ok");
}

main();
