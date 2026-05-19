"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listBundlesInDirectory = exports.countAnnotationPkls = exports.countImageFiles = exports.resolvePathsForStep = exports.resolveRolePath = exports.loadProjectJson = exports.isBundleRoot = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const PROJECT_FILENAMES = ["project.masonjar", "project.belljar"];
const CANONICAL_ROLES = {
    original_scans: "data/original_scans",
    dapi: "data/counting/00_dapi",
    slices: "data/counting/01_slices",
    max: "data/counting/03_max",
    predictions: "data/counting/05_predictions",
    quantification: "data/counting/06_quantification",
    pkls: "data/counting/07_pkls",
    dual: "data/counting/08_dual",
};
const IMAGE_EXT_RE = /\.(tif|tiff|png|jpe?g)$/i;
function findProjectFilename(bundleRoot) {
    for (const name of PROJECT_FILENAMES) {
        if (fs.existsSync(path.join(bundleRoot, name))) {
            return name;
        }
    }
    return PROJECT_FILENAMES[0];
}
function isBundleRoot(dir) {
    if (!dir || !fs.existsSync(dir)) {
        return false;
    }
    for (const name of PROJECT_FILENAMES) {
        if (fs.existsSync(path.join(dir, name))) {
            return true;
        }
    }
    return false;
}
exports.isBundleRoot = isBundleRoot;
function loadProjectJson(bundleRoot) {
    const filePath = path.join(bundleRoot, findProjectFilename(bundleRoot));
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
}
exports.loadProjectJson = loadProjectJson;
function resolveRolePath(bundleRoot, roles, role) {
    const rel = roles[role] || CANONICAL_ROLES[role];
    if (!rel) {
        return "";
    }
    if (path.isAbsolute(rel)) {
        return rel;
    }
    return path.join(bundleRoot, rel);
}
exports.resolveRolePath = resolveRolePath;
const STEP_ROLE_MAP = {
    max: { indir: "original_scans", outdir: "max" },
    sharpen: { indir: "max", outdir: "max" },
    detect: { indir: "max", outdir: "predictions" },
    count: {
        preddir: "predictions",
        annodir: "slices",
        outdir: "quantification",
    },
    intensity: {
        indir: "max",
        annodir: "slices",
        outdir: "pkls",
        dapi: "dapi",
    },
    dual: { indir: "pkls", outdir: "dual" },
};
function resolvePathsForStep(bundleRoot, stepId) {
    const project = loadProjectJson(bundleRoot);
    const roles = project.roles || CANONICAL_ROLES;
    const mapping = STEP_ROLE_MAP[stepId];
    if (!mapping) {
        return {};
    }
    const out = {};
    for (const [key, role] of Object.entries(mapping)) {
        out[key] = resolveRolePath(bundleRoot, roles, role);
    }
    return out;
}
exports.resolvePathsForStep = resolvePathsForStep;
function countImageFiles(dir) {
    if (!dir || !fs.existsSync(dir)) {
        return 0;
    }
    let count = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }
            if (IMAGE_EXT_RE.test(entry.name) ||
                entry.name.toLowerCase().includes(".ome.")) {
                count++;
            }
        }
    }
    catch (_err) {
        return 0;
    }
    return count;
}
exports.countImageFiles = countImageFiles;
const ANNOTATION_RE = /^Annotation_.*\.pkl$/i;
const LEGACY_PKL_RE = /\.pkl$/i;
function countAnnotationPkls(dir) {
    if (!dir || !fs.existsSync(dir)) {
        return 0;
    }
    let count = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) {
                continue;
            }
            if (ANNOTATION_RE.test(entry.name) || LEGACY_PKL_RE.test(entry.name)) {
                count++;
            }
        }
    }
    catch (_err) {
        return 0;
    }
    return count;
}
exports.countAnnotationPkls = countAnnotationPkls;
function listBundlesInDirectory(parentDir) {
    if (!parentDir || !fs.existsSync(parentDir)) {
        return [];
    }
    const out = [];
    try {
        const entries = fs.readdirSync(parentDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const full = path.join(parentDir, entry.name);
            if (isBundleRoot(full)) {
                out.push(full);
            }
        }
    }
    catch (_err) {
        return [];
    }
    return out.sort();
}
exports.listBundlesInDirectory = listBundlesInDirectory;
