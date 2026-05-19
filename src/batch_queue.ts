import * as path from "path";
import {
  resolvePathsForStep,
  countImageFiles,
  type ResolvedStepPaths,
} from "./batch_paths";

export interface BatchProject {
  path: string;
  name: string;
}

export interface BatchPlan {
  projects: BatchProject[];
  steps: string[];
  params: Record<string, Record<string, unknown>>;
}

export interface BatchCompleteResult {
  errors: string[];
  cancelled?: boolean;
}

type PythonShellInstance = {
  kill(): void;
  on(event: "stderr" | "message", handler: (data: string) => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  end(callback: (err: unknown, code: unknown, signal: unknown) => void): void;
};

type PythonShellConstructor = new (
  script: string,
  options: Record<string, unknown>,
) => PythonShellInstance;

type ProgressCallback = (overallPct: number, message: string, detail?: string) => void;
type JobStartCallback = (project: string, step: string) => void;

export interface BatchQueueDeps {
  PythonShell: PythonShellConstructor;
  envPythonPath: string;
  pyCommand: string;
  pyScriptsPath: string;
  homeDir: string;
  appDir: string;
  describePythonShellFailure: (
    err: unknown,
    code: unknown,
    signal: unknown,
  ) => string | null;
  queueLogLineForUi: (line: string) => void;
}

let batchAbort = false;
let currentBatchShell: PythonShellInstance | null = null;

export function killBatchQueue(): void {
  batchAbort = true;
  if (currentBatchShell) {
    try {
      currentBatchShell.kill();
    } catch (_err) {
      /* ignore */
    }
    currentBatchShell = null;
  }
}

function runPythonProgressJob(
  deps: BatchQueueDeps,
  script: string,
  args: string[],
  onProgress: (pct: number, msg: string) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (batchAbort) {
      resolve("Cancelled");
      return;
    }
    const options = {
      mode: "text" as const,
      pythonPath: path.join(deps.envPythonPath, deps.pyCommand),
      scriptPath: deps.pyScriptsPath,
      args,
    };
    const pyshell = new deps.PythonShell(script, options);
    currentBatchShell = pyshell;
    let total = 0;
    let current = 0;

    pyshell.on("stderr", (stderr: string) => {
      deps.queueLogLineForUi(stderr);
    });

    pyshell.on("message", (message: string) => {
      if (batchAbort) {
        pyshell.kill();
        return;
      }
      if (total === 0) {
        total = Number(message);
      } else if (message === "Done!") {
        pyshell.end((err: unknown, code: unknown, signal: unknown) => {
          currentBatchShell = null;
          const pyFail = deps.describePythonShellFailure(err, code, signal);
          if (pyFail) {
            deps.queueLogLineForUi(pyFail);
          }
          resolve(pyFail);
        });
      } else {
        current++;
        onProgress(Math.round((current / total) * 100), message);
      }
    });

    pyshell.on("error", (err: unknown) => {
      currentBatchShell = null;
      resolve(String(err));
    });
  });
}

function runMaxJob(
  deps: BatchQueueDeps,
  paths: ResolvedStepPaths,
  params: Record<string, unknown>,
  onProgress: (pct: number, msg: string) => void,
): Promise<string | null> {
  const dendrites = params.dendrites ? "True" : "False";
  const cells = params.cells ? "True" : "False";
  return runPythonProgressJob(
    deps,
    "max.py",
    [
      `-o ${paths.outdir}`,
      `-i ${paths.indir}`,
      `-d ${dendrites}`,
      `-t ${cells}`,
      "-g False",
    ],
    onProgress,
  );
}

function runSharpenJob(
  deps: BatchQueueDeps,
  paths: ResolvedStepPaths,
  params: Record<string, unknown>,
  onProgress: (pct: number, msg: string) => void,
): Promise<string | null> {
  const custom = [
    String.raw`-o ${paths.outdir}`,
    String.raw`-i ${paths.indir}`,
    `-r ${params.radius}`,
    `-a ${params.amount}`,
  ];
  if (params.equalize) {
    custom.push("--equalize");
  }
  return runPythonProgressJob(deps, "sharpen.py", custom, onProgress);
}

function runDetectJob(
  deps: BatchQueueDeps,
  paths: ResolvedStepPaths,
  params: Record<string, unknown>,
  onProgress: (pct: number, msg: string) => void,
): Promise<string | null> {
  const models: Record<string, string> = {
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

function runCountJob(
  deps: BatchQueueDeps,
  paths: ResolvedStepPaths,
  params: Record<string, unknown>,
  onProgress: (pct: number, msg: string) => void,
): Promise<string | null> {
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

function runIntensityJob(
  deps: BatchQueueDeps,
  paths: ResolvedStepPaths,
  params: Record<string, unknown>,
  onProgress: (pct: number, msg: string) => void,
): Promise<string | null> {
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

function runDualJob(
  deps: BatchQueueDeps,
  paths: ResolvedStepPaths,
  onProgress: (pct: number, msg: string) => void,
): Promise<string | null> {
  return runPythonProgressJob(
    deps,
    "export_roi_dual_tif.py",
    [String.raw`-i ${paths.indir}`, String.raw`-o ${paths.outdir}`],
    onProgress,
  );
}

export async function runBatchQueue(
  deps: BatchQueueDeps,
  plan: BatchPlan,
  onProgress: ProgressCallback,
  onJobStart: JobStartCallback,
): Promise<BatchCompleteResult> {
  batchAbort = false;
  const errors: string[] = [];
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
      const paths = resolvePathsForStep(proj.path, stepId);
      const sliceCount =
        stepId === "count" || stepId === "intensity"
          ? 0
          : countImageFiles(paths.indir || paths.preddir || "");
      const detail =
        sliceCount > 0 ? `~${sliceCount} files in input` : "checking paths…";

      onJobStart(proj.name, stepId);
      onProgress(
        totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
        `${proj.name}: ${stepId}`,
        detail,
      );

      const stepParams = (plan.params && plan.params[stepId]) || {};
      const jobProgress = (pct: number, msg: string) => {
        const overall =
          totalJobs > 0
            ? Math.round(((completedJobs + pct / 100) / totalJobs) * 100)
            : pct;
        onProgress(overall, `${proj.name}: ${stepId}`, msg);
      };

      let err: string | null = null;
      try {
        switch (stepId) {
          case "max":
            err = await runMaxJob(deps, paths, stepParams, jobProgress);
            break;
          case "sharpen":
            err = await runSharpenJob(deps, paths, stepParams, jobProgress);
            break;
          case "detect":
            err = await runDetectJob(deps, paths, stepParams, jobProgress);
            break;
          case "count":
            err = await runCountJob(deps, paths, stepParams, jobProgress);
            break;
          case "intensity":
            err = await runIntensityJob(deps, paths, stepParams, jobProgress);
            break;
          case "dual":
            err = await runDualJob(deps, paths, jobProgress);
            break;
          default:
            err = `Unknown step: ${stepId}`;
        }
      } catch (e) {
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
}
