#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const menuPath = path.join(__dirname, "..", "js", "menu_category.js");
const src = fs.readFileSync(menuPath, "utf8");
const labels = [];
const re = /label:\s*"([^"]+)"/g;
let m;
while ((m = re.exec(src))) {
	if (src.slice(m.index - 80, m.index).includes("preprocess:")) {
		continue;
	}
}
const preprocessBlock = src.match(/preprocess:\s*\{[\s\S]*?tools:\s*\[([\s\S]*?)\]/);
if (!preprocessBlock) {
	console.error("preprocess tools block not found");
	process.exit(1);
}
const block = preprocessBlock[1];
const toolRe = /label:\s*"([^"]+)"/g;
while ((m = toolRe.exec(block))) {
	labels.push(m[1]);
}

const semi = labels.filter((l) => l.indexOf("Semi-manual tissue") >= 0);
if (semi.length !== 1) {
	console.error("Expected one Semi-manual tissue entry, got", semi.length);
	process.exit(1);
}
const dapiIdx = labels.indexOf("DAPI cleanup");
const semiIdx = labels.indexOf("Semi-manual tissue edge cleanup");
if (dapiIdx < 0 || semiIdx < 0 || dapiIdx >= semiIdx) {
	console.error("DAPI cleanup must appear before Semi-manual tissue edge cleanup");
	console.error(labels);
	process.exit(1);
}
console.log("test-menu-category.js ok");
