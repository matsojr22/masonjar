"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.installRuntimeGuard = exports.sitePackagesDir = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const GUARD_SOURCE = "masonjar_runtime_guard.py";
function sitePackagesDir(benv) {
    if (!benv) {
        return null;
    }
    if (process.platform === "win32") {
        const win = path_1.default.join(benv, "Lib", "site-packages");
        return fs_1.default.existsSync(win) ? win : null;
    }
    const lib = path_1.default.join(benv, "lib");
    if (!fs_1.default.existsSync(lib)) {
        return null;
    }
    try {
        const names = fs_1.default.readdirSync(lib);
        for (const name of names) {
            if (!name.startsWith("python")) {
                continue;
            }
            const site = path_1.default.join(lib, name, "site-packages");
            if (fs_1.default.existsSync(site)) {
                return site;
            }
        }
    }
    catch (_err) {
        return null;
    }
    return null;
}
exports.sitePackagesDir = sitePackagesDir;
function sitecustomizeSource(electronPrefixes) {
    const listed = electronPrefixes
        .filter((item) => !!item)
        .map((item) => JSON.stringify(item))
        .join(", ");
    return ("# Rewritten by Mason Jar on launch.\n" +
        "import masonjar_runtime_guard as _mj_guard\n" +
        "_mj_guard.enforce_or_exit(electron_prefixes=[" +
        listed +
        "])\n");
}
/** Copy the guard into benv site-packages and rewrite sitecustomize.py. */
function installRuntimeGuard(opts) {
    const site = sitePackagesDir(opts.benv);
    if (!site || !fs_1.default.existsSync(opts.guardSourcePath)) {
        return false;
    }
    try {
        fs_1.default.copyFileSync(opts.guardSourcePath, path_1.default.join(site, GUARD_SOURCE));
        fs_1.default.writeFileSync(path_1.default.join(site, "sitecustomize.py"), sitecustomizeSource(opts.electronPrefixes), "utf8");
        return true;
    }
    catch (_err) {
        return false;
    }
}
exports.installRuntimeGuard = installRuntimeGuard;
