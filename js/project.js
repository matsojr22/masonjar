"use strict";

var fs = require("fs");
var path = require("path");
var ipc = require("electron").ipcRenderer;
var branding = require("./branding");

var PROJECT_FILENAME = branding.PROJECT_FILENAME;
var META_DIR = branding.META_DIR;
var RECENT_KEY = branding.RECENT_KEY;
var ACTIVE_KEY = branding.ACTIVE_KEY;

var CANONICAL_ROLES = {
	original_scans: "data/original_scans",
	dapi: "data/counting/00_dapi",
	slices: "data/counting/01_slices",
	max: "data/counting/03_max",
	predictions: "data/counting/05_predictions",
	quantification: "data/counting/06_quantification",
	pkls: "data/counting/07_pkls",
	dual: "data/counting/08_dual",
};

/** workspace logical keys → project role keys */
var LOGICAL_TO_ROLE = {
	originalScans: "original_scans",
	dapi: "dapi",
	slices: "slices",
	max: "max",
	predictions: "predictions",
	quantification: "quantification",
	pkls: "pkls",
	dual: "dual",
	brainRoot: null,
	countingRoot: null,
};

var IMAGE_EXT_RE = /\.(tif|tiff|png|jpe?g)$/i;

var state = {
	active: false,
	bundleRoot: "",
	project: null,
	projectFilename: PROJECT_FILENAME,
	metaDirName: META_DIR,
};

function nowIso() {
	return new Date().toISOString();
}

function findProjectFilename(bundleRoot) {
	for (var i = 0; i < branding.PROJECT_FILENAMES.length; i++) {
		var name = branding.PROJECT_FILENAMES[i];
		if (fs.existsSync(path.join(bundleRoot, name))) {
			return name;
		}
	}
	return PROJECT_FILENAME;
}

function findMetaDirName(bundleRoot) {
	for (var i = 0; i < branding.META_DIRS.length; i++) {
		var name = branding.META_DIRS[i];
		if (fs.existsSync(path.join(bundleRoot, name))) {
			return name;
		}
	}
	return META_DIR;
}

function projectFilePath(bundleRoot) {
	return path.join(bundleRoot, state.projectFilename || findProjectFilename(bundleRoot));
}

function metaDir(bundleRoot) {
	return path.join(bundleRoot, state.metaDirName || findMetaDirName(bundleRoot));
}

function isBundleRoot(dir) {
	if (!dir || !fs.existsSync(dir)) {
		return false;
	}
	for (var i = 0; i < branding.PROJECT_FILENAMES.length; i++) {
		if (fs.existsSync(path.join(dir, branding.PROJECT_FILENAMES[i]))) {
			return true;
		}
	}
	return false;
}

function ensureBundleLayout(bundleRoot) {
	fs.mkdirSync(metaDir(bundleRoot), { recursive: true });
	var keys = Object.keys(CANONICAL_ROLES);
	for (var i = 0; i < keys.length; i++) {
		var rel = CANONICAL_ROLES[keys[i]];
		fs.mkdirSync(path.join(bundleRoot, rel), { recursive: true });
	}
}

function resolveRolePath(role) {
	if (!state.active || !state.project || !state.project.roles) {
		return "";
	}
	var rel = state.project.roles[role];
	if (!rel) {
		return "";
	}
	if (path.isAbsolute(rel)) {
		return rel;
	}
	return path.join(state.bundleRoot, rel);
}

function resolveLogicalPath(logicalKey) {
	if (!logicalKey) {
		return "";
	}
	if (logicalKey === "brainRoot") {
		return state.bundleRoot || "";
	}
	if (logicalKey === "countingRoot") {
		return state.bundleRoot
			? path.join(state.bundleRoot, "data", "counting")
			: "";
	}
	var role = LOGICAL_TO_ROLE[logicalKey];
	if (role && state.active) {
		var resolved = resolveRolePath(role);
		if (resolved) {
			return resolved;
		}
	}
	return "";
}

function loadProjectJson(bundleRoot) {
	state.projectFilename = findProjectFilename(bundleRoot);
	state.metaDirName = findMetaDirName(bundleRoot);
	var filePath = projectFilePath(bundleRoot);
	var raw = fs.readFileSync(filePath, "utf8");
	return JSON.parse(raw);
}

function saveProjectJson() {
	if (!state.active || !state.bundleRoot || !state.project) {
		return false;
	}
	state.project.modified = nowIso();
	if (!state.project.created) {
		state.project.created = state.project.modified;
	}
	var filePath = projectFilePath(state.bundleRoot);
	fs.writeFileSync(filePath, JSON.stringify(state.project, null, 2), "utf8");
	return true;
}

function syncWorkspaceFromProject(workspace) {
	if (!state.active || !workspace) {
		return;
	}
	var ws = workspace.getWorkspace ? workspace.getWorkspace() : null;
	if (!ws) {
		workspace.loadWorkspace();
		ws = workspace.getWorkspace();
	}
	ws.brainRoot = state.bundleRoot;
	ws.countingRoot = path.join(state.bundleRoot, "data", "counting");
	ws.originalScans = resolveRolePath("original_scans") || "";
	ws.paths = {};
	var roleKeys = ["dapi", "slices", "max", "predictions", "quantification", "pkls", "dual"];
	for (var i = 0; i < roleKeys.length; i++) {
		var k = roleKeys[i];
		ws.paths[k] = resolveRolePath(k) || "";
	}
	workspace.saveWorkspace();
}

function migrateLegacyRecentProjects() {
	var current = [];
	try {
		current = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
	} catch (err) {
		current = [];
	}
	if (current.length) {
		return;
	}
	try {
		var legacy = JSON.parse(localStorage.getItem(branding.LEGACY_RECENT_KEY) || "[]");
		if (legacy.length) {
			localStorage.setItem(RECENT_KEY, JSON.stringify(legacy));
		}
	} catch (err) {
		/* ignore */
	}
}

function addRecentProject(bundleRoot, name) {
	migrateLegacyRecentProjects();
	var list = [];
	try {
		list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
	} catch (err) {
		list = [];
	}
	list = list.filter(function (entry) {
		return entry.path !== bundleRoot;
	});
	list.unshift({
		path: bundleRoot,
		name: name || path.basename(bundleRoot),
		openedAt: nowIso(),
	});
	list = list.slice(0, 12);
	localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function getRecentProjects() {
	migrateLegacyRecentProjects();
	try {
		return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
	} catch (err) {
		return [];
	}
}

function setActiveProject(bundleRoot, projectData) {
	state.active = true;
	state.bundleRoot = bundleRoot;
	state.project = projectData;
	state.projectFilename = findProjectFilename(bundleRoot);
	state.metaDirName = findMetaDirName(bundleRoot);
	localStorage.setItem(ACTIVE_KEY, bundleRoot);
	addRecentProject(bundleRoot, projectData.name);
	try {
		var workspace = require("./workspace");
		syncWorkspaceFromProject(workspace);
	} catch (err) {
		/* workspace optional at load */
	}
}

function clearActiveProject() {
	state.active = false;
	state.bundleRoot = "";
	state.project = null;
	state.projectFilename = PROJECT_FILENAME;
	state.metaDirName = META_DIR;
	localStorage.removeItem(ACTIVE_KEY);
}

function openProject(bundleRoot) {
	bundleRoot = path.resolve(bundleRoot);
	if (!isBundleRoot(bundleRoot)) {
		throw new Error(
			"Not a " +
				branding.PRODUCT_NAME +
				" project: missing project.masonjar or project.belljar",
		);
	}
	var data = loadProjectJson(bundleRoot);
	if (!data.roles || Object.keys(data.roles).length === 0) {
		data.roles = Object.assign({}, CANONICAL_ROLES);
	}
	if (!data.layout) {
		data.layout = branding.LAYOUT_ID;
	}
	setActiveProject(bundleRoot, data);
	return state.project;
}

function tryRestoreActiveProject() {
	migrateLegacyRecentProjects();
	var saved = localStorage.getItem(ACTIVE_KEY);
	if (!saved) {
		saved = localStorage.getItem(branding.LEGACY_ACTIVE_KEY);
	}
	if (!saved || !isBundleRoot(saved)) {
		return false;
	}
	try {
		openProject(saved);
		return true;
	} catch (err) {
		clearActiveProject();
		return false;
	}
}

function createProject(options) {
	options = options || {};
	var bundleRoot = path.resolve(options.bundleRoot);
	var name = options.name || path.basename(bundleRoot);
	var referenceOnly = !!options.referenceOnly;
	var roles = options.roles || Object.assign({}, CANONICAL_ROLES);
	var sources = options.sources || {};
	var now = nowIso();

	state.projectFilename = PROJECT_FILENAME;
	state.metaDirName = META_DIR;
	ensureBundleLayout(bundleRoot);

	var projectData = {
		version: "1.0",
		name: name,
		layout: branding.LAYOUT_ID,
		created: now,
		modified: now,
		roles: roles,
		sources: sources,
		settings: options.settings || {},
		pipeline: options.pipeline || {},
		reference_only: referenceOnly,
		alignments: {},
	};

	fs.writeFileSync(
		projectFilePath(bundleRoot),
		JSON.stringify(projectData, null, 2),
		"utf8",
	);
	setActiveProject(bundleRoot, projectData);
	return projectData;
}

function isActive() {
	return state.active;
}

function getBundleRoot() {
	return state.bundleRoot;
}

function getProject() {
	return state.project;
}

function getStatusMessage() {
	if (!state.active) {
		return "";
	}
	var name = (state.project && state.project.name) || path.basename(state.bundleRoot);
	var mode = state.project && state.project.reference_only ? "reference" : "bundle";
	return "Project: " + name + " (" + mode + ")";
}

function copyDirRecursive(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	var entries = fs.readdirSync(src, { withFileTypes: true });
	for (var i = 0; i < entries.length; i++) {
		var entry = entries[i];
		var srcPath = path.join(src, entry.name);
		var destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

function importSourceToRole(sourcePath, role, mode, bundleRoot, roles) {
	bundleRoot = bundleRoot || state.bundleRoot;
	roles = roles || (state.project && state.project.roles) || CANONICAL_ROLES;
	var relDest = roles[role] || CANONICAL_ROLES[role];
	var dest = path.isAbsolute(relDest)
		? relDest
		: path.join(bundleRoot, relDest);

	if (!sourcePath || !fs.existsSync(sourcePath)) {
		return { role: role, source: sourcePath, error: "missing source" };
	}

	if (mode === "reference") {
		roles[role] = sourcePath;
		return { role: role, source: sourcePath, dest: sourcePath, mode: mode };
	}

	if (fs.existsSync(dest)) {
		try {
			var st = fs.lstatSync(dest);
			if (st.isSymbolicLink() || st.isFile()) {
				fs.unlinkSync(dest);
			} else if (st.isDirectory() && mode === "copy") {
				fs.rmSync(dest, { recursive: true, force: true });
			}
		} catch (unlinkErr) {
			/* continue */
		}
	}

	var stat = fs.statSync(sourcePath);
	if (mode === "symlink") {
		var linkType = stat.isDirectory() ? "dir" : "file";
		try {
			fs.symlinkSync(sourcePath, dest, linkType);
		} catch (symErr) {
			return {
				role: role,
				source: sourcePath,
				error: String(symErr.message || symErr),
			};
		}
	} else if (stat.isDirectory()) {
		copyDirRecursive(sourcePath, dest);
	} else {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(sourcePath, dest);
	}

	return {
		role: role,
		source: sourcePath,
		dest: relDest,
		mode: mode,
	};
}

function writeImportLog(bundleRoot, mode, entries) {
	var logPath = path.join(metaDir(bundleRoot), "import_log.json");
	var payload = {
		imported_at: nowIso(),
		mode: mode,
		entries: entries || [],
	};
	fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf8");
	return logPath;
}

function sliceIdFromFilename(filename) {
	var stem = path.parse(filename).name;
	if (stem.toLowerCase().endsWith(".ome")) {
		stem = path.parse(stem).name;
	}
	var dot = stem.indexOf(".");
	return dot >= 0 ? stem.slice(0, dot) : stem;
}

function listImageFiles(dir) {
	if (!dir || !fs.existsSync(dir)) {
		return [];
	}
	var out = [];
	var entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		return [];
	}
	for (var i = 0; i < entries.length; i++) {
		if (!entries[i].isFile()) {
			continue;
		}
		if (IMAGE_EXT_RE.test(entries[i].name) || entries[i].name.toLowerCase().indexOf(".ome.") !== -1) {
			out.push(path.join(dir, entries[i].name));
		}
	}
	return out;
}

function resolveRolePathForBundle(bundleRoot, roles, role) {
	var rel = roles[role];
	if (!rel) {
		return "";
	}
	if (path.isAbsolute(rel)) {
		return rel;
	}
	return path.join(bundleRoot, rel);
}

function buildManifest(bundleRoot, onProgress) {
	bundleRoot = bundleRoot || state.bundleRoot;
	var roles = (state.project && state.project.roles) || CANONICAL_ROLES;
	if (bundleRoot && (!state.project || state.bundleRoot !== bundleRoot)) {
		try {
			roles = loadProjectJson(bundleRoot).roles || roles;
		} catch (err) {
			/* use defaults */
		}
	}
	var scanRoles = [
		"dapi",
		"slices",
		"max",
		"predictions",
		"quantification",
		"pkls",
		"dual",
	];
	var slicesMap = {};
	var total = scanRoles.length;

	for (var r = 0; r < scanRoles.length; r++) {
		var role = scanRoles[r];
		if (typeof onProgress === "function") {
			onProgress(Math.round((r / total) * 100), "Scanning " + role);
		}
		var roleDir = resolveRolePathForBundle(bundleRoot, roles, role);
		if (!roleDir && state.active) {
			roleDir = resolveRolePath(role);
		}
		var files = listImageFiles(roleDir);
		for (var f = 0; f < files.length; f++) {
			var filePath = files[f];
			var sliceId = sliceIdFromFilename(path.basename(filePath));
			if (!sliceId) {
				continue;
			}
			if (!slicesMap[sliceId]) {
				slicesMap[sliceId] = { sliceId: sliceId, files: {} };
			}
			var relPath = path.relative(bundleRoot, filePath).split(path.sep).join("/");
			slicesMap[sliceId].files[role] = relPath;
		}
	}

	var sliceList = Object.keys(slicesMap)
		.sort()
		.map(function (k) {
			return slicesMap[k];
		});

	var manifestPath = path.join(metaDir(bundleRoot), "manifest.json");
	fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
	fs.writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				version: 1,
				generated_at: nowIso(),
				slices: sliceList,
			},
			null,
			2,
		),
		"utf8",
	);

	if (typeof onProgress === "function") {
		onProgress(100, "Manifest complete (" + sliceList.length + " slices)");
	}

	return manifestPath;
}

function chooseProjectBundle(callback) {
	ipc.once("returnPath", function (event, response) {
		var tag = response[1];
		if (typeof tag === "object" && tag !== null && tag.tag) {
			tag = tag.tag;
		}
		if (tag !== "projectBundle") {
			return;
		}
		var selected = response[0];
		if (selected) {
			try {
				openProject(selected);
				if (typeof callback === "function") {
					callback(null, state.project);
				}
			} catch (err) {
				if (typeof callback === "function") {
					callback(err);
				}
			}
		}
	});
	var defaultPath = state.bundleRoot || "";
	var payload = defaultPath
		? { tag: "projectBundle", defaultPath: defaultPath }
		: "projectBundle";
	ipc.send("openDialog", payload);
}

function chooseNewBundleLocation(callback) {
	ipc.once("returnPath", function (event, response) {
		var tag = response[1];
		if (typeof tag === "object" && tag !== null && tag.tag) {
			tag = tag.tag;
		}
		if (tag !== "newProjectBundle") {
			return;
		}
		if (typeof callback === "function") {
			callback(response[0] || "");
		}
	});
	ipc.send("openDialog", "newProjectBundle");
}

module.exports = {
	PROJECT_FILENAME: PROJECT_FILENAME,
	CANONICAL_ROLES: CANONICAL_ROLES,
	LOGICAL_TO_ROLE: LOGICAL_TO_ROLE,
	isBundleRoot: isBundleRoot,
	isActive: isActive,
	getBundleRoot: getBundleRoot,
	getProject: getProject,
	getStatusMessage: getStatusMessage,
	resolveRolePath: resolveRolePath,
	resolveLogicalPath: resolveLogicalPath,
	createProject: createProject,
	openProject: openProject,
	clearActiveProject: clearActiveProject,
	tryRestoreActiveProject: tryRestoreActiveProject,
	saveProjectJson: saveProjectJson,
	ensureBundleLayout: ensureBundleLayout,
	importSourceToRole: importSourceToRole,
	writeImportLog: writeImportLog,
	buildManifest: buildManifest,
	chooseProjectBundle: chooseProjectBundle,
	chooseNewBundleLocation: chooseNewBundleLocation,
	getRecentProjects: getRecentProjects,
	addRecentProject: addRecentProject,
	syncWorkspaceFromProject: syncWorkspaceFromProject,
	setActiveProject: setActiveProject,
};
