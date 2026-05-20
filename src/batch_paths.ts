import * as fs from "fs";
import * as path from "path";

const PROJECT_FILENAMES = ["project.masonjar", "project.belljar"];

const CANONICAL_ROLES: Record<string, string> = {
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

export interface ProjectRoles {
  [role: string]: string;
}

export interface ResolvedStepPaths {
  [key: string]: string;
}

function findProjectFilename(bundleRoot: string): string {
  if (!bundleRoot || !fs.existsSync(bundleRoot)) {
    return PROJECT_FILENAMES[0];
  }
  const namedMasonjar: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(bundleRoot, { withFileTypes: true });
  } catch {
    return PROJECT_FILENAMES[0];
  }
  for (const ent of entries) {
    if (!ent.isFile()) {
      continue;
    }
    if (/\.masonjar$/i.test(ent.name)) {
      namedMasonjar.push(ent.name);
    }
  }
  if (namedMasonjar.length === 1) {
    return namedMasonjar[0];
  }
  if (namedMasonjar.length > 1) {
    const folderSlug = path
      .basename(bundleRoot)
      .replace(/_masonjar$/i, "")
      .replace(/\.(masonjar|belljar)$/i, "");
    const expected = `${folderSlug}.masonjar`;
    if (namedMasonjar.includes(expected)) {
      return expected;
    }
    namedMasonjar.sort();
    return namedMasonjar[0];
  }
  for (const name of PROJECT_FILENAMES) {
    if (fs.existsSync(path.join(bundleRoot, name))) {
      return name;
    }
  }
  return PROJECT_FILENAMES[0];
}

export function isBundleRoot(dir: string): boolean {
  if (!dir || !fs.existsSync(dir)) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of entries) {
    if (!ent.isFile()) {
      continue;
    }
    if (/\.masonjar$/i.test(ent.name)) {
      return true;
    }
    if (PROJECT_FILENAMES.includes(ent.name)) {
      return true;
    }
  }
  return false;
}

export function loadProjectJson(bundleRoot: string): {
  name?: string;
  roles?: ProjectRoles;
  processing?: {
    active_runs?: Record<string, string>;
    active_prediction_run?: string;
  };
} {
  const filePath = path.join(bundleRoot, findProjectFilename(bundleRoot));
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

export function resolveRolePath(
  bundleRoot: string,
  roles: ProjectRoles,
  role: string,
): string {
  const rel = roles[role] || CANONICAL_ROLES[role];
  if (!rel) {
    return "";
  }
  if (path.isAbsolute(rel)) {
    return rel;
  }
  return path.join(bundleRoot, rel);
}

const STEP_ROLE_MAP: Record<string, Record<string, string>> = {
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

const OUTPUT_ROLES = new Set([
  "max",
  "slices",
  "predictions",
  "quantification",
  "pkls",
  "dual",
]);

function normalizeRel(rel: string): string {
  return String(rel || "")
    .split(/[/\\]+/)
    .filter(Boolean)
    .join("/");
}

function migrateActiveRuns(processing?: {
  active_runs?: Record<string, string>;
  active_prediction_run?: string;
}): Record<string, string> {
  const runs: Record<string, string> = {};
  for (const role of OUTPUT_ROLES) {
    runs[role] = "";
  }
  if (processing?.active_runs) {
    for (const [role, rel] of Object.entries(processing.active_runs)) {
      runs[role] = normalizeRel(rel);
    }
  }
  if (!runs.predictions && processing?.active_prediction_run) {
    runs.predictions = normalizeRel(processing.active_prediction_run);
  }
  return runs;
}

function resolveActiveRunLeaf(
  bundleRoot: string,
  roles: ProjectRoles,
  role: string,
  processing?: {
    active_runs?: Record<string, string>;
    active_prediction_run?: string;
  },
): string {
  const base = resolveRolePath(bundleRoot, roles, role);
  if (!base || !OUTPUT_ROLES.has(role)) {
    return base;
  }
  const activeRuns = migrateActiveRuns(processing);
  const rel = activeRuns[role] || "";
  if (!rel) {
    return base;
  }
  return path.join(base, rel.split("/").join(path.sep));
}

function resolveInputLeafForStep(
  bundleRoot: string,
  stepId: string,
  role: string,
  roles: ProjectRoles,
  processing?: {
    active_runs?: Record<string, string>;
    active_prediction_run?: string;
  },
): string {
  if (role === "dapi" || role === "original_scans") {
    return resolveRolePath(bundleRoot, roles, role);
  }
  if (stepId === "sharpen" && role === "max") {
    const base = resolveRolePath(bundleRoot, roles, "max");
    const activeRuns = migrateActiveRuns(processing);
    const rel = activeRuns.max || "";
    if (rel && rel.split("/")[0] === "max") {
      return path.join(base, rel.split("/").join(path.sep));
    }
    const branchDir = path.join(base, "max");
    return fs.existsSync(branchDir) ? branchDir : base;
  }
  return resolveActiveRunLeaf(bundleRoot, roles, role, processing);
}

export function resolvePathsForStep(
  bundleRoot: string,
  stepId: string,
): ResolvedStepPaths {
  const project = loadProjectJson(bundleRoot);
  const roles = project.roles || CANONICAL_ROLES;
  const mapping = STEP_ROLE_MAP[stepId];
  if (!mapping) {
    return {};
  }
  const out: ResolvedStepPaths = {};
  for (const [key, role] of Object.entries(mapping)) {
    if (key === "outdir") {
      out[key] = resolveActiveRunLeaf(
        bundleRoot,
        roles,
        role,
        project.processing,
      );
    } else {
      out[key] = resolveInputLeafForStep(
        bundleRoot,
        stepId,
        role,
        roles,
        project.processing,
      );
    }
  }
  return out;
}

export function countImageFiles(dir: string): number {
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
      if (
        IMAGE_EXT_RE.test(entry.name) ||
        entry.name.toLowerCase().includes(".ome.")
      ) {
        count++;
      }
    }
  } catch (_err) {
    return 0;
  }
  return count;
}

const ANNOTATION_RE = /^Annotation_.*\.pkl$/i;
const LEGACY_PKL_RE = /\.pkl$/i;

export function countAnnotationPkls(dir: string): number {
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
  } catch (_err) {
    return 0;
  }
  return count;
}

export function listBundlesInDirectory(parentDir: string): string[] {
  if (!parentDir || !fs.existsSync(parentDir)) {
    return [];
  }
  const out: string[] = [];
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
  } catch (_err) {
    return [];
  }
  return out.sort();
}
