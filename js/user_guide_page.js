"use strict";

var fs = require("fs");
var path = require("path");

var GUIDE_PATH = path.join(__dirname, "..", "docs", "USER_GUIDE.md");

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function inline(raw) {
	var html = escapeHtml(raw);
	html = html.replace(/`([^`]+)`/g, function (_match, code) {
		return "<code>" + code + "</code>";
	});
	html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_match, text, href) {
		return '<a href="' + href + '">' + text + "</a>";
	});
	html = html.replace(/\*\*([^*]+)\*\*/g, function (_match, text) {
		return "<strong>" + text + "</strong>";
	});
	return html;
}

function slug(text) {
	return String(text)
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function splitRow(line) {
	var cells = line.trim();
	if (cells.charAt(0) === "|") {
		cells = cells.slice(1);
	}
	if (cells.charAt(cells.length - 1) === "|") {
		cells = cells.slice(0, -1);
	}
	return cells.split("|").map(function (cell) {
		return cell.trim();
	});
}

function isTableSeparator(line) {
	return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderMarkdown(markdown) {
	var lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
	var html = [];
	var usedIds = {};
	var index = 0;

	function uniqueId(base) {
		var id = base || "section";
		var n = 2;
		while (usedIds[id]) {
			id = (base || "section") + "-" + n;
			n += 1;
		}
		usedIds[id] = true;
		return id;
	}

	while (index < lines.length) {
		var line = lines[index];
		if (!line.trim()) {
			index += 1;
			continue;
		}
		if (line.trim().indexOf("```") === 0) {
			var code = [];
			index += 1;
			while (index < lines.length && lines[index].trim().indexOf("```") !== 0) {
				code.push(lines[index]);
				index += 1;
			}
			if (index < lines.length) {
				index += 1;
			}
			html.push("<pre class=\"user-guide-code\"><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
			continue;
		}
		var heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			var level = heading[1].length;
			var text = heading[2].trim();
			var id = uniqueId(slug(text));
			html.push("<h" + level + ' id="' + id + '">' + inline(text) + "</h" + level + ">");
			index += 1;
			continue;
		}
		if (/^---+$/.test(line.trim())) {
			html.push("<hr />");
			index += 1;
			continue;
		}
		if (
			line.trim().charAt(0) === "|" &&
			index + 1 < lines.length &&
			isTableSeparator(lines[index + 1])
		) {
			var header = splitRow(line);
			index += 2;
			var rows = [];
			while (index < lines.length && lines[index].trim().charAt(0) === "|") {
				rows.push(splitRow(lines[index]));
				index += 1;
			}
			var table = '<div class="table-responsive"><table class="table table-sm align-top">';
			table += "<thead><tr>";
			for (var c = 0; c < header.length; c++) {
				table += "<th>" + inline(header[c]) + "</th>";
			}
			table += "</tr></thead><tbody>";
			for (var r = 0; r < rows.length; r++) {
				table += "<tr>";
				for (var c2 = 0; c2 < rows[r].length; c2++) {
					table += "<td>" + inline(rows[r][c2]) + "</td>";
				}
				table += "</tr>";
			}
			table += "</tbody></table></div>";
			html.push(table);
			continue;
		}
		if (/^\s*[-*]\s+/.test(line)) {
			var bullets = [];
			while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
				bullets.push(lines[index].replace(/^\s*[-*]\s+/, ""));
				index += 1;
			}
			html.push(
				"<ul>" +
					bullets
						.map(function (item) {
							return "<li>" + inline(item) + "</li>";
						})
						.join("") +
					"</ul>",
			);
			continue;
		}
		if (/^\s*\d+\.\s+/.test(line)) {
			var steps = [];
			while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
				steps.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
				index += 1;
			}
			html.push(
				"<ol>" +
					steps
						.map(function (item) {
							return "<li>" + inline(item) + "</li>";
						})
						.join("") +
					"</ol>",
			);
			continue;
		}
		var paragraph = [line.trim()];
		index += 1;
		while (
			index < lines.length &&
			lines[index].trim() &&
			!/^(#{1,4})\s+/.test(lines[index]) &&
			lines[index].trim().indexOf("```") !== 0 &&
			lines[index].trim().charAt(0) !== "|" &&
			!/^\s*[-*]\s+/.test(lines[index]) &&
			!/^\s*\d+\.\s+/.test(lines[index]) &&
			!/^---+$/.test(lines[index].trim())
		) {
			paragraph.push(lines[index].trim());
			index += 1;
		}
		html.push("<p>" + inline(paragraph.join(" ")) + "</p>");
	}
	return html.join("\n");
}

function buildContents(root) {
	var headings = root.querySelectorAll("h2");
	if (!headings.length) {
		return;
	}
	var nav = document.createElement("nav");
	nav.id = "guide-toc";
	nav.className = "user-guide-toc mb-4";
	nav.setAttribute("aria-label", "Contents");
	var title = document.createElement("h2");
	title.className = "h5";
	title.textContent = "Contents";
	nav.appendChild(title);
	var list = document.createElement("ol");
	list.className = "small";
	for (var i = 0; i < headings.length; i++) {
		var item = document.createElement("li");
		var link = document.createElement("a");
		link.href = "#" + headings[i].id;
		link.textContent = headings[i].textContent;
		item.appendChild(link);
		list.appendChild(item);
	}
	nav.appendChild(list);
	var first = root.querySelector("h1");
	if (first && first.nextSibling) {
		root.insertBefore(nav, first.nextSibling);
	} else {
		root.insertBefore(nav, root.firstChild);
	}
}

function showGuide() {
	var root = document.getElementById("guide-root");
	var error = document.getElementById("guide-error");
	if (!root) {
		return;
	}
	var markdown;
	try {
		markdown = fs.readFileSync(GUIDE_PATH, "utf8");
	} catch (err) {
		if (error) {
			error.classList.remove("d-none");
			error.textContent = "Could not read the user guide at " + GUIDE_PATH;
		}
		return;
	}
	root.innerHTML = renderMarkdown(markdown);
	buildContents(root);
	var contents = document.getElementById("guideContents");
	if (contents) {
		contents.addEventListener("click", function (event) {
			var toc = document.getElementById("guide-toc");
			if (!toc) {
				return;
			}
			event.preventDefault();
			toc.scrollIntoView({ block: "start" });
		});
	}
}

if (typeof document !== "undefined") {
	showGuide();
}

module.exports = {
	renderMarkdown: renderMarkdown,
};
