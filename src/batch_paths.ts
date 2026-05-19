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
  for (const name of PROJECT_FILENAMES) {
    if (fs.existsSync(path.join(dir, name))) {
      return true;
    }
  }
  return false;
}

export function loadProjectJson(bundleRoot: string): {
  name?: string;
  roles?: ProjectRoles;
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
    out[key] = resolveRolePath(bundleRoot, roles, role);
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
