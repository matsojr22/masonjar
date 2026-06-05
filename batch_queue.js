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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBatchQueue = exports.killBatchQueue = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const batch_paths_1 = require("./batch_paths");
// Per-step downstream that must be skipped when an upstream fails.
const DEPENDENCY_GRAPH = {
    apply_geometry: [
        "dapi_cleanup",
        "parcellation",
        "max",
        "sharpen",
        "detect",
        "count",
        "intensity",
        "dual",
        "collate",
    ],
    dapi_cleanup: ["parcellation", "intensity", "dual"],
    parcellation: ["count", "intensity", "dual", "collate"],
    max: ["sharpen", "detect", "intensity", "count", "collate", "dual"],
    sharpen: ["detect", "intensity", "count", "collate", "dual"],
    detect: ["count", "collate"],
    count: ["collate"],
    intensity: ["dual"],
    dual: [],
    collate: [],
};
const TAIL_LIMIT = 50;
let batchAbort = false;
let currentBatchShell = null;
function killBatchQueue() {
    batchAbort = true;
    if (currentBatchShell) {
        try {
            currentBatchShell.kill();
        }
        catch (_err) {
            /* ignore */
        }
        currentBatchShell = null;
    }
}
exports.killBatchQueue = killBatchQueue;
function runPython(deps, opts) {
    return new Promise((resolve) => {
        if (batchAbort) {
            resolve({ error: "Cancelled", noPklsWritten: false });
            return;
        }
        const pythonOptions = {
            mode: "text",
            pythonPath: path.join(deps.envPythonPath, deps.pyCommand),
            scriptPath: deps.pyScriptsPath,
            args: opts.args,
            env: deps.pythonShellEnv(),
        };
        const pyshell = new deps.PythonShell(opts.scriptName, pythonOptions);
        currentBatchShell = pyshell;
        let total = 0;
        let current = 0;
        let sawNoPkls = false;
        let resolved = false;
        function finish(error) {
            if (resolved) {
                return;
            }
            resolved = true;
            currentBatchShell = null;
            resolve({ error, noPklsWritten: sawNoPkls });
        }
        pyshell.on("stderr", (stderr) => {
            opts.onLine(stderr.replace(/\r?\n$/, ""));
            if (stderr.indexOf("NO_PKLS_WRITTEN") >= 0) {
                sawNoPkls = true;
            }
        });
        pyshell.on("message", (message) => {
            if (batchAbort) {
                try {
                    pyshell.kill();
                }
                catch (_err) {
                    /* ignore */
                }
                return;
            }
            if (message.indexOf("NO_PKLS_WRITTEN") >= 0) {
                sawNoPkls = true;
            }
            if (message.startsWith("LOG:")) {
                opts.onLine(message.slice(4));
                return;
            }
            if (total === 0) {
                const n = Number(message);
                if (!Number.isNaN(n) && n > 0) {
                    total = n;
                    if (opts.onProgress) {
                        opts.onProgress(0, `Starting: 0/${total}`);
                    }
                    return;
                }
            }
            if (message === "Done!") {
                pyshell.end((err, code, signal) => {
                    const pyFail = deps.describePythonShellFailure(err, code, signal);
                    finish(pyFail);
                });
            }
            else {
                current++;
                opts.onLine(message);
                if (opts.onProgress) {
                    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
                    opts.onProgress(pct, message);
                }
            }
        });
        pyshell.on("error", (err) => {
            finish(String(err instanceof Error ? err.message : err));
        });
    });
}
function readSliceListIds(metaPath) {
    const file = path.join(metaPath, "run_slice_list.json");
    if (!fs.existsSync(file)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.slice_ids)) {
            return parsed.slice_ids.slice();
        }
    }
    catch (_err) {
        return [];
    }
    return [];
}
function writeSliceList(metaPath, sliceIds) {
    fs.mkdirSync(metaPath, { recursive: true });
    const out = path.join(metaPath, "run_slice_list.json");
    fs.writeFileSync(out, JSON.stringify({
        slice_ids: sliceIds,
        generated_at: new Date().toISOString(),
    }, null, 2), "utf8");
    return out;
}
function listAnnotationSliceIds(dir) {
    if (!dir || !fs.existsSync(dir)) {
        return [];
    }
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch (_a) {
        return [];
    }
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const m = entry.name.match(/^Annotation_(.*)\.pkl$/i);
        if (m) {
            out.push(m[1]);
        }
    }
    return out;
}
function listPredictionSliceIds(dir) {
    if (!dir || !fs.existsSync(dir)) {
        return [];
    }
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch (_a) {
        return [];
    }
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        const m = entry.name.match(/^Predictions_(.*)\.pkl$/i);
        if (m) {
            out.push(m[1]);
        }
    }
    return out;
}
function listImageSliceIds(dir) {
    if (!dir || !fs.existsSync(dir)) {
        return [];
    }
    return (0, batch_paths_1.listImageFiles)(dir).map((p) => (0, batch_paths_1.sliceIdFromFilename)(path.basename(p)));
}
function intersectSliceIds(...lists) {
    if (!lists.length) {
        return [];
    }
    const first = lists[0];
    const seen = {};
    for (const sid of first) {
        seen[sid] = 1;
    }
    for (let i = 1; i < lists.length; i++) {
        const next = {};
        for (const sid of lists[i]) {
            if (seen[sid]) {
                next[sid] = 1;
            }
        }
        Object.keys(seen).forEach((k) => {
            if (!next[k]) {
                delete seen[k];
            }
        });
    }
    return Object.keys(seen).sort();
}
function appendIfPath(args, flag, value) {
    const v = String(value || "").trim();
    if (v.length > 0) {
        args.push(flag, v);
    }
}
function buildRunSlug(stepId, ctx) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pipelineRuns = require("./js/pipeline_runs");
    return pipelineRuns.buildRunSlug(stepId, ctx);
}
function resolveRunLeaf(base, branch, slug) {
    if (!base) {
        return "";
    }
    if (!branch || !slug) {
        return base;
    }
    return path.join(base, branch, slug);
}
function relFromBase(base, finalOut) {
    if (!base || !finalOut) {
        return "";
    }
    return path
        .relative(base, finalOut)
        .split(path.sep)
        .join("/");
}
function ensureStructureMap(deps, onLine) {
    const appPath = path.join(deps.appDir, "csv/structure_map.pkl");
    if (fs.existsSync(appPath)) {
        return appPath;
    }
    const homePath = path.join(deps.homeDir, "nrrd", "structure_map.pkl");
    if (fs.existsSync(homePath)) {
        try {
            fs.mkdirSync(path.dirname(appPath), { recursive: true });
            fs.copyFileSync(homePath, appPath);
            onLine(`[repair] copied structure_map.pkl from ${homePath}`);
            return appPath;
        }
        catch (err) {
            onLine(`[repair] failed to copy structure_map.pkl: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return appPath; // may not exist; downstream will fail loudly
}
const PARCELLATION_META = "annotation_parcellation.json";
function readParcellationMeta(annodir) {
    for (const metaDir of [".masonjar", ".belljar"]) {
        const p = path.join(annodir, metaDir, PARCELLATION_META);
        if (fs.existsSync(p)) {
            try {
                const raw = fs.readFileSync(p, "utf8");
                const data = JSON.parse(raw);
                return data && typeof data === "object" ? data : {};
            }
            catch (_a) {
                return {};
            }
        }
    }
    return {};
}
function includeLayersAllowedForParcellation(meta) {
    const keys = Object.keys(meta);
    if (!keys.length) {
        return true;
    }
    const tiers = {};
    let parcelled = 0;
    for (const sid of keys) {
        const entry = meta[sid];
        if (!entry || typeof entry !== "object") {
            continue;
        }
        parcelled++;
        const key = `${entry.tier_id || ""}|${entry.st_level != null ? entry.st_level : ""}`;
        tiers[key] = (tiers[key] || 0) + 1;
    }
    if (parcelled === 0) {
        return true;
    }
    const tierKeys = Object.keys(tiers);
    let dominant = tierKeys.length === 1 ? tierKeys[0].split("|") : null;
    if (!dominant && tierKeys.length > 1) {
        tierKeys.sort((a, b) => tiers[b] - tiers[a]);
        dominant = tierKeys[0].split("|");
    }
    const tierId = dominant && dominant[0] ? dominant[0] : null;
    const stLevel = dominant && dominant[1] !== "" && dominant[1] != null
        ? Number(dominant[1])
        : null;
    if (!tierId && stLevel == null) {
        return true;
    }
    if (tierId === "layers") {
        return true;
    }
    if (stLevel != null && stLevel >= 11) {
        return true;
    }
    return false;
}
function preflightJob(deps, proj, stepId, plan, onLine) {
    var _a;
    const projectData = (() => {
        try {
            return (0, batch_paths_1.loadProjectJson)(proj.path);
        }
        catch (_a) {
            return null;
        }
    })();
    const roles = (projectData === null || projectData === void 0 ? void 0 : projectData.roles) || {};
    const processing = projectData === null || projectData === void 0 ? void 0 : projectData.processing;
    const metaPath = (0, batch_paths_1.ensureMetaDir)(proj.path);
    // Lightweight auto-repair: copy structure_map.pkl when needed.
    if (stepId === "count" ||
        stepId === "intensity" ||
        stepId === "collate") {
        ensureStructureMap(deps, onLine);
    }
    if (stepId === "apply_geometry") {
        const settings = ((projectData === null || projectData === void 0 ? void 0 : projectData.settings) || {});
        const cziImport = (settings.czi_import || {});
        const geometryMap = (cziImport.geometry || {});
        const ids = Object.keys(geometryMap);
        const hasPending = ids.some((sid) => {
            const g = geometryMap[sid];
            if (!g) {
                return false;
            }
            const rot = Number(g.rotate || 0) % 360;
            return rot !== 0 || !!g.flip_x || !!g.flip_y;
        });
        if (!hasPending) {
            return { skip: true, reason: "no pending geometry" };
        }
    }
    if (stepId === "dapi_cleanup") {
        const dapiDir = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "dapi");
        if (!dapiDir || !fs.existsSync(dapiDir)) {
            return { skip: true, reason: "no DAPI input" };
        }
        const imgs = (0, batch_paths_1.listImageFiles)(dapiDir);
        if (imgs.length === 0) {
            return { skip: true, reason: "no DAPI input" };
        }
    }
    if (stepId === "collate") {
        const projects = (plan.projects || []).filter((p) => {
            const projData = (() => {
                try {
                    return (0, batch_paths_1.loadProjectJson)(p.path);
                }
                catch (_a) {
                    return null;
                }
            })();
            const r = (projData === null || projData === void 0 ? void 0 : projData.roles) || {};
            const proc = projData === null || projData === void 0 ? void 0 : projData.processing;
            const countLeaf = (0, batch_paths_1.resolveInputLeafForStep)(p.path, "collate", "quantification", r, proc);
            return countLeaf && fs.existsSync(countLeaf);
        });
        if (projects.length < 2) {
            return {
                skip: true,
                reason: "collate needs ≥2 counted projects",
            };
        }
    }
    if (stepId === "parcellation") {
        const slicesLeaf = (0, batch_paths_1.resolveActiveRunLeafForBundle)(proj.path, roles, processing, "slices");
        if (!slicesLeaf || !fs.existsSync(slicesLeaf)) {
            return { skip: true, reason: "no active slices leaf" };
        }
        const annoIds = listAnnotationSliceIds(slicesLeaf);
        if (!annoIds.length) {
            return { skip: true, reason: "no annotation PKLs" };
        }
        const pParams = (((_a = plan.params) === null || _a === void 0 ? void 0 : _a.parcellation) || {});
        const ccfAdvanced = !!pParams.ccfAdvanced;
        const tierId = ccfAdvanced ? null : (pParams.tierId || "areas");
        const stLevel = ccfAdvanced
            ? (pParams.stLevel != null ? Number(pParams.stLevel) : 6)
            : null;
        const excluded = pParams.excludedRegionIds || [];
        if (!ccfAdvanced && tierId === "full" && excluded.length === 0) {
            return { skip: true, reason: "no parcellation change" };
        }
        if (ccfAdvanced && stLevel == null && excluded.length === 0) {
            return { skip: true, reason: "no parcellation change" };
        }
    }
    // slice list for detect/count/intensity
    if (stepId === "detect" || stepId === "count" || stepId === "intensity") {
        const stepPaths = (0, batch_paths_1.resolvePathsForStep)(proj.path, stepId);
        const slicesLeaf = (0, batch_paths_1.resolveActiveRunLeafForBundle)(proj.path, roles, processing, "slices");
        const annoIds = listAnnotationSliceIds(slicesLeaf);
        let candidateIds = annoIds;
        if (stepId === "detect") {
            const inputIds = listImageSliceIds(stepPaths.indir || "");
            candidateIds = intersectSliceIds(inputIds, annoIds.length ? annoIds : inputIds);
            if (!annoIds.length) {
                // detect doesn't need annotations - use raw input list
                candidateIds = inputIds;
            }
        }
        else if (stepId === "count") {
            const predIds = listPredictionSliceIds(stepPaths.preddir || "");
            candidateIds = intersectSliceIds(annoIds, predIds);
        }
        else if (stepId === "intensity") {
            const inputIds = listImageSliceIds(stepPaths.indir || "");
            candidateIds = intersectSliceIds(annoIds, inputIds);
        }
        if (!candidateIds.length) {
            // Leave the slice list off (defaults to scanning input dir); python will fail loudly if there's nothing.
            onLine(`[repair] ${stepId}: no slice intersection found; running without --slice-list`);
            return { skip: false };
        }
        const sliceListPath = writeSliceList(metaPath, candidateIds);
        onLine(`[repair] wrote ${stepId} slice list (${candidateIds.length}) → ${sliceListPath}`);
        if (stepId === "intensity") {
            const includeLayers = !!(plan.intensity && plan.intensity.include_layers);
            const parcelMeta = readParcellationMeta(slicesLeaf);
            if (includeLayers &&
                Object.keys(parcelMeta).length > 0 &&
                !includeLayersAllowedForParcellation(parcelMeta)) {
                onLine("[repair] intensity: include_layers disabled (parcellation above layer resolution)");
                return { skip: false, sliceListPath, forceIncludeLayersOff: true };
            }
        }
        return { skip: false, sliceListPath };
    }
    return { skip: false };
}
function writeIntensityConfig(proj, plan, finalOut, paths, sliceListPath, whole, useDapi, forceIncludeLayersOff) {
    let includeLayers = !!(plan.intensity && plan.intensity.include_layers);
    if (forceIncludeLayersOff) {
        includeLayers = false;
    }
    const cfg = {
        selected_region_ids: (plan.intensity && plan.intensity.selected_region_ids) || [],
        include_layers: includeLayers,
        whole,
        use_dapi: useDapi,
        input_dir: paths.indir || "",
        annotation_dir: paths.annodir || "",
        output_dir: finalOut,
        dapi_dir: useDapi ? paths.dapi || "" : "",
        slice_list: sliceListPath || "",
    };
    const metaPath = (0, batch_paths_1.ensureMetaDir)(proj.path);
    const cfgPath = path.join(metaPath, "intensity_run_config.json");
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
    return cfgPath;
}
function applyPostStepSideEffects(proj, stepId, outputAbs, branch) {
    const cfg = (0, batch_paths_1.getStepConfig)(stepId);
    if (!cfg || !cfg.outputRole) {
        return "";
    }
    let projectData;
    try {
        projectData = (0, batch_paths_1.loadProjectJson)(proj.path);
    }
    catch (_a) {
        return "";
    }
    if (!projectData) {
        return "";
    }
    const roles = projectData.roles || {};
    const roleBase = (0, batch_paths_1.resolveRolePath)(proj.path, roles, cfg.outputRole);
    if (!roleBase) {
        return "";
    }
    const rel = relFromBase(roleBase, outputAbs);
    if (!projectData.processing) {
        projectData.processing = {};
    }
    if (!projectData.processing.active_runs) {
        projectData.processing.active_runs = {};
    }
    projectData.processing.active_runs[cfg.outputRole] =
        rel;
    if (cfg.outputRole === "predictions") {
        projectData.processing.active_prediction_run = rel;
    }
    try {
        (0, batch_paths_1.saveProjectJson)(proj.path, projectData);
    }
    catch (_err) {
        /* ignore */
    }
    return rel;
}
function captureLineForTail(tail, line) {
    tail.push(line);
    while (tail.length > TAIL_LIMIT) {
        tail.shift();
    }
}
function readProjectMeta(projPath) {
    try {
        const data = (0, batch_paths_1.loadProjectJson)(projPath);
        return { roles: data.roles || {}, processing: data.processing };
    }
    catch (_a) {
        return { roles: {}, processing: undefined };
    }
}
function buildJob(deps, proj, stepId, plan, sliceListPath, onLine, preflight) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const params = (plan.params && plan.params[stepId]) || {};
    const meta = readProjectMeta(proj.path);
    const roles = meta.roles;
    const processing = meta.processing;
    const paths = (0, batch_paths_1.resolvePathsForStep)(proj.path, stepId);
    if (stepId === "max") {
        const stems = (0, batch_paths_1.listImageSliceStems)(paths.indir || "");
        const slug = buildRunSlug("max", {
            sortedStems: stems,
            dendrite: !!params.dendrites,
            tophat: !!params.cells,
        });
        const base = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "max");
        const finalOut = resolveRunLeaf(base, "max", slug);
        fs.mkdirSync(finalOut, { recursive: true });
        const args = [
            "-o",
            finalOut,
            "-i",
            paths.indir || "",
            "-d",
            params.dendrites ? "True" : "False",
            "-t",
            params.cells ? "True" : "False",
            "-g",
            "False",
        ];
        return {
            scriptName: "max.py",
            args,
            finalOutAbs: finalOut,
            finalOutRel: relFromBase(base, finalOut),
            branch: "max",
        };
    }
    if (stepId === "sharpen") {
        const stems = (0, batch_paths_1.listImageSliceStems)(paths.indir || "");
        const slug = buildRunSlug("sharpen", {
            sortedStems: stems,
            radius: Number(params.radius || 1),
            amount: Number(params.amount || 1),
            equalize: !!params.equalize,
        });
        const base = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "max");
        const finalOut = resolveRunLeaf(base, "sharpen", slug);
        fs.mkdirSync(finalOut, { recursive: true });
        const args = [
            "-o",
            finalOut,
            "-i",
            paths.indir || "",
            "-r",
            String((_a = params.radius) !== null && _a !== void 0 ? _a : 1),
            "-a",
            String((_b = params.amount) !== null && _b !== void 0 ? _b : 1),
        ];
        if (params.equalize) {
            args.push("--equalize");
        }
        return {
            scriptName: "sharpen.py",
            args,
            finalOutAbs: finalOut,
            finalOutRel: relFromBase(base, finalOut),
            branch: "sharpen",
        };
    }
    if (stepId === "detect") {
        const models = {
            somata: "models/chaosdruid.pt",
            nuclei: "models/ankou.pt",
        };
        const method = String(params.method || "somata");
        const branchName = method === "nuclei" ? "nuclei" : "somata";
        const customModel = String(params.customModel || "").trim();
        let modelPath = path.join(deps.homeDir, models[method] || models.somata);
        if (customModel.length > 0) {
            modelPath = customModel;
        }
        const samModelPath = path.join(deps.homeDir, "models/sam_vit_b.pth");
        const stems = (0, batch_paths_1.listImageSliceStems)(paths.indir || "");
        const slug = buildRunSlug("detect", {
            sortedStems: stems,
            confidence: Number((_c = params.confidence) !== null && _c !== void 0 ? _c : 0.5),
            tile: Number((_d = params.tile) !== null && _d !== void 0 ? _d : 640),
            area: Number((_e = params.area) !== null && _e !== void 0 ? _e : 200),
            eccentricity: Number((_f = params.eccentricity) !== null && _f !== void 0 ? _f : 0.2),
        });
        const base = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "predictions");
        const finalOut = resolveRunLeaf(base, branchName, slug);
        fs.mkdirSync(finalOut, { recursive: true });
        const args = [
            "-i",
            paths.indir || "",
            "-o",
            finalOut,
            "-c",
            String((_g = params.confidence) !== null && _g !== void 0 ? _g : 0.5),
            "-t",
            String((_h = params.tile) !== null && _h !== void 0 ? _h : 640),
            "-a",
            String((_j = params.area) !== null && _j !== void 0 ? _j : 200),
            "-s",
            samModelPath,
            "-e",
            String((_k = params.eccentricity) !== null && _k !== void 0 ? _k : 0.2),
            "-m",
            modelPath,
        ];
        if (params.multichannel) {
            args.push("--multichannel");
        }
        if (sliceListPath) {
            args.push("--slice-list", sliceListPath);
        }
        return {
            scriptName: "find_neurons.py",
            args,
            finalOutAbs: finalOut,
            finalOutRel: relFromBase(base, finalOut),
            branch: branchName,
        };
    }
    if (stepId === "count") {
        const structPath = ensureStructureMap(deps, onLine);
        const predRunRel = (() => {
            const predBase = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "predictions");
            return relFromBase(predBase, paths.preddir || "");
        })();
        const slicesRunRel = (() => {
            const sBase = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "slices");
            return relFromBase(sBase, paths.annodir || "");
        })();
        const slug = buildRunSlug("count", {
            predictionRunRel: predRunRel,
            slicesRunRel,
        });
        const base = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "quantification");
        const finalOut = resolveRunLeaf(base, "count", slug);
        fs.mkdirSync(finalOut, { recursive: true });
        const args = [
            "-p",
            paths.preddir || "",
            "-a",
            paths.annodir || "",
            "-o",
            finalOut,
            "-m",
            structPath,
        ];
        if (sliceListPath) {
            args.push("--slice-list", sliceListPath);
        }
        return {
            scriptName: "count.py",
            args,
            finalOutAbs: finalOut,
            finalOutRel: relFromBase(base, finalOut),
            branch: "count",
        };
    }
    if (stepId === "intensity") {
        const structPath = ensureStructureMap(deps, onLine);
        const whole = params.wholeSlice !== false;
        const useDapi = !!params.useDapi;
        const stems = (0, batch_paths_1.listImageSliceStems)(paths.indir || "");
        const regionCount = (plan.intensity && plan.intensity.selected_region_ids
            ? plan.intensity.selected_region_ids.length
            : 0) || 0;
        const includeLayers = !!(plan.intensity && plan.intensity.include_layers);
        const effectiveIncludeLayers = preflight && preflight.forceIncludeLayersOff ? false : includeLayers;
        const slug = buildRunSlug("intensity", {
            sortedStems: stems,
            whole: whole ? "True" : "False",
            useDapi,
            regionCount,
            includeLayers: effectiveIncludeLayers,
        });
        const base = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "pkls");
        const finalOut = resolveRunLeaf(base, "intensity", slug);
        fs.mkdirSync(finalOut, { recursive: true });
        const cfgPath = writeIntensityConfig(proj, plan, finalOut, paths, sliceListPath || "", whole, useDapi, preflight && preflight.forceIncludeLayersOff);
        const args = [
            "-i",
            paths.indir || "",
            "-o",
            finalOut,
            "-a",
            paths.annodir || "",
            "-w",
            whole ? "True" : "False",
            "-m",
            structPath,
        ];
        if (useDapi && paths.dapi) {
            args.push("-d", paths.dapi);
        }
        if (sliceListPath) {
            args.push("--slice-list", sliceListPath);
        }
        args.push("--config", cfgPath);
        return {
            scriptName: "region.py",
            args,
            finalOutAbs: finalOut,
            finalOutRel: relFromBase(base, finalOut),
            branch: "intensity",
        };
    }
    if (stepId === "dual") {
        const base = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "dual");
        const pklsBase = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "pkls");
        const pklsRunRel = relFromBase(pklsBase, paths.indir || "");
        const stems = (0, batch_paths_1.listImageSliceStems)(paths.indir || "");
        const slug = buildRunSlug("dual", {
            sortedStems: stems,
            pklsRunRel,
        });
        const finalOut = resolveRunLeaf(base, "dual", slug);
        fs.mkdirSync(finalOut, { recursive: true });
        const args = ["-i", paths.indir || "", "-o", finalOut];
        return {
            scriptName: "export_roi_dual_tif.py",
            args,
            finalOutAbs: finalOut,
            finalOutRel: relFromBase(base, finalOut),
            branch: "dual",
        };
    }
    if (stepId === "dapi_cleanup") {
        const dapiDir = (0, batch_paths_1.resolveRolePath)(proj.path, roles, "dapi");
        const inPlace = params.inPlace !== false; // default in-place
        const backupDirRel = path.join(path.dirname(dapiDir), "00_dapi_backup");
        const outDir = inPlace
            ? dapiDir
            : path.join(path.dirname(dapiDir), "00_dapi_clean");
        if (!inPlace) {
            fs.mkdirSync(outDir, { recursive: true });
        }
        const args = [
            "-i",
            dapiDir,
            "-o",
            outDir,
            params.isolate === false ? "--no-isolate" : "--isolate",
            "--saturation",
            String(params.saturation != null ? params.saturation : 5),
        ];
        if (params.clahe) {
            args.push("--clahe");
        }
        if (inPlace) {
            args.push("--backup-dir", backupDirRel);
        }
        if (params.bgValue != null && String(params.bgValue).trim().length > 0) {
            args.push("--bg-value", String(params.bgValue).trim());
        }
        return {
            scriptName: "dapi_cleanup.py",
            args,
            finalOutAbs: outDir,
            finalOutRel: "",
            branch: null,
        };
    }
    if (stepId === "apply_geometry") {
        let settings = {};
        try {
            const d = (0, batch_paths_1.loadProjectJson)(proj.path);
            settings = (d.settings || {});
        }
        catch (_m) {
            settings = {};
        }
        const cziImport = (settings.czi_import || {});
        const cfg = {
            project_root: proj.path,
            geometry: cziImport.geometry || {},
        };
        const metaPath = (0, batch_paths_1.ensureMetaDir)(proj.path);
        const cfgPath = path.join(metaPath, "batch_apply_geometry.json");
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
        const args = ["-b", proj.path, "-j", cfgPath];
        return {
            scriptName: "apply_geometry.py",
            args,
            finalOutAbs: proj.path,
            finalOutRel: "",
            branch: null,
        };
    }
    if (stepId === "parcellation") {
        const stepPaths = (0, batch_paths_1.resolvePathsForStep)(proj.path, stepId);
        const annodir = stepPaths.annodir || "";
        if (!annodir) {
            return null;
        }
        const pParams = (((_l = plan.params) === null || _l === void 0 ? void 0 : _l.parcellation) || {});
        const cfg = {
            annotation_dir: annodir,
            tier_id: pParams.ccfAdvanced ? null : pParams.tierId || "areas",
            st_level: pParams.ccfAdvanced
                ? (pParams.stLevel != null ? Number(pParams.stLevel) : 6)
                : null,
            excluded_region_ids: pParams.excludedRegionIds || [],
            slice_ids: null,
        };
        const metaPath = (0, batch_paths_1.ensureMetaDir)(proj.path);
        const cfgPath = path.join(metaPath, "parcellation_run_config.json");
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
        const mapPath = path.join(deps.appDir, "csv", "structure_map.pkl");
        const args = ["-a", annodir, "-s", mapPath, "-j", cfgPath];
        return {
            scriptName: "apply_parcellation.py",
            args,
            finalOutAbs: annodir,
            finalOutRel: "",
            branch: null,
        };
    }
    // collate is handled separately at the end of the batch (single run)
    if (stepId === "collate") {
        return null;
    }
    return null;
}
function makeJobResult(proj, stepId, status, reason, startedAt, endedAt, elapsedMs, tail, outputAbs, outputLeafRel) {
    return {
        project: proj.name,
        projectPath: proj.path,
        step: stepId,
        status,
        reason,
        elapsedMs,
        startedAt,
        endedAt,
        tail: tail.length ? tail.slice() : undefined,
        outputAbs,
        outputLeafRel,
    };
}
function markDownstreamSkipped(skipped, projPath, failedStep) {
    const downstream = DEPENDENCY_GRAPH[failedStep] || [];
    if (!skipped[projPath]) {
        skipped[projPath] = {};
    }
    for (const ds of downstream) {
        skipped[projPath][ds] = true;
    }
}
function runCollate(deps, plan, callbacks, projectIndex, stepIndex) {
    return __awaiter(this, void 0, void 0, function* () {
        const collateCfg = plan.collate || { name: "collated" };
        const startedAt = new Date().toISOString();
        const t0 = Date.now();
        const tail = [];
        const procLabel = "(all projects)";
        callbacks.onJobStart(procLabel, "collate", projectIndex, stepIndex);
        const onLine = (line) => {
            captureLineForTail(tail, line);
            callbacks.onJobLog(procLabel, "collate", line);
        };
        // Gather count CSVs from each project (count leaf).
        const inputs = [];
        for (const proj of plan.projects) {
            const meta = readProjectMeta(proj.path);
            const countLeaf = (0, batch_paths_1.resolveInputLeafForStep)(proj.path, "collate", "quantification", meta.roles, meta.processing);
            if (countLeaf && fs.existsSync(countLeaf)) {
                inputs.push(countLeaf);
            }
        }
        if (inputs.length < 2) {
            const elapsedMs = Date.now() - t0;
            const endedAt = new Date().toISOString();
            const reason = "collate needs ≥2 counted projects";
            onLine(reason);
            const result = makeJobResult({ name: procLabel, path: "" }, "collate", "skipped", reason, startedAt, endedAt, elapsedMs, tail);
            callbacks.onJobEnd(result);
            return result;
        }
        // Determine output dir + structures file.
        let outDir = String(collateCfg.outputDir || "").trim();
        if (!outDir) {
            let baseProj = collateCfg.outputProjectPath || plan.projects[0].path;
            const meta = readProjectMeta(baseProj);
            const quantBase = (0, batch_paths_1.resolveRolePath)(baseProj, meta.roles, "quantification");
            const slug = collateCfg.name ? collateCfg.name : "batch";
            outDir = path.join(quantBase, "collate", slug);
        }
        fs.mkdirSync(outDir, { recursive: true });
        const structPath = ensureStructureMap(deps, onLine);
        // collate.py expects one --input flag with comma-separated dirs? Look at the script.
        // The legacy collate.py uses -i for input directory (graphical=True opens prompts).
        // For non-graphical batch, we'll write the input list to a side file and invoke once per input via subprocess loop is too complex.
        // Mirror the existing single-tool collate: it takes -i (one directory containing multiple subdirs, each with count_results.csv).
        // We'll create a temp staging dir with symlinks pointing to each project's count leaf.
        const stageRoot = (0, batch_paths_1.ensureMetaDir)(plan.projects[0].path);
        const stage = path.join(stageRoot, `collate_stage_${Date.now()}`);
        fs.mkdirSync(stage, { recursive: true });
        for (const inp of inputs) {
            const name = path.basename(path.dirname(inp));
            const link = path.join(stage, name);
            try {
                fs.symlinkSync(inp, link, "dir");
            }
            catch (_err) {
                // Fallback: copy the count_results.csv only.
                const csv = path.join(inp, "count_results.csv");
                if (fs.existsSync(csv)) {
                    fs.mkdirSync(link, { recursive: true });
                    fs.copyFileSync(csv, path.join(link, "count_results.csv"));
                }
            }
        }
        const args = [
            "-o",
            outDir,
            "-i",
            stage,
            "-r",
            String(collateCfg.regions || ""),
            "-s",
            structPath,
            "-g",
            "False",
        ];
        callbacks.onProgress(50, "Collate: starting…", "");
        const result = yield runPython(deps, {
            scriptName: "collate.py",
            args,
            onLine,
        });
        // Cleanup stage
        try {
            fs.rmSync(stage, { recursive: true, force: true });
        }
        catch (_err) {
            /* ignore */
        }
        const elapsedMs = Date.now() - t0;
        const endedAt = new Date().toISOString();
        if (batchAbort) {
            const jobResult = makeJobResult({ name: procLabel, path: "" }, "collate", "cancelled", "Cancelled by user", startedAt, endedAt, elapsedMs, tail, outDir);
            callbacks.onJobEnd(jobResult);
            return jobResult;
        }
        if (result.error) {
            const jobResult = makeJobResult({ name: procLabel, path: "" }, "collate", "failed", result.error, startedAt, endedAt, elapsedMs, tail, outDir);
            callbacks.onJobEnd(jobResult);
            return jobResult;
        }
        const jobResult = makeJobResult({ name: procLabel, path: "" }, "collate", "ok", undefined, startedAt, endedAt, elapsedMs, tail, outDir);
        callbacks.onJobEnd(jobResult);
        return jobResult;
    });
}
function persistBatchSummary(projPath, summary) {
    if (!projPath) {
        return;
    }
    try {
        const meta = (0, batch_paths_1.ensureMetaDir)(projPath);
        const file = path.join(meta, "last_batch_summary.json");
        fs.writeFileSync(file, JSON.stringify(summary, null, 2), "utf8");
    }
    catch (_err) {
        /* ignore */
    }
}
function runBatchQueue(deps, plan, callbacks) {
    return __awaiter(this, void 0, void 0, function* () {
        batchAbort = false;
        const errors = [];
        const jobs = [];
        const byProject = {};
        const byStatus = {
            ok: 0,
            failed: 0,
            skipped: 0,
            cancelled: 0,
        };
        const skipped = {};
        const projects = plan.projects || [];
        const steps = (plan.steps || []).slice();
        const perProjectSteps = steps.filter((s) => s !== "collate");
        const hasCollate = steps.indexOf("collate") >= 0;
        const totalJobs = projects.length * perProjectSteps.length + (hasCollate ? 1 : 0);
        let completedJobs = 0;
        const batchStartedAt = new Date().toISOString();
        const batchT0 = Date.now();
        callbacks.onProgress(0, "Starting batch…", "");
        function bumpStatus(status) {
            if (!byStatus[status]) {
                byStatus[status] = 0;
            }
            byStatus[status]++;
        }
        function recordJob(jobResult) {
            jobs.push(jobResult);
            bumpStatus(jobResult.status);
            if (!byProject[jobResult.projectPath || jobResult.project]) {
                byProject[jobResult.projectPath || jobResult.project] = {};
            }
            byProject[jobResult.projectPath || jobResult.project][jobResult.step] =
                jobResult;
        }
        outer: for (let projIdx = 0; projIdx < projects.length; projIdx++) {
            const proj = projects[projIdx];
            for (let stepIdx = 0; stepIdx < perProjectSteps.length; stepIdx++) {
                if (batchAbort) {
                    break outer;
                }
                const stepId = perProjectSteps[stepIdx];
                const overallStepIndex = stepIdx;
                const startedAt = new Date().toISOString();
                const t0 = Date.now();
                const tail = [];
                callbacks.onJobStart(proj.name, stepId, projIdx, overallStepIndex);
                callbacks.onProgress(totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0, `${proj.name}: ${stepId}`, "");
                // Skip if upstream failed/skipped for this project
                if (skipped[proj.path] && skipped[proj.path][stepId]) {
                    const result = makeJobResult(proj, stepId, "skipped", "prerequisite_failed", startedAt, new Date().toISOString(), 0, tail);
                    recordJob(result);
                    callbacks.onJobEnd(result);
                    completedJobs++;
                    continue;
                }
                const onLine = (line) => {
                    captureLineForTail(tail, line);
                    callbacks.onJobLog(proj.name, stepId, line);
                };
                let pre;
                try {
                    pre = preflightJob(deps, proj, stepId, plan, onLine);
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    const result = makeJobResult(proj, stepId, "failed", `preflight error: ${msg}`, startedAt, new Date().toISOString(), Date.now() - t0, tail);
                    recordJob(result);
                    callbacks.onJobEnd(result);
                    errors.push(`${proj.name} / ${stepId}: preflight error: ${msg}`);
                    markDownstreamSkipped(skipped, proj.path, stepId);
                    completedJobs++;
                    continue;
                }
                if (pre.skip) {
                    const result = makeJobResult(proj, stepId, "skipped", pre.reason, startedAt, new Date().toISOString(), Date.now() - t0, tail);
                    recordJob(result);
                    callbacks.onJobEnd(result);
                    // For ignorable skips (no DAPI, no pending geometry), don't fail downstream.
                    completedJobs++;
                    continue;
                }
                let job = null;
                try {
                    job = buildJob(deps, proj, stepId, plan, pre.sliceListPath || "", onLine, pre);
                }
                catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    const result = makeJobResult(proj, stepId, "failed", `build error: ${msg}`, startedAt, new Date().toISOString(), Date.now() - t0, tail);
                    recordJob(result);
                    callbacks.onJobEnd(result);
                    errors.push(`${proj.name} / ${stepId}: build error: ${msg}`);
                    markDownstreamSkipped(skipped, proj.path, stepId);
                    completedJobs++;
                    continue;
                }
                if (!job) {
                    const result = makeJobResult(proj, stepId, "failed", `Unknown step: ${stepId}`, startedAt, new Date().toISOString(), Date.now() - t0, tail);
                    recordJob(result);
                    callbacks.onJobEnd(result);
                    errors.push(`${proj.name} / ${stepId}: Unknown step`);
                    completedJobs++;
                    continue;
                }
                const onProgress = (pct, msg) => {
                    const overall = totalJobs > 0
                        ? Math.round(((completedJobs + pct / 100) / totalJobs) * 100)
                        : pct;
                    callbacks.onProgress(overall, `${proj.name}: ${stepId}`, msg);
                };
                const result = yield runPython(deps, {
                    scriptName: job.scriptName,
                    args: job.args,
                    onLine,
                    onProgress,
                });
                const elapsedMs = Date.now() - t0;
                const endedAt = new Date().toISOString();
                let status = "ok";
                let reason;
                if (batchAbort) {
                    status = "cancelled";
                    reason = "Cancelled by user";
                }
                else if (result.error) {
                    status = "failed";
                    reason = result.error;
                }
                else if (stepId === "intensity" && result.noPklsWritten) {
                    status = "failed";
                    reason =
                        "Isolate Regions wrote no PKL files. Check alignment, selected regions, layer mode, and whole vs hemisphere.";
                }
                let outputLeafRel;
                if (status === "ok") {
                    outputLeafRel = applyPostStepSideEffects(proj, stepId, job.finalOutAbs, job.branch);
                }
                const jobResult = makeJobResult(proj, stepId, status, reason, startedAt, endedAt, elapsedMs, tail, job.finalOutAbs, outputLeafRel);
                recordJob(jobResult);
                callbacks.onJobEnd(jobResult);
                if (status === "failed") {
                    errors.push(`${proj.name} / ${stepId}: ${reason || "unknown error"}`);
                    markDownstreamSkipped(skipped, proj.path, stepId);
                }
                if (status === "cancelled") {
                    completedJobs++;
                    break outer;
                }
                completedJobs++;
            }
        }
        let collateResult;
        if (hasCollate && !batchAbort && projects.length >= 2) {
            collateResult = yield runCollate(deps, plan, callbacks, projects.length, perProjectSteps.length);
            recordJob(collateResult);
            if (collateResult.status === "failed") {
                errors.push(`collate: ${collateResult.reason || "unknown error"}`);
            }
            completedJobs++;
        }
        else if (hasCollate) {
            const startedAt = new Date().toISOString();
            const endedAt = startedAt;
            const reason = batchAbort
                ? "Cancelled by user"
                : "collate needs ≥2 projects";
            const status = batchAbort
                ? "cancelled"
                : "skipped";
            collateResult = makeJobResult({ name: "(all projects)", path: "" }, "collate", status, reason, startedAt, endedAt, 0, []);
            recordJob(collateResult);
            callbacks.onJobEnd(collateResult);
            completedJobs++;
        }
        callbacks.onProgress(100, batchAbort ? "Cancelled" : "Complete", "");
        const batchEndedAt = new Date().toISOString();
        const totalElapsedMs = Date.now() - batchT0;
        const summary = {
            jobs,
            byProject,
            byStatus,
            totalElapsedMs,
            startedAt: batchStartedAt,
            endedAt: batchEndedAt,
            collate: collateResult,
        };
        for (const proj of projects) {
            persistBatchSummary(proj.path, summary);
        }
        if (collateResult && collateResult.outputAbs) {
            try {
                const dir = path.dirname(collateResult.outputAbs);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, "last_batch_summary.json"), JSON.stringify(summary, null, 2), "utf8");
            }
            catch (_err) {
                /* ignore */
            }
        }
        return {
            errors,
            cancelled: batchAbort,
            summary,
        };
    });
}
exports.runBatchQueue = runBatchQueue;
