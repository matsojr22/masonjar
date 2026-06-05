import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

export interface IoFairshareSharedConfig {
  enabled: boolean;
  link_mbps: number | "auto";
  headroom: number;
  min_mbps_per_job: number;
  max_mbps_per_job: number | "auto";
  small_file_bytes: number;
  stale_seconds: number;
  nas_path_prefixes: string[];
}

export interface IoFairshareUserConfig {
  enabled?: boolean;
  link_mbps?: number | "auto";
}

export interface IoFairshareRegistryEntry {
  job_id: string;
  pid: number;
  user: string;
  hostname: string;
  label: string;
  started_at: string;
  last_heartbeat: string;
}

export interface IoFairshareStatus {
  enabled: boolean;
  coordinator_dir: string;
  link_mbps: number;
  headroom: number;
  budget_mbps: number;
  active_jobs: number;
  limit_mbps: number;
  min_mbps_per_job: number;
  max_mbps_per_job: number;
  local_jobs: string[];
}

const DEFAULT_SHARED: IoFairshareSharedConfig = {
  enabled: true,
  link_mbps: "auto",
  headroom: 0.85,
  min_mbps_per_job: 25,
  max_mbps_per_job: "auto",
  small_file_bytes: 256 * 1024,
  stale_seconds: 30,
  nas_path_prefixes: [],
};

let cachedLinkMbps: number | null = null;

export function resetLinkSpeedCache(): void {
  cachedLinkMbps = null;
}

export function defaultCoordinatorDir(): string {
  const override = process.env.MASONJAR_IO_FAIRSHARE_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  if (process.platform === "win32") {
    const programData =
      process.env.ProgramData || path.join("C:", "ProgramData");
    return path.join(programData, "MasonJar", "io-fairshare");
  }
  if (process.platform === "darwin") {
    return "/Library/Application Support/MasonJar/io-fairshare";
  }
  return path.join("/var", "run", "masonjar-io-fairshare");
}

export function userConfigPath(homeDir: string): string {
  return path.join(homeDir, "io_fairshare.json");
}

function sharedConfigPath(coordinatorDir: string): string {
  return path.join(coordinatorDir, "config.json");
}

function registryDir(coordinatorDir: string): string {
  return path.join(coordinatorDir, "registry");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (_err) {
    return null;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function parseLinkSpeedText(raw: string): number | null {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) {
    return null;
  }
  const gbps = text.match(/([\d.]+)\s*gbps/);
  if (gbps) {
    return Math.round(parseFloat(gbps[1]) * 1000);
  }
  const mbps = text.match(/([\d.]+)\s*mbps/);
  if (mbps) {
    return Math.round(parseFloat(mbps[1]));
  }
  const kbps = text.match(/([\d.]+)\s*kbps/);
  if (kbps) {
    return Math.max(1, Math.round(parseFloat(kbps[1]) / 1000));
  }
  const digits = text.match(/([\d.]+)/);
  if (digits) {
    const n = parseFloat(digits[1]);
    if (n >= 100) {
      return Math.round(n);
    }
    if (n >= 1) {
      return Math.round(n * 1000);
    }
  }
  return null;
}

export function detectLinkMbps(): number {
  if (cachedLinkMbps != null && cachedLinkMbps > 0) {
    return cachedLinkMbps;
  }
  let detected: number | null = null;
  try {
    if (process.platform === "win32") {
      const cmd =
        'powershell -NoProfile -Command "Get-NetAdapter | Where-Object Status -eq \'Up\' | Sort-Object LinkSpeed -Descending | Select-Object -First 1 -ExpandProperty LinkSpeed"';
      const out = execSync(cmd, { encoding: "utf8", timeout: 8000 }).trim();
      detected = parseLinkSpeedText(out);
    } else if (process.platform === "darwin") {
      try {
        const out = execSync("networksetup -listallhardwareports", {
          encoding: "utf8",
          timeout: 5000,
        });
        const devMatch = out.match(/Device:\s*(en\d+)/);
        if (devMatch) {
          const ifOut = execSync(`ifconfig ${devMatch[1]}`, {
            encoding: "utf8",
            timeout: 5000,
          });
          const media = ifOut.match(/media:\s*[^\n]*?(\\d+)baseT/i);
          if (media) {
            detected = parseInt(media[1], 10);
          }
        }
      } catch (_err) {
        /* fall through */
      }
      if (detected == null) {
        detected = 1000;
      }
    }
  } catch (_err) {
    detected = null;
  }
  cachedLinkMbps = detected != null && detected > 0 ? detected : 1000;
  return cachedLinkMbps;
}

export function ensureCoordinatorDir(coordinatorDir: string): boolean {
  try {
    fs.mkdirSync(registryDir(coordinatorDir), { recursive: true });
    const cfgPath = sharedConfigPath(coordinatorDir);
    if (!fs.existsSync(cfgPath)) {
      writeJsonAtomic(cfgPath, DEFAULT_SHARED);
    }
    return true;
  } catch (_err) {
    return false;
  }
}

export function loadSharedConfig(coordinatorDir: string): IoFairshareSharedConfig {
  const parsed = readJsonFile<Partial<IoFairshareSharedConfig>>(
    sharedConfigPath(coordinatorDir),
  );
  return {
    ...DEFAULT_SHARED,
    ...(parsed || {}),
  };
}

export function saveSharedConfig(
  coordinatorDir: string,
  patch: Partial<IoFairshareSharedConfig>,
): IoFairshareSharedConfig {
  ensureCoordinatorDir(coordinatorDir);
  const merged = { ...loadSharedConfig(coordinatorDir), ...patch };
  writeJsonAtomic(sharedConfigPath(coordinatorDir), merged);
  return merged;
}

export function loadUserConfig(homeDir: string): IoFairshareUserConfig {
  return readJsonFile<IoFairshareUserConfig>(userConfigPath(homeDir)) || {};
}

export function saveUserConfig(
  homeDir: string,
  patch: IoFairshareUserConfig,
): IoFairshareUserConfig {
  const merged = { ...loadUserConfig(homeDir), ...patch };
  fs.mkdirSync(homeDir, { recursive: true });
  writeJsonAtomic(userConfigPath(homeDir), merged);
  return merged;
}

function resolveLinkMbps(
  shared: IoFairshareSharedConfig,
  user: IoFairshareUserConfig,
): number {
  const pick = user.link_mbps != null ? user.link_mbps : shared.link_mbps;
  if (pick === "auto") {
    return detectLinkMbps();
  }
  return Math.max(1, Number(pick) || 1000);
}

function resolveMaxMbps(
  shared: IoFairshareSharedConfig,
  linkMbps: number,
): number {
  if (shared.max_mbps_per_job === "auto") {
    return Math.max(shared.min_mbps_per_job, linkMbps * shared.headroom);
  }
  return Math.max(shared.min_mbps_per_job, Number(shared.max_mbps_per_job));
}

export function listRegistryEntries(
  coordinatorDir: string,
  staleSeconds: number,
): IoFairshareRegistryEntry[] {
  const dir = registryDir(coordinatorDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const now = Date.now();
  const out: IoFairshareRegistryEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const full = path.join(dir, name);
    const entry = readJsonFile<IoFairshareRegistryEntry>(full);
    if (!entry || !entry.last_heartbeat) {
      try {
        fs.unlinkSync(full);
      } catch (_err) {
        /* ignore */
      }
      continue;
    }
    const ageMs = now - Date.parse(entry.last_heartbeat);
    if (!Number.isFinite(ageMs) || ageMs > staleSeconds * 1000) {
      try {
        fs.unlinkSync(full);
      } catch (_err) {
        /* ignore */
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function computeJobLimitMbps(
  shared: IoFairshareSharedConfig,
  linkMbps: number,
  activeJobs: number,
): number {
  const jobs = Math.max(1, activeJobs);
  const budget = linkMbps * shared.headroom;
  const maxCap = resolveMaxMbps(shared, linkMbps);
  const raw = budget / jobs;
  return Math.min(maxCap, Math.max(shared.min_mbps_per_job, raw));
}

export function isFairshareEnabled(
  coordinatorDir: string,
  homeDir: string,
): boolean {
  if (process.env.MASONJAR_IO_FAIRSHARE === "0") {
    return false;
  }
  const user = loadUserConfig(homeDir);
  if (user.enabled === false) {
    return false;
  }
  const shared = loadSharedConfig(coordinatorDir);
  return shared.enabled !== false;
}

export function getIoFairshareStatus(
  coordinatorDir: string,
  homeDir: string,
): IoFairshareStatus {
  ensureCoordinatorDir(coordinatorDir);
  const shared = loadSharedConfig(coordinatorDir);
  const user = loadUserConfig(homeDir);
  const enabled = isFairshareEnabled(coordinatorDir, homeDir);
  const linkMbps = resolveLinkMbps(shared, user);
  const entries = listRegistryEntries(coordinatorDir, shared.stale_seconds);
  const activeJobs = Math.max(1, entries.length);
  const budget = linkMbps * shared.headroom;
  const limit = computeJobLimitMbps(shared, linkMbps, entries.length || 1);
  const maxCap = resolveMaxMbps(shared, linkMbps);
  const localJobs = entries
    .filter((e) => e.pid === process.pid || e.hostname === os.hostname())
    .map((e) => e.label);
  return {
    enabled,
    coordinator_dir: coordinatorDir,
    link_mbps: linkMbps,
    headroom: shared.headroom,
    budget_mbps: budget,
    active_jobs: entries.length,
    limit_mbps: enabled ? limit : maxCap,
    min_mbps_per_job: shared.min_mbps_per_job,
    max_mbps_per_job: maxCap,
    local_jobs: localJobs,
  };
}

export function newJobId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

export function registerJob(
  coordinatorDir: string,
  jobId: string,
  label: string,
): void {
  ensureCoordinatorDir(coordinatorDir);
  const entry: IoFairshareRegistryEntry = {
    job_id: jobId,
    pid: process.pid,
    user: os.userInfo().username,
    hostname: os.hostname(),
    label,
    started_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(registryDir(coordinatorDir), `${jobId}.json`), entry);
}

export function touchJob(coordinatorDir: string, jobId: string): void {
  const filePath = path.join(registryDir(coordinatorDir), `${jobId}.json`);
  const entry = readJsonFile<IoFairshareRegistryEntry>(filePath);
  if (!entry) {
    return;
  }
  entry.last_heartbeat = new Date().toISOString();
  writeJsonAtomic(filePath, entry);
}

export function unregisterJob(coordinatorDir: string, jobId: string): void {
  const filePath = path.join(registryDir(coordinatorDir), `${jobId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_err) {
    /* ignore */
  }
}

const activeNodeJobs = new Map<string, { label: string; timer: NodeJS.Timeout }>();

export function beginNodeJobTracking(
  coordinatorDir: string,
  jobId: string,
  label: string,
): void {
  registerJob(coordinatorDir, jobId, label);
  const timer = setInterval(() => {
    touchJob(coordinatorDir, jobId);
  }, 5000);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  activeNodeJobs.set(jobId, { label, timer });
}

export function endNodeJobTracking(coordinatorDir: string, jobId: string): void {
  const tracked = activeNodeJobs.get(jobId);
  if (tracked) {
    clearInterval(tracked.timer);
    activeNodeJobs.delete(jobId);
  }
  unregisterJob(coordinatorDir, jobId);
}

export function applyIoFairsharePythonEnv(
  baseEnv: NodeJS.ProcessEnv,
  coordinatorDir: string,
  homeDir: string,
  jobId: string,
  jobLabel: string,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (!isFairshareEnabled(coordinatorDir, homeDir)) {
    env.MASONJAR_IO_FAIRSHARE = "0";
    return env;
  }
  ensureCoordinatorDir(coordinatorDir);
  const status = getIoFairshareStatus(coordinatorDir, homeDir);
  env.MASONJAR_IO_FAIRSHARE = "1";
  env.MASONJAR_IO_FAIRSHARE_DIR = coordinatorDir;
  env.MASONJAR_IO_JOB_ID = jobId;
  env.MASONJAR_IO_JOB_LABEL = jobLabel;
  env.MASONJAR_IO_LINK_MBPS = String(status.link_mbps);
  env.MASONJAR_IO_HEADROOM = String(status.headroom);
  env.MASONJAR_IO_MIN_MBPS = String(status.min_mbps_per_job);
  env.MASONJAR_IO_MAX_MBPS = String(status.max_mbps_per_job);
  return env;
}

export function createHeavyJobHandle(
  coordinatorDir: string,
  homeDir: string,
  label: string,
  baseEnv: NodeJS.ProcessEnv,
): { jobId: string; env: NodeJS.ProcessEnv; release: () => void } {
  if (!isFairshareEnabled(coordinatorDir, homeDir)) {
    return {
      jobId: "",
      env: { ...baseEnv, MASONJAR_IO_FAIRSHARE: "0" },
      release: () => undefined,
    };
  }
  const jobId = newJobId();
  beginNodeJobTracking(coordinatorDir, jobId, label);
  const env = applyIoFairsharePythonEnv(
    baseEnv,
    coordinatorDir,
    homeDir,
    jobId,
    label,
  );
  return {
    jobId,
    env,
    release: () => endNodeJobTracking(coordinatorDir, jobId),
  };
}
