"use strict";

var CATEGORIES = {
	preprocess: {
		title: "Image preprocessing",
		tools: [
			{ label: "Max Projection", href: "./max.html" },
			{ label: "Sharpen", href: "./sharpen.html" },
		],
	},
	alignment: {
		title: "Atlas alignment",
		tools: [
			{ label: "Align Sections", href: "./align.html" },
			{ label: "Viewer/Editor", href: "./adjust.html" },
		],
	},
	detection: {
		title: "Cell detection",
		tools: [
			{ label: "Cell Detection", href: "./detect.html" },
			{ label: "Count Brain", href: "./count.html" },
			{ label: "Collate Counts", href: "./collate.html", secondary: true },
		],
	},
	exports: {
		title: "Image and atlas exports",
		tools: [
			{ label: "Isolate Regions", href: "./intensity.html" },
			{ label: "Export dual-channel ROI TIFs", href: "./dual_export.html" },
		],
	},
};

var params = new URLSearchParams(window.location.search);
var cat = params.get("cat") || "preprocess";
var config = CATEGORIES[cat] || CATEGORIES.preprocess;

var breadcrumb = document.getElementById("breadcrumb");
var categoryTitle = document.getElementById("categoryTitle");
var toolLinks = document.getElementById("toolLinks");

if (breadcrumb) {
	breadcrumb.textContent = "Menu › " + config.title;
}
if (categoryTitle) {
	categoryTitle.textContent = config.title;
}
if (toolLinks) {
	toolLinks.innerHTML = "";
	for (var i = 0; i < config.tools.length; i++) {
		var tool = config.tools[i];
		var link = document.createElement("a");
		link.role = "button";
		link.className = tool.secondary ? "btn btn-secondary" : "btn btn-primary";
		link.href = tool.href;
		link.textContent = tool.label;
		toolLinks.appendChild(link);
	}
}
