"use strict";

var navTrail = require("./nav_trail");
var project = require("./project");
var pipelineGate = require("./pipeline_gate");

project.tryRestoreActiveProject();
pipelineGate.assertPipelineAccess();

var CATEGORIES = {
	preprocess: {
		title: "Image preprocessing",
		tools: [
			{ label: "Max Projection", href: "./max.html" },
			{ label: "Sharpen", href: "./sharpen_wizard.html" },
			{ label: "Top-hat filter", href: "./tophat_wizard.html" },
			{ label: "Re-import sections from CZI", href: "./czi_reimport_wizard.html" },
			{
				label: "Semi-manual tissue edge cleanup",
				href: "./tissue_cleanup_wizard.html",
			},
			{
				group: "Deprecated & Experimental",
				tools: [
					{ label: "Orient slices", href: "./orient.html" },
					{ label: "DAPI cleanup", href: "./dapi_cleanup.html" },
				],
			},
		],
	},
	alignment: {
		title: "Atlas alignment",
		tools: [
			{ label: "Align Sections", href: "./align.html" },
			{ label: "Viewer/Editor", href: "./adjust.html" },
			{ label: "Parcellation (bulk)", href: "./parcellation_wizard.html" },
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

var categoryTitle = document.getElementById("categoryTitle");
var toolLinks = document.getElementById("toolLinks");

navTrail.renderTrail(
	[
		{ label: "Start", href: "./menu.html" },
		{ label: "Workspace", href: "./workspace_menu.html" },
		{ label: config.title },
	],
	"navTrail",
);

function appendToolLink(container, tool) {
	var link = document.createElement("a");
	link.role = "button";
	link.className = tool.secondary ? "btn btn-secondary" : "btn btn-primary";
	link.href = tool.href;
	link.textContent = tool.label;
	container.appendChild(link);
}

function appendToolGroup(container, groupDef, groupIndex) {
	var collapseId = "toolGroup" + groupIndex;
	var wrapper = document.createElement("div");
	wrapper.className = "mb-2 text-start";

	var toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "btn btn-outline-secondary w-100";
	toggle.setAttribute("data-bs-toggle", "collapse");
	toggle.setAttribute("data-bs-target", "#" + collapseId);
	toggle.setAttribute("aria-expanded", "false");
	toggle.setAttribute("aria-controls", collapseId);
	toggle.textContent = groupDef.group;

	var collapse = document.createElement("div");
	collapse.id = collapseId;
	collapse.className = "collapse mt-2";

	var inner = document.createElement("div");
	inner.className = "d-grid gap-2";
	for (var j = 0; j < groupDef.tools.length; j++) {
		var subTool = groupDef.tools[j];
		var subLink = document.createElement("a");
		subLink.role = "button";
		subLink.className = "btn btn-outline-secondary";
		subLink.href = subTool.href;
		subLink.textContent = subTool.label;
		inner.appendChild(subLink);
	}
	collapse.appendChild(inner);
	wrapper.appendChild(toggle);
	wrapper.appendChild(collapse);
	container.appendChild(wrapper);
}

if (categoryTitle) {
	categoryTitle.textContent = config.title;
}
if (toolLinks) {
	toolLinks.innerHTML = "";
	var groupIndex = 0;
	for (var i = 0; i < config.tools.length; i++) {
		var tool = config.tools[i];
		if (tool.group && tool.tools && tool.tools.length) {
			appendToolGroup(toolLinks, tool, groupIndex);
			groupIndex++;
		} else if (tool.href) {
			appendToolLink(toolLinks, tool);
		}
	}
}
