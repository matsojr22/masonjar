"use strict";

var assert = require("assert");
var regionDualList = require("../js/region_dual_list");

function testTransferAddRemove() {
	var out = regionDualList.transferAdd([1, 2], []);
	assert.deepStrictEqual(out, [1, 2]);
	out = regionDualList.transferAdd([2, 3], out);
	assert.deepStrictEqual(out.sort(), [1, 2, 3]);
	out = regionDualList.transferRemove([2], out);
	assert.deepStrictEqual(out.sort(), [1, 3]);
}

function testRangeSelectIndices() {
	var idx = regionDualList.rangeSelectIndices(1, 4, 6);
	assert.deepStrictEqual(idx, [1, 2, 3, 4]);
}

testTransferAddRemove();
testRangeSelectIndices();
console.log("test-region-dual-list: ok");
