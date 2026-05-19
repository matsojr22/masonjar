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
const path = __importStar(require("path"));
const batch_paths_1 = require("./batch_paths");
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
function runPythonProgressJob(deps, script, args, onProgress) {
    return new Promise((resolve) => {
        if (batchAbort) {
            resolve("Cancelled");
            return;
        }
        const options = {
            mode: "text",
            pythonPath: path.join(deps.envPythonPath, deps.pyCommand),
            scriptPath: deps.pyScriptsPath,
            args,
        };
        const pyshell = new deps.PythonShell(script, options);
        currentBatchShell = pyshell;
        let total = 0;
        let current = 0;
        pyshell.on("stderr", (stderr) => {
            deps.queueLogLineForUi(stderr);
        });
        pyshell.on("message", (message) => {
            if (batchAbort) {
                pyshell.kill();
                return;
            }
            if (total === 0) {
                total = Number(message);
            }
            else if (message === "Done!") {
                pyshell.end((err, code, signal) => {
                    currentBatchShell = null;
                    const pyFail = deps.describePythonShellFailure(err, code, signal);
                    if (pyFail) {
                        deps.queueLogLineForUi(pyFail);
                    }
                    resolve(pyFail);
                });
            }
            else {
                current++;
                onProgress(Math.round((current / total) * 100), message);
            }
        });
        pyshell.on("error", (err) => {
            currentBatchShell = null;
            resolve(String(err));
        });
    });
}
function runMaxJob(deps, paths, params, onProgress) {
    const dendrites = params.dendrites ? "True" : "False";
    const cells = params.cells ? "True" : "False";
    return runPythonProgressJob(deps, "max.py", [
        `-o ${paths.outdir}`,
        `-i ${paths.indir}`,
        `-d ${dendrites}`,
        `-t ${cells}`,
        "-g False",
    ], onProgress);
}
function runSharpenJob(deps, paths, params, onProgress) {
    const custom = [
        String.raw `-o ${paths.outdir}`,
        String.raw `-i ${paths.indir}`,
        `-r ${params.radius}`,
        `-a ${params.amount}`,
    ];
    if (params.equalize) {
        custom.push("--equalize");
    }
    return runPythonProgressJob(deps, "sharpen.py", custom, onProgress);
}
function runDetectJob(deps, paths, params, onProgress) {
    const models = {
        somata: "models/chaosdruid.pt",
        nuclei: "models/ankou.pt",
    };
    const selected = String(params.method || "somata");
    let modelPath = path.join(deps.homeDir, models[selected] || models.somata);
    const customModel = String(params.customModel || "").trim();
    if (customModel.length > 0) {
        modelPath = customModel;
    }
    const samModelPath = path.join(deps.homeDir, "models/sam_vit_b.pth");
    const customArgs = [
        `-i ${paths.indir}`,
        `-o ${paths.outdir}`,
        `-c ${params.confidence}`,
        `-t ${params.tile}`,
        `-a ${params.area}`,
        `-s ${samModelPath}`,
        `-e ${params.eccentricity}`,
        `-m ${modelPath}`,
    ];
    if (params.multichannel) {
        customArgs.push("--multichannel");
    }
    return runPythonProgressJob(deps, "find_neurons.py", customArgs, onProgress);
}
function runCountJob(deps, paths, params, onProgress) {
    const structPath = path.join(deps.appDir, "csv/structure_map.pkl");
    const customArgs = [
        `-p ${paths.preddir}`,
        `-a ${paths.annodir}`,
        `-o ${paths.outdir}`,
        `-m ${structPath}`,
    ];
    if (params.layerinfo) {
        customArgs.push("--layers");
    }
    return runPythonProgressJob(deps, "count.py", customArgs, onProgress);
}
function runIntensityJob(deps, paths, params, onProgress) {
    const structPath = path.join(deps.appDir, "csv/structure_map.pkl");
    const alignment = params.wholeSlice === false ? "False" : "True";
    const args = [
        `-i ${paths.indir}`,
        `-o ${paths.outdir}`,
        `-a ${paths.annodir}`,
        `-w ${alignment}`,
        `-m ${structPath}`,
    ];
    if (params.useDapi && paths.dapi) {
        args.push(`-d ${paths.dapi}`);
    }
    return runPythonProgressJob(deps, "region.py", args, onProgress);
}
function runDualJob(deps, paths, onProgress) {
    return runPythonProgressJob(deps, "export_roi_dual_tif.py", [String.raw `-i ${paths.indir}`, String.raw `-o ${paths.outdir}`], onProgress);
}
function runBatchQueue(deps, plan, onProgress, onJobStart) {
    return __awaiter(this, void 0, void 0, function* () {
        batchAbort = false;
        const errors = [];
        const projects = plan.projects || [];
        const steps = plan.steps || [];
        const totalJobs = projects.length * steps.length;
        let completedJobs = 0;
        for (const proj of projects) {
            if (batchAbort) {
                break;
            }
            for (const stepId of steps) {
                if (batchAbort) {
                    break;
                }
                const paths = (0, batch_paths_1.resolvePathsForStep)(proj.path, stepId);
                const sliceCount = stepId === "count" || stepId === "intensity"
                    ? 0
                    : (0, batch_paths_1.countImageFiles)(paths.indir || paths.preddir || "");
                const detail = sliceCount > 0 ? `~${sliceCount} files in input` : "checking paths…";
                onJobStart(proj.name, stepId);
                onProgress(totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0, `${proj.name}: ${stepId}`, detail);
                const stepParams = (plan.params && plan.params[stepId]) || {};
                const jobProgress = (pct, msg) => {
                    const overall = totalJobs > 0
                        ? Math.round(((completedJobs + pct / 100) / totalJobs) * 100)
                        : pct;
                    onProgress(overall, `${proj.name}: ${stepId}`, msg);
                };
                let err = null;
                try {
                    switch (stepId) {
                        case "max":
                            err = yield runMaxJob(deps, paths, stepParams, jobProgress);
                            break;
                        case "sharpen":
                            err = yield runSharpenJob(deps, paths, stepParams, jobProgress);
                            break;
                        case "detect":
                            err = yield runDetectJob(deps, paths, stepParams, jobProgress);
                            break;
                        case "count":
                            err = yield runCountJob(deps, paths, stepParams, jobProgress);
                            break;
                        case "intensity":
                            err = yield runIntensityJob(deps, paths, stepParams, jobProgress);
                            break;
                        case "dual":
                            err = yield runDualJob(deps, paths, jobProgress);
                            break;
                        default:
                            err = `Unknown step: ${stepId}`;
                    }
                }
                catch (e) {
                    err = String(e);
                }
                completedJobs++;
                if (err) {
                    errors.push(`${proj.name} / ${stepId}: ${err}`);
                    deps.queueLogLineForUi(`Batch error: ${proj.name} / ${stepId}: ${err}`);
                }
            }
        }
        onProgress(100, batchAbort ? "Cancelled" : "Complete", "");
        return { errors, cancelled: batchAbort };
    });
}
exports.runBatchQueue = runBatchQueue;
