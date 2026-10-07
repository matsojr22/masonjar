"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOldInstallPatch = exports.tracePathForVersion = exports.armInstall = exports.findMasonJarInstalls = exports.userScanRoots = exports.shouldArmInstall = exports.readInstallIdentity = exports.isBelowMandatoryUpdate = exports.BOOTSTRAP_PRELUDE = exports.BOOTSTRAP_MARKER = void 0;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const forceUpdate = require("./masonjar_force_update.js");
exports.BOOTSTRAP_MARKER = "/* masonjar-force-update-bootstrap */";
exports.BOOTSTRAP_PRELUDE = exports.BOOTSTRAP_MARKER +
    "\n" +
    "try { process.env.MASONJAR_FORCE_UPDATE_AUTORUN = \"1\"; require(\"./masonjar_force_update.js\"); } catch (e) {}\n";
const MAX_DEPTH = 4;
const MAX_DIRS = 300;
const MAX_MS = 8000;
const SKIP_DIR_NAMES = new Set([
    "node_modules",
    "windows",
    "windowsapps",
    "$recycle.bin",
    ".git",
]);
function isBelowMandatoryUpdate(version) {
    return !!forceUpdate.isBelowMandatoryUpdate(version);
}
exports.isBelowMandatoryUpdate = isBelowMandatoryUpdate;
function readInstallIdentity(installRoot) {
    const pkgPath = path_1.default.join(installRoot, "resources", "app", "package.json");
    const exePath = path_1.default.join(installRoot, "masonjar.exe");
    if (!fs_1.default.existsSync(exePath) || !fs_1.default.existsSync(pkgPath)) {
        return null;
    }
    try {
        const raw = JSON.parse(fs_1.default.readFileSync(pkgPath, "utf8"));
        return {
            installRoot,
            version: String(raw.version || ""),
            name: String(raw.name || ""),
            productName: String(raw.productName || ""),
        };
    }
    catch (_err) {
        return null;
    }
}
exports.readInstallIdentity = readInstallIdentity;
function samePath(a, b) {
    if (!a || !b) {
        return false;
    }
    const left = path_1.default.resolve(a);
    const right = path_1.default.resolve(b);
    if (process.platform === "win32") {
        return left.toLowerCase() === right.toLowerCase();
    }
    return left === right;
}
function shouldArmInstall(identity, runningInstallRoot, mainJs) {
    if (samePath(identity.installRoot, runningInstallRoot || "")) {
        return false;
    }
    if (String(identity.name).toLowerCase() !== "masonjar") {
        return false;
    }
    if (String(identity.productName).toLowerCase() !== "mason jar") {
        return false;
    }
    if (!isBelowMandatoryUpdate(identity.version)) {
        return false;
    }
    if (mainJs && mainJs.includes(exports.BOOTSTRAP_MARKER)) {
        return false;
    }
    return true;
}
exports.shouldArmInstall = shouldArmInstall;
function skippedDir(name) {
    return SKIP_DIR_NAMES.has(name.toLowerCase());
}
function canDescend(dirPath) {
    try {
        const st = fs_1.default.lstatSync(dirPath);
        if (st.isSymbolicLink()) {
            return false;
        }
        return st.isDirectory();
    }
    catch (_err) {
        return false;
    }
}
function userScanRoots(home) {
    return ["Desktop", "Downloads", "Documents"]
        .map((name) => path_1.default.join(home, name))
        .filter((dir) => {
        if (!dir || dir.startsWith("\\\\")) {
            return false;
        }
        return canDescend(dir);
    });
}
exports.userScanRoots = userScanRoots;
function findMasonJarInstalls(roots, now = Date.now) {
    const found = [];
    const started = now();
    let visited = 0;
    const queue = [];
    for (const root of roots) {
        if (canDescend(root)) {
            queue.push({ dir: root, depth: 0 });
        }
    }
    while (queue.length > 0) {
        if (visited >= MAX_DIRS || now() - started > MAX_MS) {
            break;
        }
        const item = queue.shift();
        if (!item) {
            break;
        }
        visited += 1;
        let names = [];
        try {
            names = fs_1.default.readdirSync(item.dir);
        }
        catch (_err) {
            continue;
        }
        if (names.includes("masonjar.exe")) {
            const identity = readInstallIdentity(item.dir);
            if (identity) {
                found.push(item.dir);
            }
        }
        if (item.depth >= MAX_DEPTH) {
            continue;
        }
        for (const name of names) {
            if (skippedDir(name)) {
                continue;
            }
            const child = path_1.default.join(item.dir, name);
            if (canDescend(child)) {
                queue.push({ dir: child, depth: item.depth + 1 });
            }
        }
    }
    return found;
}
exports.findMasonJarInstalls = findMasonJarInstalls;
function armInstall(installRoot, bootstrapSource) {
    const appDir = path_1.default.join(installRoot, "resources", "app");
    const mainPath = path_1.default.join(appDir, "main.js");
    const backupPath = path_1.default.join(appDir, "main.js.bak-force-update");
    const destBootstrap = path_1.default.join(appDir, "masonjar_force_update.js");
    if (!fs_1.default.existsSync(mainPath) || !fs_1.default.existsSync(bootstrapSource)) {
        return false;
    }
    let mainJs = "";
    try {
        mainJs = fs_1.default.readFileSync(mainPath, "utf8");
    }
    catch (_err) {
        return false;
    }
    if (mainJs.includes(exports.BOOTSTRAP_MARKER)) {
        return false;
    }
    try {
        if (!fs_1.default.existsSync(backupPath)) {
            fs_1.default.copyFileSync(mainPath, backupPath);
        }
        fs_1.default.copyFileSync(bootstrapSource, destBootstrap);
        fs_1.default.writeFileSync(mainPath, exports.BOOTSTRAP_PRELUDE + mainJs, "utf8");
        return true;
    }
    catch (_err) {
        return false;
    }
}
exports.armInstall = armInstall;
function appendTrace(tracePath, line) {
    if (!tracePath) {
        return;
    }
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(tracePath), { recursive: true });
        fs_1.default.appendFileSync(tracePath, new Date().toISOString() + " " + line + "\n", "utf8");
    }
    catch (_err) {
        // Silent by design.
    }
}
function tracePathForVersion(version) {
    if (version !== "8.0.3") {
        return null;
    }
    return path_1.default.join(os_1.default.tmpdir(), "MasonJar", "old-install-patch.trace");
}
exports.tracePathForVersion = tracePathForVersion;
function runOldInstallPatch(opts) {
    const tracePath = opts.tracePath || null;
    try {
        appendTrace(tracePath, "start");
        const roots = userScanRoots(opts.homeDir);
        appendTrace(tracePath, "roots " + roots.length);
        const installs = findMasonJarInstalls(roots);
        appendTrace(tracePath, "found " + installs.length);
        for (const installRoot of installs) {
            const identity = readInstallIdentity(installRoot);
            if (!identity) {
                continue;
            }
            let mainJs = "";
            try {
                mainJs = fs_1.default.readFileSync(path_1.default.join(installRoot, "resources", "app", "main.js"), "utf8");
            }
            catch (_err) {
                appendTrace(tracePath, "skip unreadable " + installRoot);
                continue;
            }
            if (!shouldArmInstall(identity, opts.runningInstallRoot, mainJs)) {
                appendTrace(tracePath, "skip " + identity.version + " " + identity.productName);
                continue;
            }
            const armed = armInstall(installRoot, opts.bootstrapSource);
            appendTrace(tracePath, (armed ? "armed " : "arm-failed ") + installRoot);
        }
        appendTrace(tracePath, "done");
    }
    catch (_err) {
        appendTrace(tracePath, "stopped");
    }
}
exports.runOldInstallPatch = runOldInstallPatch;
