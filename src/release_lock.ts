import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface ReleaseKeyRec {
  id: string;
  /** 32-byte AES key, base64. */
  key: string;
}

export interface ReleaseLockFile {
  current: ReleaseKeyRec;
  previous?: ReleaseKeyRec[];
}

export const SETTINGS_PLAINTEXT: Record<string, string> = {
  io_fairshare: "io_fairshare.json",
  update_preferences: "update_preferences.json",
  dialog_preferences: "dialog_preferences.json",
  clean_install_epoch: "clean_install_epoch.json",
};

const HMAC_SKIP = new Set([
  "masonjar_hmac",
  "throttled_bytes_total",
  "throttled_mbps_1m",
]);

let cached: ReleaseLockFile | null | undefined;

function isElectron(): boolean {
  return !!(process.versions && (process.versions as { electron?: string }).electron);
}

function validMaterial(raw: unknown): ReleaseLockFile | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const current = (raw as ReleaseLockFile).current;
  if (!current || typeof current.id !== "string" || typeof current.key !== "string") {
    return null;
  }
  if (Buffer.from(current.key, "base64").length !== 32) {
    return null;
  }
  const previous = Array.isArray((raw as ReleaseLockFile).previous)
    ? (raw as ReleaseLockFile).previous
    : [];
  return { current, previous };
}

/** Packaged builds read release_lock.secret.js. Electron dev reads the private repo file. */
export function loadReleaseLock(appDir?: string): ReleaseLockFile | null {
  if (cached !== undefined && !appDir) {
    return cached;
  }
  const dir = appDir || __dirname;
  let parsed: ReleaseLockFile | null = null;
  const secretJs = path.join(dir, "release_lock.secret.js");
  const devJson = path.join(dir, "development", "secrets", "release_lock.json");
  try {
    if (!isElectron() && !appDir) {
      parsed = null;
    } else if (fs.existsSync(secretJs)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      parsed = validMaterial(require(secretJs));
    } else if (isElectron() && fs.existsSync(devJson)) {
      parsed = validMaterial(JSON.parse(fs.readFileSync(devJson, "utf8")));
    }
  } catch (_err) {
    parsed = null;
  }
  if (!appDir) {
    cached = parsed;
  }
  return parsed;
}

export function resetReleaseLockCache(): void {
  cached = undefined;
}

export function hasReleaseLock(): boolean {
  return !!loadReleaseLock();
}

export function keyBuffer(rec: ReleaseKeyRec): Buffer {
  return Buffer.from(rec.key, "base64");
}

export function allKeys(material: ReleaseLockFile): ReleaseKeyRec[] {
  return [material.current].concat(material.previous || []);
}

export function derivedFileName(keyB64: string, logical: string): string {
  return (
    crypto.createHmac("sha256", Buffer.from(keyB64, "base64")).update(logical).digest("hex") +
    ".mjlock"
  );
}

export function settingsPath(
  homeDir: string,
  logical: string,
  material?: ReleaseLockFile | null,
): string | null {
  const mat = material === undefined ? loadReleaseLock() : material;
  if (!mat) {
    return null;
  }
  return path.join(homeDir, derivedFileName(mat.current.key, logical));
}

export function encryptJson(rec: ReleaseKeyRec, value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer(rec), iv);
  const enc = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return ["MJ1", rec.id, iv.toString("base64"), enc.toString("base64"), tag.toString("base64")].join(
    "\n",
  );
}

export function decryptJson(
  material: ReleaseLockFile,
  body: string,
): { value: unknown; keyId: string } | null {
  const lines = String(body || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  if (lines[0] !== "MJ1" || lines.length < 5) {
    return null;
  }
  const keyId = lines[1];
  const rec = allKeys(material).find((item) => item.id === keyId);
  if (!rec) {
    return null;
  }
  try {
    const iv = Buffer.from(lines[2], "base64");
    const data = Buffer.from(lines[3], "base64");
    const tag = Buffer.from(lines[4], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer(rec), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return { value: JSON.parse(plain), keyId };
  } catch (_err) {
    return null;
  }
}

export function writeSettings(
  homeDir: string,
  logical: string,
  value: unknown,
  material?: ReleaseLockFile | null,
): void {
  const mat = material === undefined ? loadReleaseLock() : material;
  if (!mat) {
    return;
  }
  const filePath = settingsPath(homeDir, logical, mat);
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encryptJson(mat.current, value), "utf8");
}

function candidateSettings(
  homeDir: string,
  logical: string,
  mat: ReleaseLockFile,
): Array<{ rec: ReleaseKeyRec; filePath: string }> {
  return allKeys(mat).map((rec) => ({
    rec,
    filePath: path.join(homeDir, derivedFileName(rec.key, logical)),
  }));
}

export function readSettings(
  homeDir: string,
  logical: string,
  material?: ReleaseLockFile | null,
): unknown | null {
  const mat = material === undefined ? loadReleaseLock() : material;
  if (!mat) {
    return null;
  }
  const currentPath = settingsPath(homeDir, logical, mat);
  for (const cand of candidateSettings(homeDir, logical, mat)) {
    if (!fs.existsSync(cand.filePath)) {
      continue;
    }
    let decoded: { value: unknown; keyId: string } | null = null;
    try {
      decoded = decryptJson(mat, fs.readFileSync(cand.filePath, "utf8"));
    } catch (_err) {
      decoded = null;
    }
    if (!decoded) {
      continue;
    }
    if (cand.rec.id !== mat.current.id || decoded.keyId !== mat.current.id) {
      writeSettings(homeDir, logical, decoded.value, mat);
      if (currentPath && cand.filePath !== currentPath) {
        try {
          fs.unlinkSync(cand.filePath);
        } catch (_err) {
          // The new file is already written. A leftover old path is retried next launch.
        }
      }
    }
    return decoded.value;
  }
  return null;
}

export function migrateHomeSettings(
  homeDir: string,
  material?: ReleaseLockFile | null,
): { migrated: string[]; already: boolean } {
  const mat = material === undefined ? loadReleaseLock() : material;
  if (!mat) {
    return { migrated: [], already: false };
  }
  const migrated: string[] = [];
  let already = false;
  for (const logical of Object.keys(SETTINGS_PLAINTEXT)) {
    const existing = candidateSettings(homeDir, logical, mat).some((cand) =>
      fs.existsSync(cand.filePath),
    );
    if (existing) {
      already = true;
      readSettings(homeDir, logical, mat);
      continue;
    }
    const plainPath = path.join(homeDir, SETTINGS_PLAINTEXT[logical]);
    if (!fs.existsSync(plainPath)) {
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(plainPath, "utf8"));
      writeSettings(homeDir, logical, raw, mat);
      migrated.push(logical);
    } catch (_err) {
      // Retry next launch. Plaintext is left in place.
    }
  }
  return { migrated, already: already && migrated.length === 0 };
}

export function applyReleaseLockPythonEnv(env: NodeJS.ProcessEnv): void {
  const mat = loadReleaseLock();
  if (!mat) {
    return;
  }
  env.MASONJAR_RELEASE_KEY = mat.current.key;
  env.MASONJAR_RELEASE_KEY_ID = mat.current.id;
}

export function registryMacMessage(entry: Record<string, unknown>): string {
  const obj: Record<string, unknown> = {};
  for (const key of Object.keys(entry)
    .filter((name) => !HMAC_SKIP.has(name))
    .sort()) {
    obj[key] = entry[key];
  }
  return JSON.stringify(obj);
}

export function registryHmac(keyB64: string, entry: Record<string, unknown>): string {
  return crypto
    .createHmac("sha256", Buffer.from(keyB64, "base64"))
    .update(registryMacMessage(entry))
    .digest("hex");
}

export function stampRegistryEntry<T extends Record<string, unknown>>(
  entry: T,
  material?: ReleaseLockFile | null,
): T {
  const mat = material === undefined ? loadReleaseLock() : material;
  if (!mat) {
    return entry;
  }
  const next = { ...entry } as T & { masonjar_hmac?: string };
  delete next.masonjar_hmac;
  next.masonjar_hmac = registryHmac(mat.current.key, next as Record<string, unknown>);
  return next;
}

export function registryEntryTrusted(
  entry: Record<string, unknown> | null,
  material?: ReleaseLockFile | null,
): boolean {
  const mat = material === undefined ? loadReleaseLock() : material;
  if (!mat) {
    return true;
  }
  if (!entry || typeof entry.masonjar_hmac !== "string") {
    return false;
  }
  return registryHmac(mat.current.key, entry) === entry.masonjar_hmac;
}

export function writeDialogPrefsSnapshot(
  homeDir: string,
  dest: string,
  material?: ReleaseLockFile | null,
): void {
  const value = readSettings(homeDir, "dialog_preferences", material);
  const payload =
    value && typeof value === "object"
      ? value
      : { app_version: "", suppressed: {} };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export function absorbDialogPrefsSnapshot(
  homeDir: string,
  dest: string,
  material?: ReleaseLockFile | null,
): void {
  const mat = material === undefined ? loadReleaseLock() : material;
  if (!mat || !dest || !fs.existsSync(dest)) {
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(dest, "utf8"));
    writeSettings(homeDir, "dialog_preferences", raw, mat);
  } catch (_err) {
    // Retry next launch.
  }
}
