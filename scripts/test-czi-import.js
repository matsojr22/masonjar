"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var url = require("url");
var cziImport = require("../js/czi_import");

function testDefaultSliceId() {
	assert.strictEqual(cziImport.defaultSliceId("M528.czi", 0, 1), "M528");
	assert.strictEqual(cziImport.defaultSliceId("M528.czi", 1, 2), "M528_s001");
}

function testSuggestRole() {
	assert.strictEqual(cziImport.suggestRoleFromLabel("DAPI-405"), cziImport.ROLE_DAPI);
	assert.strictEqual(
		cziImport.suggestRoleFromLabel("Rabies"),
		cziImport.ROLE_SIGNAL_SOMATA,
	);
}

function testMergeProbe() {
	var imp = cziImport.buildDefaultCziImport("/scans");
	var probe = {
		files: [
			{
				path: "/scans/M528.czi",
				basename: "M528.czi",
				scenes: [{ index: 0, sliceId: "M528" }],
				channels: [
					{ index: 0, label: "DAPI", suggested_role: "dapi" },
					{ index: 1, label: "Unknown", suggested_role: "unused" },
				],
			},
		],
	};
	cziImport.mergeProbeIntoImport(imp, probe);
	assert.strictEqual(imp.channels.length, 2);
	assert.strictEqual(imp.channels[0].role, cziImport.ROLE_DAPI);
	assert.strictEqual(imp.channels[0].keep, true);
	assert.strictEqual(imp.channels[1].keep, true);
	assert.strictEqual(imp.channel_defaults["0"].role, cziImport.ROLE_DAPI);
	assert.strictEqual(imp.channel_defaults["1"].role, cziImport.ROLE_UNUSED);
}

function testSanitizeOtherName() {
	assert.strictEqual(cziImport.sanitizeOtherName(" rabies red "), "rabies_red");
	assert.strictEqual(cziImport.sanitizeOtherName("bad/name"), "badname");
	assert.strictEqual(cziImport.sanitizeOtherName(""), null);
	assert.strictEqual(cziImport.sanitizeOtherName("!!!"), null);
}

function testBranchForChannelOther() {
	var ch = { role: cziImport.ROLE_OTHER, other_name: "rabies_red" };
	assert.strictEqual(cziImport.branchForChannel(ch), "rabies_red");
	assert.strictEqual(cziImport.roleKeyForChannel(ch), "other:rabies_red");
}

function testApplyChannelDefaults() {
	var imp = {
		channel_defaults: {},
		channels: [
			{ file: "A.czi", index: 0, role: cziImport.ROLE_UNUSED, keep: true },
			{ file: "B.czi", index: 0, role: cziImport.ROLE_UNUSED, keep: true },
			{ file: "A.czi", index: 1, role: cziImport.ROLE_DAPI, keep: true },
		],
	};
	cziImport.applyChannelDefaults(imp, 0, {
		role: cziImport.ROLE_OTHER,
		other_name: "custom_sig",
	});
	assert.strictEqual(imp.channels[0].role, cziImport.ROLE_OTHER);
	assert.strictEqual(imp.channels[0].other_name, "custom_sig");
	assert.strictEqual(imp.channels[1].role, cziImport.ROLE_OTHER);
	assert.strictEqual(imp.channels[2].role, cziImport.ROLE_DAPI);
	assert.strictEqual(imp.channel_defaults["0"].other_name, "custom_sig");
}

function testCollectChannelIndices() {
	var imp = {
		channels: [{ index: 2 }, { index: 0 }, { index: 1 }, { index: 0 }],
	};
	assert.deepStrictEqual(cziImport.collectChannelIndices(imp), [0, 1, 2]);
}

function testMaxRunRel() {
	assert.strictEqual(
		cziImport.maxRunRelForRole(cziImport.ROLE_SIGNAL_SOMATA, "M528-M529"),
		"somata/max/M528-M529",
	);
	assert.strictEqual(
		cziImport.maxRunRelForRole("other:rabies_red", "M528"),
		"rabies_red/max/M528",
	);
}

function testCollectSliceIds() {
	var imp = {
		slice_order: [
			{ ordinal: 1, sliceId: "M528_s061" },
			{ ordinal: 2, sliceId: "M528_s062" },
		],
		files: [{ scenes: [{ sliceId: "M528_s062" }, { sliceId: "M528_s061" }] }],
	};
	assert.deepStrictEqual(cziImport.collectSliceIds(imp), ["M528_s061", "M528_s062"]);
}

function testNaturalCompareSectionOrder() {
	var ids = ["M528_s100", "M528_s20", "M528_s9", "M528_s112"];
	ids.sort(function (a, b) {
		return cziImport.naturalCompare({ sliceId: a }, { sliceId: b });
	});
	assert.deepStrictEqual(ids, ["M528_s9", "M528_s20", "M528_s100", "M528_s112"]);
}

function testBuildSliceOrderRenameMultiDir() {
	var imp = cziImport.buildDefaultCziImport("");
	cziImport.mergeProbeDirIntoImport(
		imp,
		{
			files: [
				{
					path: "/scan1/A.czi",
					basename: "A.czi",
					scene_count: 25,
					channels: [{ index: 0, label: "DAPI" }],
					scenes: Array.from({ length: 25 }, function (_, i) {
						return { index: i, sliceId: "A_s" + String(i).padStart(3, "0") };
					}),
				},
			],
		},
		"/scan1",
		0,
	);
	cziImport.mergeProbeDirIntoImport(
		imp,
		{
			files: [
				{
					path: "/scan2/B.czi",
					basename: "B.czi",
					scene_count: 25,
					channels: [{ index: 0, label: "DAPI" }],
					scenes: Array.from({ length: 25 }, function (_, i) {
						return { index: i, sliceId: "B_s" + String(i).padStart(3, "0") };
					}),
				},
			],
		},
		"/scan2",
		1,
	);
	imp.slice_numbering = cziImport.SLICE_NUMBERING_RENAME;
	cziImport.buildSliceOrder(imp, "M528");
	assert.strictEqual(imp.slice_order.length, 50);
	assert.strictEqual(imp.slice_order[0].sliceId, "M528_s001");
	assert.strictEqual(imp.slice_order[49].sliceId, "M528_s050");
}

function testValidateSliceOrderDuplicate() {
	var imp = {
		slice_order: [
			{ ordinal: 1, sliceId: "M528_s001", path: "/a.czi", scene_index: 0 },
			{ ordinal: 2, sliceId: "M528_s001", path: "/b.czi", scene_index: 0 },
		],
		files: [],
	};
	assert.match(cziImport.validateSliceOrder(imp), /Duplicate slice ID/);
}

function testCollectKeptSignalRoleKeys() {
	var imp = {
		channels: [
			{ role: cziImport.ROLE_DAPI, keep: true },
			{ role: cziImport.ROLE_SIGNAL_SOMATA, keep: true },
			{ role: cziImport.ROLE_SIGNAL_NUCLEI, keep: false },
			{
				role: cziImport.ROLE_OTHER,
				other_name: "rabies_red",
				keep: true,
			},
		],
	};
	assert.deepStrictEqual(cziImport.collectKeptSignalRoleKeys(imp), [
		cziImport.ROLE_SIGNAL_SOMATA,
		"other:rabies_red",
	]);
}

function testImportConfigPath() {
	var p = cziImport.importConfigPath("/tmp/Brain_masonjar");
	assert.ok(p.endsWith(path.join(".masonjar", "czi_import_config.json")));
}

function testCollectMosaicWarnings() {
	var files = [
		{
			basename: "tile.czi",
			likely_unstitched: true,
			mosaic_stitch_status: "suspect",
			mosaic_warnings: ["Stitch in ZEN first."],
		},
		{
			basename: "tile.czi",
			likely_unstitched: true,
			mosaic_stitch_status: "suspect",
			mosaic_warnings: ["Stitch in ZEN first."],
		},
		{
			basename: "flat.czi",
			likely_unstitched: false,
			mosaic_stitch_status: "ok",
			mosaic_warnings: [],
		},
		{
			basename: "zen.czi",
			is_mosaic: true,
			m_tile_count: 30,
			likely_unstitched: false,
			mosaic_stitch_status: "ok",
			mosaic_warnings: ["Mosaic structure with 30 tile index(es) (normal for ZEN-stitched exports)."],
		},
	];
	var warnings = cziImport.collectMosaicWarnings(files);
	assert.strictEqual(warnings.length, 1);
	assert.strictEqual(warnings[0].basename, "tile.czi");
	assert.match(warnings[0].message, /ZEN/);
}

function testCollectMosaicInfo() {
	var files = [
		{
			basename: "zen.czi",
			is_mosaic: true,
			m_tile_count: 30,
			likely_unstitched: false,
			mosaic_stitch_status: "ok",
		},
		{
			basename: "bad.czi",
			is_mosaic: true,
			m_tile_count: 4,
			likely_unstitched: true,
			mosaic_stitch_status: "suspect",
		},
	];
	var infos = cziImport.collectMosaicInfo(files);
	assert.strictEqual(infos.length, 1);
	assert.strictEqual(infos[0].basename, "zen.czi");
	assert.match(infos[0].message, /30 tile/);
}

function testHasLikelyUnstitchedMosaic() {
	assert.strictEqual(
		cziImport.hasLikelyUnstitchedMosaic([{ likely_unstitched: false }]),
		false,
	);
	assert.strictEqual(
		cziImport.hasLikelyUnstitchedMosaic([{ likely_unstitched: true }]),
		true,
	);
}

function testCountExtractWorkItems() {
	var cfg = {
		files: [
			{
				basename: "M528.czi",
				scenes: [{ index: 0, sliceId: "M528" }, { index: 1, sliceId: "M528_s001" }],
			},
		],
		channels: [
			{ file: "M528.czi", index: 0, role: cziImport.ROLE_DAPI, keep: true },
			{ file: "M528.czi", index: 1, role: cziImport.ROLE_UNUSED, keep: false },
		],
	};
	assert.strictEqual(cziImport.countExtractWorkItems(cfg), 2);
}

testDefaultSliceId();
testSuggestRole();
testMergeProbe();
testSanitizeOtherName();
testBranchForChannelOther();
testApplyChannelDefaults();
testCollectChannelIndices();
testMaxRunRel();
testCollectSliceIds();
testNaturalCompareSectionOrder();
testBuildSliceOrderRenameMultiDir();
testValidateSliceOrderDuplicate();
testCollectKeptSignalRoleKeys();
testImportConfigPath();
testCollectMosaicWarnings();
testCollectMosaicInfo();
testHasLikelyUnstitchedMosaic();
testCountExtractWorkItems();

function testResolveOrientPreviewPath() {
	var bundle = fs.mkdtempSync(path.join(os.tmpdir(), "czi-orient-"));
	var sliceId = "M528_s001";
	var dapiPath = cziImport.dapiPreviewPath(bundle, sliceId);
	var prevDir = path.join(bundle, cziImport.PREVIEWS_REL);
	fs.mkdirSync(path.dirname(dapiPath), { recursive: true });
	fs.mkdirSync(prevDir, { recursive: true });
	fs.writeFileSync(dapiPath, "dapi");
	var somataPrev = path.join(prevDir, sliceId + "_somata.png");
	fs.writeFileSync(somataPrev, "somata");
	var cziCfg = {
		primary_signal_role: cziImport.ROLE_SIGNAL_SOMATA,
		channels: [
			{ file: "M528.czi", index: 0, role: cziImport.ROLE_DAPI, keep: true },
			{ file: "M528.czi", index: 1, role: cziImport.ROLE_SIGNAL_SOMATA, keep: true },
		],
	};
	assert.strictEqual(
		cziImport.resolveOrientPreviewPath(bundle, cziCfg, null, sliceId),
		somataPrev,
	);
	fs.unlinkSync(somataPrev);
	assert.strictEqual(
		cziImport.resolveOrientPreviewPath(bundle, cziCfg, null, sliceId),
		dapiPath,
	);
}

function testCziImportFingerprintStable() {
	var imp = cziImport.buildDefaultCziImport("/scan/a");
	imp.source_dirs = ["/scan/a", "/scan/b"];
	imp.slice_order = [{ ordinal: 1, sliceId: "M528_s001", path: "/scan/a/M528.czi", scene_index: 0 }];
	imp.channels = [
		{ file: "M528.czi", index: 0, role: cziImport.ROLE_DAPI, keep: true },
	];
	var fp1 = cziImport.cziImportFingerprint(imp);
	var fp2 = cziImport.cziImportFingerprint(JSON.parse(JSON.stringify(imp)));
	assert.strictEqual(fp1, fp2);
	assert.notStrictEqual(fp1, cziImport.cziImportFingerprint(cziImport.buildDefaultCziImport("/other")));
}

function testAuditCziImportCompletion() {
	var bundle = fs.mkdtempSync(path.join(os.tmpdir(), "czi-audit-"));
	var meta = path.join(bundle, ".masonjar");
	fs.mkdirSync(meta, { recursive: true });
	var sliceId = "M528_s001";
	var cziCfg = {
		primary_signal_role: cziImport.ROLE_SIGNAL_SOMATA,
		preview_format_version: cziImport.PREVIEW_FORMAT_VERSION,
		slice_order: [{ ordinal: 1, sliceId: sliceId, path: "/scan/M528.czi", scene_index: 0, basename: "M528.czi" }],
		files: [
			{
				basename: "M528.czi",
				path: "/scan/M528.czi",
				scenes: [{ index: 0, sliceId: sliceId }],
			},
		],
		channels: [
			{ file: "M528.czi", index: 0, role: cziImport.ROLE_DAPI, keep: true },
			{ file: "M528.czi", index: 1, role: cziImport.ROLE_SIGNAL_SOMATA, keep: true },
		],
		max_runs: { signal_somata: "somata/max/M528_s001" },
	};
	var zSomata = cziImport.originalScansPath(bundle, cziCfg.channels[1], sliceId);
	fs.mkdirSync(path.dirname(zSomata), { recursive: true });
	fs.writeFileSync(zSomata, "z");
	var zDapi = cziImport.originalScansPath(bundle, cziCfg.channels[0], sliceId);
	fs.mkdirSync(path.dirname(zDapi), { recursive: true });
	fs.writeFileSync(zDapi, "z");
	var dapiPrev = cziImport.dapiPreviewPath(bundle, sliceId);
	fs.mkdirSync(path.dirname(dapiPrev), { recursive: true });
	fs.writeFileSync(dapiPrev, "preview");
	var orientDapiPrev = cziImport.orientDapiPreviewPath(bundle, sliceId);
	fs.mkdirSync(path.dirname(orientDapiPrev), { recursive: true });
	fs.writeFileSync(orientDapiPrev, "preview");
	var somataPrev = cziImport.signalPreviewPath(bundle, sliceId, cziCfg.channels[1]);
	fs.mkdirSync(path.dirname(somataPrev), { recursive: true });
	fs.writeFileSync(somataPrev, "preview");
	var maxDir = path.join(bundle, "data/counting/03_max/somata/max/M528_s001");
	fs.mkdirSync(maxDir, { recursive: true });
	fs.writeFileSync(path.join(maxDir, sliceId + ".tif"), "max");
	fs.writeFileSync(
		path.join(meta, "czi_import_state.json"),
		JSON.stringify({
			phase: "complete",
			done: 2,
			total: 2,
			preview_format_version: cziImport.PREVIEW_FORMAT_VERSION,
		}),
	);
	var audit = cziImport.auditCziImportCompletion(bundle, cziCfg, {
		importResult: { max_runs: cziCfg.max_runs },
	});
	assert.strictEqual(audit.extractComplete, true);
	assert.strictEqual(audit.canSkipToOrient, true);
	fs.writeFileSync(
		path.join(meta, "czi_import_state.json"),
		JSON.stringify({ phase: "complete", done: 2, total: 2, preview_format_version: 2 }),
	);
	var auditV2Tiff = cziImport.auditCziImportCompletion(bundle, cziCfg, {
		importResult: { max_runs: cziCfg.max_runs },
	});
	assert.strictEqual(auditV2Tiff.needsPreviewRepair, true);
	assert.strictEqual(auditV2Tiff.canSkipToOrient, false);
	fs.writeFileSync(
		path.join(meta, "czi_import_state.json"),
		JSON.stringify({ phase: "complete", done: 2, total: 2, preview_format_version: 1 }),
	);
	var auditLegacy = cziImport.auditCziImportCompletion(bundle, cziCfg, {
		importResult: { max_runs: cziCfg.max_runs },
	});
	assert.strictEqual(auditLegacy.needsPreviewRepair, true);
}

function testPathToFileURLSpaces() {
	var p = path.join("Z:", "Matt Jacobs", "Brain_masonjar", "data", "preview.tif");
	var href = url.pathToFileURL(p).href;
	assert.ok(href.startsWith("file://"));
	assert.ok(href.indexOf("Matt") >= 0);
}

testResolveOrientPreviewPath();
testCziImportFingerprintStable();
testAuditCziImportCompletion();
testPathToFileURLSpaces();
console.log("test-czi-import.js: OK");
