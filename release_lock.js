"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.absorbDialogPrefsSnapshot = exports.writeDialogPrefsSnapshot = exports.registryEntryTrusted = exports.stampRegistryEntry = exports.registryHmac = exports.registryMacMessage = exports.applyReleaseLockPythonEnv = exports.migrateHomeSettings = exports.readSettings = exports.writeSettings = exports.decryptJson = exports.encryptJson = exports.settingsPath = exports.derivedFileName = exports.allKeys = exports.keyBuffer = exports.hasReleaseLock = exports.resetReleaseLockCache = exports.loadReleaseLock = exports.SETTINGS_PLAINTEXT = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
exports.SETTINGS_PLAINTEXT = {
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
let cached;
function isElectron() {
    return !!(process.versions && process.versions.electron);
}
function validMaterial(raw) {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const current = raw.current;
    if (!current || typeof current.id !== "string" || typeof current.key !== "string") {
        return null;
    }
    if (Buffer.from(current.key, "base64").length !== 32) {
        return null;
    }
    const previous = Array.isArray(raw.previous)
        ? raw.previous
        : [];
    return { current, previous };
}
/** Packaged builds read release_lock.secret.js. Electron dev reads the private repo file. */
function loadReleaseLock(appDir) {
    if (cached !== undefined && !appDir) {
        return cached;
    }
    const dir = appDir || __dirname;
    let parsed = null;
    const secretJs = path_1.default.join(dir, "release_lock.secret.js");
    const devJson = path_1.default.join(dir, "development", "secrets", "release_lock.json");
    try {
        if (!isElectron() && !appDir) {
            parsed = null;
        }
        else if (fs_1.default.existsSync(secretJs)) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            parsed = validMaterial(require(secretJs));
        }
        else if (isElectron() && fs_1.default.existsSync(devJson)) {
            parsed = validMaterial(JSON.parse(fs_1.default.readFileSync(devJson, "utf8")));
        }
    }
    catch (_err) {
        parsed = null;
    }
    if (!appDir) {
        cached = parsed;
    }
    return parsed;
}
exports.loadReleaseLock = loadReleaseLock;
function resetReleaseLockCache() {
    cached = undefined;
}
exports.resetReleaseLockCache = resetReleaseLockCache;
function hasReleaseLock() {
    return !!loadReleaseLock();
}
exports.hasReleaseLock = hasReleaseLock;
function keyBuffer(rec) {
    return Buffer.from(rec.key, "base64");
}
exports.keyBuffer = keyBuffer;
function allKeys(material) {
    return [material.current].concat(material.previous || []);
}
exports.allKeys = allKeys;
function derivedFileName(keyB64, logical) {
    return (crypto_1.default.createHmac("sha256", Buffer.from(keyB64, "base64")).update(logical).digest("hex") +
        ".mjlock");
}
exports.derivedFileName = derivedFileName;
function settingsPath(homeDir, logical, material) {
    const mat = material === undefined ? loadReleaseLock() : material;
    if (!mat) {
        return null;
    }
    return path_1.default.join(homeDir, derivedFileName(mat.current.key, logical));
}
exports.settingsPath = settingsPath;
function encryptJson(rec, value) {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", keyBuffer(rec), iv);
    const enc = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ["MJ1", rec.id, iv.toString("base64"), enc.toString("base64"), tag.toString("base64")].join("\n");
}
exports.encryptJson = encryptJson;
function decryptJson(material, body) {
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
        const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", keyBuffer(rec), iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
        return { value: JSON.parse(plain), keyId };
    }
    catch (_err) {
        return null;
    }
}
exports.decryptJson = decryptJson;
function writeSettings(homeDir, logical, value, material) {
    const mat = material === undefined ? loadReleaseLock() : material;
    if (!mat) {
        return;
    }
    const filePath = settingsPath(homeDir, logical, mat);
    if (!filePath) {
        return;
    }
    fs_1.default.mkdirSync(path_1.default.dirname(filePath), { recursive: true });
    fs_1.default.writeFileSync(filePath, encryptJson(mat.current, value), "utf8");
}
exports.writeSettings = writeSettings;
function candidateSettings(homeDir, logical, mat) {
    return allKeys(mat).map((rec) => ({
        rec,
        filePath: path_1.default.join(homeDir, derivedFileName(rec.key, logical)),
    }));
}
function readSettings(homeDir, logical, material) {
    const mat = material === undefined ? loadReleaseLock() : material;
    if (!mat) {
        return null;
    }
    const currentPath = settingsPath(homeDir, logical, mat);
    for (const cand of candidateSettings(homeDir, logical, mat)) {
        if (!fs_1.default.existsSync(cand.filePath)) {
            continue;
        }
        let decoded = null;
        try {
            decoded = decryptJson(mat, fs_1.default.readFileSync(cand.filePath, "utf8"));
        }
        catch (_err) {
            decoded = null;
        }
        if (!decoded) {
            continue;
        }
        if (cand.rec.id !== mat.current.id || decoded.keyId !== mat.current.id) {
            writeSettings(homeDir, logical, decoded.value, mat);
            if (currentPath && cand.filePath !== currentPath) {
                try {
                    fs_1.default.unlinkSync(cand.filePath);
                }
                catch (_err) {
                    // The new file is already written. A leftover old path is retried next launch.
                }
            }
        }
        return decoded.value;
    }
    return null;
}
exports.readSettings = readSettings;
function migrateHomeSettings(homeDir, material) {
    const mat = material === undefined ? loadReleaseLock() : material;
    if (!mat) {
        return { migrated: [], already: false };
    }
    const migrated = [];
    let already = false;
    for (const logical of Object.keys(exports.SETTINGS_PLAINTEXT)) {
        const existing = candidateSettings(homeDir, logical, mat).some((cand) => fs_1.default.existsSync(cand.filePath));
        if (existing) {
            already = true;
            readSettings(homeDir, logical, mat);
            continue;
        }
        const plainPath = path_1.default.join(homeDir, exports.SETTINGS_PLAINTEXT[logical]);
        if (!fs_1.default.existsSync(plainPath)) {
            continue;
        }
        try {
            const raw = JSON.parse(fs_1.default.readFileSync(plainPath, "utf8"));
            writeSettings(homeDir, logical, raw, mat);
            migrated.push(logical);
        }
        catch (_err) {
            // Retry next launch. Plaintext is left in place.
        }
    }
    return { migrated, already: already && migrated.length === 0 };
}
exports.migrateHomeSettings = migrateHomeSettings;
function applyReleaseLockPythonEnv(env) {
    const mat = loadReleaseLock();
    if (!mat) {
        return;
    }
    env.MASONJAR_RELEASE_KEY = mat.current.key;
    env.MASONJAR_RELEASE_KEY_ID = mat.current.id;
}
exports.applyReleaseLockPythonEnv = applyReleaseLockPythonEnv;
function registryMacMessage(entry) {
    const obj = {};
    for (const key of Object.keys(entry)
        .filter((name) => !HMAC_SKIP.has(name))
        .sort()) {
        obj[key] = entry[key];
    }
    return JSON.stringify(obj);
}
exports.registryMacMessage = registryMacMessage;
function registryHmac(keyB64, entry) {
    return crypto_1.default
        .createHmac("sha256", Buffer.from(keyB64, "base64"))
        .update(registryMacMessage(entry))
        .digest("hex");
}
exports.registryHmac = registryHmac;
function stampRegistryEntry(entry, material) {
    const mat = material === undefined ? loadReleaseLock() : material;
    if (!mat) {
        return entry;
    }
    const next = Object.assign({}, entry);
    delete next.masonjar_hmac;
    next.masonjar_hmac = registryHmac(mat.current.key, next);
    return next;
}
exports.stampRegistryEntry = stampRegistryEntry;
function registryEntryTrusted(entry, material) {
    const mat = material === undefined ? loadReleaseLock() : material;
    if (!mat) {
        return true;
    }
    if (!entry || typeof entry.masonjar_hmac !== "string") {
        return false;
    }
    return registryHmac(mat.current.key, entry) === entry.masonjar_hmac;
}
exports.registryEntryTrusted = registryEntryTrusted;
function writeDialogPrefsSnapshot(homeDir, dest, material) {
    const value = readSettings(homeDir, "dialog_preferences", material);
    const payload = value && typeof value === "object"
        ? value
        : { app_version: "", suppressed: {} };
    fs_1.default.mkdirSync(path_1.default.dirname(dest), { recursive: true });
    fs_1.default.writeFileSync(dest, JSON.stringify(payload, null, 2) + "\n", "utf8");
}
exports.writeDialogPrefsSnapshot = writeDialogPrefsSnapshot;
function absorbDialogPrefsSnapshot(homeDir, dest, material) {
    const mat = material === undefined ? loadReleaseLock() : material;
    if (!mat || !dest || !fs_1.default.existsSync(dest)) {
        return;
    }
    try {
        const raw = JSON.parse(fs_1.default.readFileSync(dest, "utf8"));
        writeSettings(homeDir, "dialog_preferences", raw, mat);
    }
    catch (_err) {
        // Retry next launch.
    }
}
exports.absorbDialogPrefsSnapshot = absorbDialogPrefsSnapshot;
