"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var cziImport = require("../js/czi_import");
var orientGeometry = require("../js/orient_geometry");

function testResetGeometryMap() {
	var map = {
		A: { rotate: 90, flipX: true, flipY: false },
		B: { rotate: 180, flipX: false, flipY: true },
		C: { rotate: 0, flipX: false, flipY: false },
	};
	var out = orientGeometry.resetGeometryMap(map, ["A", "B", "D"]);
	assert.strictEqual(out, map);
	assert.deepStrictEqual(out.A, { rotate: 0, flipX: false, flipY: false });
	assert.deepStrictEqual(out.B, { rotate: 0, flipX: false, flipY: false });
	assert.deepStrictEqual(out.C, { rotate: 0, flipX: false, flipY: false });
	assert.strictEqual(out.D.rotate, 0);
}

function testCountNonIdentityAfterReset() {
	var map = {
		A: { rotate: 90, flipX: false, flipY: false },
		B: { rotate: 0, flipX: true, flipY: false },
	};
	orientGeometry.resetGeometryMap(map, ["A", "B"]);
	assert.strictEqual(orientGeometry.countNonIdentityGeometry(map, ["A", "B"]), 0);
}

function testOrientPreviewHintText() {
	assert.match(
		orientGeometry.orientPreviewHintText(null, 1),
		/CSS preview/,
	);
	assert.match(
		orientGeometry.orientPreviewHintText("2026-01-01T00:00:00.000Z", 0),
		/on-disk previews/,
	);
	assert.match(orientGeometry.orientPreviewHintText(null, 0), /on-disk previews/);
}

function testIsIdentityGeometry() {
	assert.strictEqual(
		orientGeometry.isIdentityGeometry({ rotate: 360, flipX: false, flipY: false }),
		true,
	);
	assert.strictEqual(
		orientGeometry.isIdentityGeometry({ rotate: 90, flipX: false, flipY: false }),
		false,
	);
}

function testRot90ClickContract() {
	var geom = orientGeometry.defaultGeometry();
	geom = orientGeometry.applyGeometryAction(geom, "rot90");
	assert.strictEqual(geom.rotate, 90);
	assert.strictEqual(geom.flipX, false);
	assert.strictEqual(geom.flipY, false);
	assert.strictEqual(
		orientGeometry.geometryCssTransform(geom),
		"rotate(90deg) scaleX(1) scaleY(1)",
	);
}

function testOrientPostApplySummaryText() {
	var text = orientGeometry.orientPostApplySummaryText("2026-05-21T12:00:00.000Z", 42);
	assert.match(text, /Last applied:/);
	assert.match(text, /42 file/);
	assert.match(text, /rot 0/);
}

function testFindGeometryKeysWithoutPreviewFiles() {
	var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mj-orient-"));
	var bundle = path.join(tmp, "M528_masonjar");
	var dapiDir = path.join(bundle, "data/counting/00_dapi");
	fs.mkdirSync(dapiDir, { recursive: true });
	fs.writeFileSync(path.join(dapiDir, "M528_s001.png"), Buffer.from([0]));
	var geometry = {
		M528_s001: { rotate: 90, flipX: false, flipY: false },
		M528_orphan: { rotate: 90, flipX: false, flipY: false },
	};
	var orphans = cziImport.findGeometryKeysWithoutPreviewFiles(bundle, geometry, [
		"M528_s001",
	]);
	assert.deepStrictEqual(orphans, ["M528_orphan"]);
	fs.rmSync(tmp, { recursive: true, force: true });
}

function run() {
	testResetGeometryMap();
	testCountNonIdentityAfterReset();
	testOrientPreviewHintText();
	testIsIdentityGeometry();
	testRot90ClickContract();
	testOrientPostApplySummaryText();
	testFindGeometryKeysWithoutPreviewFiles();
	console.log("test-orient-geometry.js: all passed");
}

run();
