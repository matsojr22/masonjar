"use strict";

var fs = require("fs");
var path = require("path");
var atlasStyle = require("./atlas_region_style");

var VIS_RSP_PRESET_ACRONYMS = [
	"VISa",
	"VISal",
	"VISam",
	"VISp",
	"VISl",
	"VISli",
	"VISpl",
	"VISpm",
	"VISpor",
	"VISrl",
	"RSPagl",
	"RSPd",
	"RSPv",
];

var _catalog = null;

function graphPath(appRoot) {
	return path.join(appRoot || path.join(__dirname, ".."), "csv", "structure_graph.json");
}

function flattenGraph(graph, idPath, nodes, byId, byAcronym) {
	var currentPath = idPath.concat([graph.id]);
	var node = {
		id: graph.id,
		acronym: graph.acronym,
		name: graph.name,
		st_level: graph.st_level,
		colorHex: atlasStyle.normalizeHex(graph.color_hex_triplet),
		idPath: currentPath,
		id_path: currentPath.join("/"),
		groupParentId: graph.id,
		groupParentAcronym: graph.acronym,
		groupParentName: graph.name,
		color_hex_triplet: graph.color_hex_triplet,
	};
	nodes.push(node);
	byId[graph.id] = node;
	if (graph.acronym && !byAcronym[graph.acronym]) {
		byAcronym[graph.acronym] = node;
	}
	if (graph.children && graph.children.length) {
		for (var i = 0; i < graph.children.length; i++) {
			flattenGraph(graph.children[i], currentPath, nodes, byId, byAcronym);
		}
	}
}

function loadCatalog(appRoot) {
	if (_catalog) {
		return _catalog;
	}
	var raw = fs.readFileSync(graphPath(appRoot), "utf8");
	var root = JSON.parse(raw);
	var nodes = [];
	var byId = {};
	var byAcronym = {};
	flattenGraph(root, [], nodes, byId, byAcronym);
	// Second pass: group parents need full ancestor chain in byId
	for (var i = 0; i < nodes.length; i++) {
		var n = nodes[i];
		var groupNode = atlasStyle.groupParentForRegion(n, byId);
		n.groupParentId = groupNode ? groupNode.id : n.id;
		n.groupParentAcronym = groupNode ? groupNode.acronym : n.acronym;
		n.groupParentName = groupNode ? groupNode.name : n.name;
	}
	var levels = {};
	for (var k = 0; k < nodes.length; k++) {
		var lvl = nodes[k].st_level;
		if (!levels[lvl]) {
			levels[lvl] = nodes[k];
		}
	}
	_catalog = { nodes: nodes, byId: byId, byAcronym: byAcronym, levels: levels };
	return _catalog;
}

function resetCatalogForTests() {
	_catalog = null;
}

function listLevels(catalog) {
	catalog = catalog || loadCatalog();
	var seen = {};
	var out = [];
	for (var i = 0; i < catalog.nodes.length; i++) {
		var lvl = catalog.nodes[i].st_level;
		if (seen[lvl]) {
			continue;
		}
		seen[lvl] = true;
		var example = catalog.levels[lvl];
		out.push({
			level: lvl,
			exampleAcronym: example.acronym,
			exampleName: example.name,
		});
	}
	out.sort(function (a, b) {
		return a.level - b.level;
	});
	return out;
}

function listRegionsAtLevel(level, searchQuery, catalog) {
	catalog = catalog || loadCatalog();
	var q = (searchQuery || "").trim().toLowerCase();
	var out = [];
	for (var i = 0; i < catalog.nodes.length; i++) {
		var n = catalog.nodes[i];
		if (n.st_level !== level) {
			continue;
		}
		if (q) {
			var hay =
				(n.acronym + " " + n.name + " " + n.groupParentAcronym).toLowerCase();
			if (hay.indexOf(q) < 0) {
				continue;
			}
		}
		out.push(n);
	}
	out.sort(function (a, b) {
		return a.acronym.localeCompare(b.acronym);
	});
	return out;
}

function isLayerStructure(node) {
	if (!node) {
		return false;
	}
	return String(node.name || "").toLowerCase().indexOf("layer") >= 0;
}

function presetVisRspIds(catalog) {
	catalog = catalog || loadCatalog();
	var ids = [];
	for (var i = 0; i < VIS_RSP_PRESET_ACRONYMS.length; i++) {
		var ac = VIS_RSP_PRESET_ACRONYMS[i];
		var node = catalog.byAcronym[ac];
		if (node) {
			ids.push(node.id);
		}
	}
	return ids;
}

function groupParentFor(id, catalog) {
	catalog = catalog || loadCatalog();
	var node = catalog.byId[id];
	if (!node) {
		return null;
	}
	return catalog.byId[node.groupParentId] || null;
}

function colorForRegion(id, catalog) {
	catalog = catalog || loadCatalog();
	var group = groupParentFor(id, catalog);
	if (group) {
		return atlasStyle.colorHexForGroup(group);
	}
	var node = catalog.byId[id];
	return node ? atlasStyle.colorHexForGroup(node) : "#808080";
}

function getRegion(id, catalog) {
	catalog = catalog || loadCatalog();
	return catalog.byId[id] || null;
}

module.exports = {
	loadCatalog: loadCatalog,
	resetCatalogForTests: resetCatalogForTests,
	listLevels: listLevels,
	listRegionsAtLevel: listRegionsAtLevel,
	isLayerStructure: isLayerStructure,
	presetVisRspIds: presetVisRspIds,
	groupParentFor: groupParentFor,
	colorForRegion: colorForRegion,
	getRegion: getRegion,
	VIS_RSP_PRESET_ACRONYMS: VIS_RSP_PRESET_ACRONYMS,
	graphPath: graphPath,
};
