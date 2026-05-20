"use strict";

var assert = require("assert");
var cziArgv = require("../js/czi_argv");

function testImportArgsWithSpaces() {
	var args = [];
	cziArgv.appendCziPathArgs(
		args,
		"Z:\\Matt Jacobs\\masonjar_projects\\M465_masonjar",
		"Z:\\Matt Jacobs\\masonjar_projects\\M465_masonjar\\.masonjar\\czi_import_config.json",
	);
	assert.deepStrictEqual(args, [
		"-b",
		"Z:\\Matt Jacobs\\masonjar_projects\\M465_masonjar",
		"-j",
		"Z:\\Matt Jacobs\\masonjar_projects\\M465_masonjar\\.masonjar\\czi_import_config.json",
	]);
	for (var i = 0; i < args.length; i++) {
		assert.notStrictEqual(args[i][0], " ", "token must not start with space: " + args[i]);
		assert.notStrictEqual(args[i][args.length - 1], " ", "token must not end with space");
	}
}

function testProbeArgsWithSpaces() {
	var args = [];
	cziArgv.appendCziInputArg(args, " Z:\\Matt Jacobs\\tape_007\\scans ");
	assert.deepStrictEqual(args, ["-i", "Z:\\Matt Jacobs\\tape_007\\scans"]);
}

function testTrimBundleOnly() {
	var args = [];
	cziArgv.appendCziPathArgs(args, "  C:\\bundle_masonjar  ", "");
	assert.deepStrictEqual(args, ["-b", "C:\\bundle_masonjar"]);
}

testImportArgsWithSpaces();
testProbeArgsWithSpaces();
testTrimBundleOnly();
console.log("test-czi-argv.js: OK");
