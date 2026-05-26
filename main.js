"use strict";
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
/** Ensure packaged / relocated app roots can resolve production dependencies. */
const path = require("path");
const fs = require("fs");
const Module = require("module");
(function ensureAppNodeModulePaths() {
    const roots = [__dirname];
    const resourcesPath = process
        .resourcesPath;
    if (resourcesPath) {
        roots.push(path.join(resourcesPath, "app"));
    }
    const globalPaths = Module.globalPaths;
    for (const root of roots) {
        const nodeModules = path.join(root, "node_modules");
        if (fs.existsSync(nodeModules) && !globalPaths.includes(nodeModules)) {
            globalPaths.unshift(nodeModules);
        }
    }
})();
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { promisify } = require("util");
const { PythonShell } = require("python-shell");
const tar = require("tar");
const mv = promisify(fs.rename);
const exec = promisify(require("child_process").exec);
const stream = require("stream");
const https = require("https");
const semver = require("semver");
const serverFetch = require("node-fetch");
var appDir = app.getAppPath();
var win = null;
var logWin = null;
/** When true, log lines queue but the window stays hidden until user opens it or an error forces show. */
var logDismissedByUser = true;
var isQuitting = false;
/** Batch console mirroring to the log window to avoid IPC/DOM floods. */
const LOG_UI_FLUSH_MS = 150;
const LOG_UI_MAX_QUEUE = 4000;
const LOG_UI_CHUNK_LINES = 350;
let logUiQueue = [];
let logUiFlushTimer = null;
/** New id each app launch — log window clears when this differs from stored session. */
const appLogSessionId = `mj-${process.pid}-${Date.now()}`;
function flushLogUiQueue() {
    logUiFlushTimer = null;
    if (!logWin || !logWin.webContents || logUiQueue.length === 0) {
        return;
    }
    try {
        const take = Math.min(LOG_UI_CHUNK_LINES, logUiQueue.length);
        const chunk = logUiQueue.splice(0, take);
        logWin.webContents.send("log", chunk.join("\n"));
    }
    catch (_error) {
        // log window was closed
    }
    if (logUiQueue.length > 0) {
        logUiFlushTimer = setTimeout(flushLogUiQueue, LOG_UI_FLUSH_MS);
    }
}
function queueLogLineForUi(line) {
    logUiQueue.push(line);
    if (logUiQueue.length > LOG_UI_MAX_QUEUE) {
        logUiQueue.splice(0, logUiQueue.length - LOG_UI_MAX_QUEUE);
    }
    if (!logUiFlushTimer) {
        logUiFlushTimer = setTimeout(flushLogUiQueue, LOG_UI_FLUSH_MS);
    }
}
function drainLogUiQueueForQuit() {
    if (logUiFlushTimer) {
        clearTimeout(logUiFlushTimer);
        logUiFlushTimer = null;
    }
    if (!logWin || !logWin.webContents) {
        logUiQueue = [];
        return;
    }
    while (logUiQueue.length > 0) {
        try {
            const chunk = logUiQueue.splice(0, LOG_UI_CHUNK_LINES);
            logWin.webContents.send("log", chunk.join("\n"));
        }
        catch (_error) {
            logUiQueue = [];
            return;
        }
    }
}
var log = console.log;
console.log = function () {
    var args = Array.from(arguments);
    let timestamp = new Date().toLocaleString();
    let prefix = `[${timestamp}]`;
    let message = [prefix, ...args];
    log.apply(console, message);
    try {
        queueLogLineForUi(message.join(" "));
    }
    catch (_error) {
        // ignore
    }
};
app.on("before-quit", () => {
    drainLogUiQueueForQuit();
});
const BRANDING = {
    PRODUCT_NAME: "Mason Jar",
    HOME_DIR: ".masonjar",
    LEGACY_HOME_DIR: ".belljar",
    LOG_FILE: "masonjar.log",
    GITHUB_REPO: "matsojr22/masonjar",
};
const LEGACY_HOME_COPY_ENTRIES = [
    "python",
    "benv",
    "models",
    "embeddings",
    "nrrd",
    "manifest.json",
];
function resolveHomeDir() {
    return path.join(app.getPath("home"), BRANDING.HOME_DIR);
}
function legacyHomePath() {
    return path.join(app.getPath("home"), BRANDING.LEGACY_HOME_DIR);
}
function envIsReady(homePath) {
    return (fs.existsSync(path.join(homePath, "python")) ||
        fs.existsSync(path.join(homePath, "benv")));
}
function needsLegacyHomeMigration() {
    return !envIsReady(homeDir) && envIsReady(legacyHomePath());
}
function copyLegacyHomeEntries(win) {
    return __awaiter(this, void 0, void 0, function* () {
        const legacyDir = legacyHomePath();
        for (const entry of LEGACY_HOME_COPY_ENTRIES) {
            const src = path.join(legacyDir, entry);
            if (!fs.existsSync(src)) {
                continue;
            }
            const dest = path.join(homeDir, entry);
            win.webContents.send("updateStatus", `Copying ${entry} from Bell Jar…`);
            yield fs.promises.cp(src, dest, { recursive: true });
        }
    });
}
function maybeMigrateLegacyHome(win) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!needsLegacyHomeMigration()) {
            return true;
        }
        const choice = dialog.showMessageBoxSync(win, {
            type: "question",
            message: "Mason Jar uses ~/.masonjar (separate from Bell Jar's ~/.belljar).",
            detail: "Copy your existing Bell Jar environment to save re-downloading ~20GB, or install fresh into ~/.masonjar.",
            buttons: ["Copy from Bell Jar", "Fresh install", "Cancel"],
            defaultId: 0,
            cancelId: 2,
        });
        if (choice === 2) {
            app.quit();
            return false;
        }
        if (choice === 1) {
            console.log("Using new ~/.masonjar; ~/.belljar left untouched.");
            return true;
        }
        try {
            yield copyLegacyHomeEntries(win);
            return true;
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error("Legacy home copy failed:", error);
            createLogFile(`Legacy home copy failed: ${msg}\n`);
            dialog.showMessageBoxSync(win, {
                type: "error",
                message: "Could not copy Bell Jar environment",
                detail: msg,
            });
            app.quit();
            return false;
        }
    });
}
// Path variables for easy management of execution
const homeDir = resolveHomeDir();
// Mod is the proper path to the python/pip binary
var mod = process.platform === "win32" ? "python/" : "python/bin/";
var envMod = process.platform === "win32" ? "Scripts/" : "bin/";
// Make a constant with the cwd for running python commands
const envPath = path.join(homeDir, "benv");
const pythonPath = path.join(homeDir, mod);
const envPythonPath = path.join(envPath, envMod);
// Command choses wether to use the exe (windows) or alias (unix based)
var pyCommand = process.platform === "win32" ? "python.exe" : "./python3";
// Path to our python files
const pyScriptsPath = path.join(appDir, "/py");
const CURRENT_VERSION_TAG = getVersion();
const GITHUB_API_RELEASES = `https://api.github.com/repos/${BRANDING.GITHUB_REPO}/releases/latest`;
function loadMenuAndCheckUpdates(targetWin) {
    targetWin.loadFile("pages/menu.html");
    targetWin.webContents.once("did-finish-load", () => {
        const url = targetWin.webContents.getURL();
        if (url.includes("menu.html")) {
            checkForUpdates(targetWin);
        }
    });
}
function appendSliceListArg(args, data, index) {
    if (data.length > index && data[index] != null) {
        const sliceListPath = String(data[index]).trim();
        if (sliceListPath.length > 0) {
            // Long options must be separate argv entries (or --slice-list=path) for argparse.
            args.push("--slice-list", sliceListPath);
        }
    }
}
/** CZI scripts: separate -b/-j argv tokens so Windows paths with spaces parse correctly. */
function appendCziPathArgs(args, bundleRoot, configPath) {
    args.push("-b", String(bundleRoot || "").trim());
    if (configPath != null && String(configPath).trim().length > 0) {
        args.push("-j", String(configPath).trim());
    }
}
function appendCziInputArg(args, inputDir) {
    args.push("-i", String(inputDir || "").trim());
}
/** Separate flag and path argv tokens so Windows paths with spaces parse correctly in argparse. */
function appendFlagPathArg(args, flag, value) {
    const v = String(value !== null && value !== void 0 ? value : "").trim();
    if (v.length > 0) {
        args.push(flag, v);
    }
}
function checkForUpdates(parentWin) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const response = yield serverFetch(GITHUB_API_RELEASES, {
                headers: {
                    "User-Agent": `MasonJar/${CURRENT_VERSION_TAG}`,
                    Accept: "application/vnd.github+json",
                },
            });
            // No published releases yet — normal for a new fork; do not alarm the user.
            if (response.status === 404) {
                console.log("No GitHub releases published yet; skipping update check.");
                return;
            }
            if (!response.ok) {
                console.warn(`Update check: GitHub API returned ${response.status}; skipping.`);
                return;
            }
            const data = yield response.json();
            const latestVersionTag = data.tag_name;
            const latestCoerced = latestVersionTag
                ? semver.coerce(latestVersionTag)
                : null;
            const currentCoerced = semver.coerce(CURRENT_VERSION_TAG);
            if (latestCoerced &&
                currentCoerced &&
                semver.gt(latestCoerced, currentCoerced)) {
                const userResponse = yield dialog.showMessageBox(parentWin || undefined, {
                    type: "info",
                    title: "Update Available",
                    message: "A new version of Mason Jar is available.",
                    detail: `The latest version is ${latestCoerced.version}. Would you like to download it?`,
                    buttons: ["Yes", "No"],
                    defaultId: 0,
                    cancelId: 1,
                });
                if (userResponse.response === 0 && data.html_url) {
                    shell.openExternal(data.html_url);
                }
            }
            else {
                console.log("No updates available.");
            }
        }
        catch (error) {
            // Network or parse errors should not block launch with a modal dialog.
            console.warn("Failed to check for updates:", error);
        }
    });
}
// Promise version of file moving
function move(o, t) {
    return new Promise((resolve, reject) => {
        // move o to t, wrapped as promise
        const original = o;
        const target = t;
        mv(original, target).then(() => {
            resolve(0);
        });
    });
}
function createLogFile(message) {
    const logPath = path.join(homeDir, BRANDING.LOG_FILE);
    fs.appendFileSync(logPath, message);
}
// Get files asynchonously
function downloadFile(url, target, win) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(target, { highWaterMark: 64 * 1024 });
        // get the file, update the user loading screen with text on progress
        const progress = (receivedBytes, totalBytes) => {
            const percentage = (receivedBytes * 100) / totalBytes;
            if (percentage > 0) {
                win.webContents.send("updateStatus", {
                    message: `Downloading ${target
                        .split("/")
                        .pop()}... ${percentage.toFixed(0)}%`,
                    timestamp: Date.now(),
                });
            }
        };
        const dummy = new stream.PassThrough();
        const request = https.get(url, (response) => {
            // create a dummy stream so we can update the user on progress
            var receivedBytes = 0;
            var totalBytes = parseInt(response.headers["content-length"]);
            response.pipe(dummy);
            let lastUpdateTimestamp = Date.now();
            dummy.on("data", (chunk) => {
                receivedBytes += chunk.length;
                const currentTimestamp = Date.now();
                if (currentTimestamp - lastUpdateTimestamp >= 1000) {
                    // 1000 ms = 1 second
                    progress(receivedBytes, totalBytes);
                    lastUpdateTimestamp = currentTimestamp;
                }
            });
            // pipe the response to the file
            response.pipe(file);
            file.on("finish", () => {
                file.close();
                win.webContents.send("updateStatus", `Extracting ${target.split("/").pop()}...`);
                resolve(true);
            });
        });
    });
}
// Delete a file safely
function deleteFile(file) {
    return new Promise((resolve, reject) => {
        fs.unlinkSync(file);
        resolve(true);
    });
}
function getVersion() {
    // get version from package.json
    const packageJson = require(path.join(appDir, "package.json"));
    return packageJson.version;
}
function setupPython(win) {
    const bucketParentPath = "https://storage.googleapis.com/belljar_updates";
    const linuxURL = `${bucketParentPath}/cpython-3.10.13+20230826-x86_64-unknown-linux-gnu-install_only.tar.gz`;
    const winURL = `${bucketParentPath}/cpython-3.10.13+20230826-x86_64-pc-windows-msvc-shared-install_only.tar.gz`;
    const osxURL = `${bucketParentPath}/cpython-3.10.13+20230826-aarch64-apple-darwin-install_only.tar.gz`;
    const osxIntelURL = `${bucketParentPath}/cpython-3.10.13+20230826-x86_64-apple-darwin-install_only.tar.gz`;
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(homeDir, "python"))) {
            win.webContents.send("updateStatus", "Settting up python...");
            switch (process.platform) {
                case "win32":
                    // Download and extract python to the home directory
                    downloadFile(winURL, path.join(homeDir, "cpython-3.10.13+20230826-x86_64-pc-windows-msvc-shared-install_only.tar.gz"), win)
                        .then(() => {
                        // Extract the tarball
                        tar
                            .x({
                            cwd: homeDir,
                            preservePaths: true,
                            file: path.join(homeDir, "cpython-3.10.13+20230826-x86_64-pc-windows-msvc-shared-install_only.tar.gz"),
                        })
                            .then(() => {
                            win.webContents.send("updateStatus", "Extracted python...");
                            resolve(true);
                        });
                    })
                        .catch((err) => {
                        console.log(err);
                    });
                    break;
                case "linux":
                    downloadFile(linuxURL, path.join(homeDir, "cpython-3.10.13+20230826-x86_64-unknown-linux-gnu-install_only.tar.gz"), win).then(() => {
                        tar
                            .x({
                            cwd: homeDir,
                            preservePaths: true,
                            file: path.join(homeDir, "cpython-3.10.13+20230826-x86_64-unknown-linux-gnu-install_only.tar.gz"),
                        })
                            .then(() => {
                            win.webContents.send("updateStatus", "Extracted python...");
                            resolve(true);
                        });
                    });
                    break;
                case "darwin":
                    // Check if we are on intel or arm
                    if (process.arch === "x64") {
                        downloadFile(osxIntelURL, path.join(homeDir, "cpython-3.10.13+20230826-x86_64-apple-darwin-install_only.tar.gz"), win).then(() => {
                            tar
                                .x({
                                cwd: homeDir,
                                preservePaths: true,
                                file: path.join(homeDir, "cpython-3.10.13+20230826-x86_64-apple-darwin-install_only.tar.gz"),
                            })
                                .then(() => {
                                win.webContents.send("updateStatus", "Extracted python...");
                                resolve(true);
                            });
                        });
                    }
                    else {
                        downloadFile(osxURL, path.join(homeDir, "cpython-3.10.13+20230826-aarch64-apple-darwin-install_only.tar.gz"), win).then(() => {
                            tar
                                .x({
                                cwd: homeDir,
                                preservePaths: true,
                                file: path.join(homeDir, "cpython-3.10.13+20230826-aarch64-apple-darwin-install_only.tar.gz"),
                            })
                                .then(() => {
                                win.webContents.send("updateStatus", "Extracted python...");
                                resolve(true);
                            });
                        });
                    }
                    break;
                default:
                    // If we don't have a supported platform, just resolve
                    resolve(true);
                    break;
            }
        }
        else {
            // Double check that the environment is setup by confirming if the benv folder exists
            if (!fs.existsSync(envPath)) {
                resolve(true);
            }
            else {
                resolve(false);
            }
        }
    });
}
// Download the required tar files from the bucket
function downloadResources(win, fresh) {
    // Download the tar files into the homeDir and extract them to their respective folders
    const currnet_versions = {
        nrrd: "v91",
        models: "v952",
        embeddings: "v6",
    };
    return new Promise((resolve, reject) => {
        const bucketParentPath = "https://storage.googleapis.com/belljar_updates";
        const embeddingsLink = `${bucketParentPath}/embeddings-v6.tar.gz`;
        const modelsLink = `${bucketParentPath}/models-v10.tar.gz`;
        const nrrdLink = `${bucketParentPath}/nrrd-v91.tar.gz`;
        const requiredDirs = ["models", "embeddings", "nrrd"];
        if (!fresh) {
            var downloading = [];
            var total = 0;
            // check the manifest.json and compare versions
            // if the versions are different, delete the dir and download
            const manifestPath = path.join(homeDir, "manifest.json");
            // Make sure the manifest exists and if not lets make one and then delte all these dirs and redownload
            if (!fs.existsSync(manifestPath)) {
                // Create manifest from current versions
                fs.writeFileSync(manifestPath, JSON.stringify(currnet_versions, null, 2));
                // Delete existing
                downloading.push("models");
                downloading.push("embeddings");
                downloading.push("nrrd");
            }
            const manifest = require(manifestPath);
            // check if each directory exists and its not empty
            for (let i = 0; i < requiredDirs.length; i++) {
                const dir = requiredDirs[i];
                if (!fs.existsSync(path.join(homeDir, dir)) ||
                    fs.readdirSync(path.join(homeDir, dir)).length === 0) {
                    // make sure we are not already downloading this dir
                    if (downloading.indexOf(dir) === -1) {
                        downloading.push(dir);
                    }
                }
            }
            for (const [key, value] of Object.entries(currnet_versions)) {
                if (manifest[key] !== value) {
                    downloading.push(key);
                }
            }
            if (downloading.indexOf("models") === -1) {
                // Check in the models dir if chaosdruid.pt exists do nothing, otherwise delete the dir and download
                if (!fs.existsSync(path.join(homeDir, "models/chaosdruid.pt"))) {
                    downloading.push("models");
                    // Delete existing
                    if (fs.existsSync(path.join(homeDir, "models"))) {
                        fs.rm(path.join(homeDir, "models"), { recursive: true });
                    }
                }
            }
            // Delete and update manifest
            if (downloading.length > 0) {
                fs.writeFileSync(manifestPath, JSON.stringify(currnet_versions, null, 2));
            }
            downloading.reduce((promiseChain, dir, i) => {
                return promiseChain
                    .then(() => {
                    win.webContents.send("updateStatus", `Redownloading ${dir}...this may take a while`);
                    if (fs.existsSync(path.join(homeDir, dir))) {
                        fs.rmSync(path.join(homeDir, dir), { recursive: true });
                    }
                    let downloadPath = "";
                    switch (dir) {
                        case "models":
                            downloadPath = modelsLink;
                            break;
                        case "embeddings":
                            downloadPath = embeddingsLink;
                            break;
                        case "nrrd":
                            downloadPath = nrrdLink;
                            break;
                        default:
                            break;
                    }
                    return downloadFile(downloadPath, path.join(homeDir, `${dir}.tar.gz`), win);
                })
                    .then(() => {
                    return tar.x({
                        cwd: homeDir,
                        preservePaths: true,
                        file: path.join(homeDir, `${dir}.tar.gz`),
                    });
                })
                    .then(() => {
                    return deleteFile(path.join(homeDir, `${dir}.tar.gz`));
                })
                    .then(() => {
                    win.webContents.send("updateStatus", `Downloaded ${dir}`);
                    total++;
                    if (downloading.length === total) {
                        resolve(true);
                    }
                });
            }, Promise.resolve());
            if (downloading.length === 0) {
                resolve(true);
            }
        }
        else {
            // Since we are doing a fresh install, we need to ensure no remnants of the old install are left or partially downloaded
            // Check if these directories exist, if they do, we don't need to download any files
            let allDirsExist = true;
            requiredDirs.forEach((dir) => {
                if (!fs.existsSync(path.join(homeDir, dir))) {
                    allDirsExist = false;
                }
            });
            // Creat the manifest
            fs.writeFileSync(path.join(homeDir, "manifest.json"), JSON.stringify(currnet_versions, null, 2));
            if (!allDirsExist) {
                // Something is missing, delete everything and download again
                requiredDirs.forEach((dir) => {
                    if (fs.existsSync(path.join(homeDir, dir))) {
                        fs.rmSync(path.join(homeDir, dir), { recursive: true });
                    }
                });
                // Download the embeddings
                downloadFile(embeddingsLink, path.join(homeDir, "embeddings.tar.gz"), win).then(() => {
                    // Extract the embeddings
                    tar
                        .x({
                        cwd: homeDir,
                        preservePaths: true,
                        file: path.join(homeDir, "embeddings.tar.gz"),
                    })
                        .then(() => {
                        // Delete the tar file
                        deleteFile(path.join(homeDir, "embeddings.tar.gz")).then(() => {
                            // Download the models
                            downloadFile(modelsLink, path.join(homeDir, "models.tar.gz"), win).then(() => {
                                // Extract the models
                                tar
                                    .x({
                                    cwd: homeDir,
                                    preservePaths: true,
                                    file: path.join(homeDir, "models.tar.gz"),
                                })
                                    .then(() => {
                                    // Delete the tar file
                                    deleteFile(path.join(homeDir, "models.tar.gz")).then(() => {
                                        // Download the nrrd
                                        downloadFile(nrrdLink, path.join(homeDir, "nrrd.tar.gz"), win).then(() => {
                                            // Extract the nrrd
                                            tar
                                                .x({
                                                cwd: homeDir,
                                                preservePaths: true,
                                                file: path.join(homeDir, "nrrd.tar.gz"),
                                            })
                                                .then(() => {
                                                // Delete the tar file
                                                deleteFile(path.join(homeDir, "nrrd.tar.gz")).then(() => {
                                                    resolve(true);
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            }
            else {
                resolve(true);
            }
        }
    });
}
// Creates the venv and installs the dependencies
function setupEnvironment(win) {
    if (!fs.existsSync(envPath)) {
        // We have not created the venv yet, so we probably don't have the models, etc. either
        win.webContents.send("updateStatus", "Preparing to download require files...");
        downloadResources(win, true)
            .then(() => {
            win.webContents.send("updateStatus", "Installing venv...");
            return installVenv();
        })
            .then(({ stdout, stderr }) => {
            console.log(stdout);
            win.webContents.send("updateStatus", "Creating venv...");
            return createVenv();
        })
            .then(({ stdout, stderr }) => {
            console.log(stdout);
            win.webContents.send("updateStatus", "Installing packages...");
            return installDeps();
        })
            .then(({ stdout, stderr }) => {
            console.log(stdout);
            win.webContents.send("updateStatus", "Setup complete!");
            loadMenuAndCheckUpdates(win);
        })
            .catch((error) => {
            console.log("An error occurred during setup:", error);
            win.webContents.send("updateStatus", "An error occurred during setup.");
        });
    }
    // Install venv package
    function installVenv() {
        return __awaiter(this, void 0, void 0, function* () {
            const { stdout, stderr } = yield exec(`${pyCommand} -m pip install --user virtualenv`, { cwd: pythonPath });
            return { stdout, stderr };
        });
    }
    // Create venv
    function createVenv() {
        return __awaiter(this, void 0, void 0, function* () {
            const envDir = process.platform === "win32" ? "../benv" : "../../benv";
            const { stdout, stderr } = yield exec(`${pyCommand} -m venv ${envDir}`, {
                cwd: pythonPath,
            });
            return { stdout, stderr };
        });
    }
    // Install pip packages
    function installDeps() {
        return __awaiter(this, void 0, void 0, function* () {
            let reqs = path.join(appDir, "py/requirements.txt");
            const { stdout, stderr } = yield exec(`${pyCommand} -m pip install -r "${reqs}" --use-pep517`, { cwd: envPythonPath });
            return { stdout, stderr };
        });
    }
}
// Install the latest dependencies, could have changed after an update
function updatePythonDependencies(win) {
    return new Promise((resolve, reject) => {
        win.webContents.send("updateStatus", "Updating packages...");
        // Run pip install -r requirements.txt --no-cache-dir to update the packages
        let reqsPath = path.join(appDir, "py/requirements.txt");
        exec(`${pyCommand} -m pip install -r "${reqsPath}" --no-cache-dir  --use-pep517`, { cwd: envPythonPath })
            .then(({ stdout, stderr }) => {
            console.log(stdout);
            win.webContents.send("updateStatus", "Update complete!");
            resolve(true);
        })
            .catch((error) => {
            console.log(error);
            createLogFile(error);
            createLogFile("Failed to update python dependencies");
            createLogFile(appDir);
            reject(error);
        });
    });
}
// Ensure all required directories exist and if not, download them
function fixMissingDirectories(win) {
    return new Promise((resolve, reject) => {
        win.webContents.send("updateStatus", "Checking for updatess...");
        downloadResources(win, false).then(() => {
            resolve(true);
        });
    });
}
// Makes the local user writable folder
function checkLocalDir() {
    if (!fs.existsSync(homeDir)) {
        fs.mkdirSync(homeDir, {
            recursive: true,
        });
    }
}
function createWindow() {
    const win = new BrowserWindow({
        width: 1250,
        height: 750,
        show: false,
        resizable: true,
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.once("ready-to-show", () => {
        if (process.platform === "darwin" || process.platform === "win32") {
            win.maximize();
        }
        win.show();
    });
    // Start with the load screen
    win.loadFile("pages/loading.html");
    return win;
}
function createLogWindow() {
    const win = new BrowserWindow({
        width: 500,
        height: 250,
        resizable: true,
        autoHideMenuBar: true,
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        closeable: true,
    });
    win.loadFile("pages/log.html");
    win.webContents.once("did-finish-load", () => {
        try {
            win.webContents.send("resetLogSession", appLogSessionId);
        }
        catch (_error) {
            // window closed during load
        }
    });
    win.on("closed", () => {
        logWin = null;
        logDismissedByUser = true;
    });
    return win;
}
function getLogWindowState() {
    const exists = logWin != null && !logWin.isDestroyed();
    return {
        visible: exists && logWin.isVisible(),
        dismissed: logDismissedByUser,
    };
}
function replyLogWindowState(event) {
    event.sender.send("logWindowState", getLogWindowState());
}
function ensureLogWindowVisible(opts) {
    const force = !!(opts && opts.force);
    if (!logWin || logWin.isDestroyed()) {
        logWin = createLogWindow();
    }
    if (force) {
        logDismissedByUser = false;
    }
    if (!force && logDismissedByUser) {
        return false;
    }
    if (!logWin.isVisible()) {
        logWin.show();
    }
    logWin.focus();
    return true;
}
function hideLogWindowByUser() {
    logDismissedByUser = true;
    if (logWin && !logWin.isDestroyed()) {
        logWin.hide();
    }
}
function reportPythonFailure(pyFail) {
    if (!pyFail) {
        return;
    }
    ensureLogWindowVisible({ force: true });
    queueLogLineForUi(pyFail);
    console.error(pyFail);
}
app.on("ready", () => {
    logUiQueue = [];
    if (logUiFlushTimer) {
        clearTimeout(logUiFlushTimer);
        logUiFlushTimer = null;
    }
    win = createWindow();
    // Uncomment if you want tools on launch
    // win.webContents.toggleDevTools()
    win.on("close", function (e) {
        const choice = dialog.showMessageBoxSync(win, {
            type: "question",
            buttons: ["Yes", "Cancel"],
            title: `Quit ${BRANDING.PRODUCT_NAME}?`,
            message: `Are you sure you want to quit ${BRANDING.PRODUCT_NAME}? Quitting will kill all running processes.`,
        });
        if (choice === 1) {
            e.preventDefault();
        }
        else {
            try {
                if (logWin && !logWin.isDestroyed()) {
                    logWin.webContents.send("savelogs", []);
                    logWin.close();
                }
            }
            catch (error) {
                // do nothing window was closed
            }
        }
    });
    win.webContents.once("did-finish-load", () => {
        checkLocalDir();
        void maybeMigrateLegacyHome(win).then((ok) => {
            if (!ok) {
                return;
            }
            setupPython(win)
                .then((installed) => {
                if (installed) {
                    setupEnvironment(win);
                }
                else {
                    updatePythonDependencies(win).then(() => {
                        fixMissingDirectories(win).then(() => {
                            loadMenuAndCheckUpdates(win);
                        });
                    });
                }
            })
                .catch((error) => {
                console.log(error);
            });
        });
    });
});
app.whenReady().then(() => {
    app.on("activate", function () {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
app.on("window-all-closed", function () {
    app.quit();
});
ipcMain.on("checkForUpdates", (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    checkForUpdates(parent || win);
});
ipcMain.on("getVersion", (event) => {
    event.sender.send("version", getVersion());
});
function parseDialogArg(data) {
    if (typeof data === "string") {
        return { tag: data };
    }
    if (data && typeof data === "object") {
        const tag = data.tag != null ? String(data.tag) : String(data);
        const defaultPath = typeof data.defaultPath === "string" ? data.defaultPath : undefined;
        return { tag, defaultPath };
    }
    return { tag: String(data) };
}
function openDialogOptions(properties, defaultPath) {
    const options = { properties };
    if (defaultPath && fs.existsSync(defaultPath)) {
        options.defaultPath = defaultPath;
    }
    return options;
}
/** Prefer the BrowserWindow that sent the IPC (menu/tools), not getFocusedWindow() (often the log). */
function dialogParentWindow(event) {
    const fromSender = BrowserWindow.fromWebContents(event.sender);
    if (fromSender && !fromSender.isDestroyed()) {
        return fromSender;
    }
    if (win && !win.isDestroyed()) {
        return win;
    }
    const focused = BrowserWindow.getFocusedWindow();
    return focused && !focused.isDestroyed() ? focused : null;
}
function directoryDialogOptions(tag, defaultPath) {
    const options = openDialogOptions(["openDirectory"], defaultPath);
    if (tag === "projectBundle") {
        options.title = `Open ${BRANDING.PRODUCT_NAME} project`;
        options.message =
            "Select the project folder (e.g. M528_masonjar) that contains its .masonjar project file or legacy project.belljar.";
    }
    else if (tag === "newProjectBundle") {
        options.title = `New ${BRANDING.PRODUCT_NAME} project location`;
        options.message =
            "Choose a parent folder. Mason Jar will create Name_masonjar/ with Name.masonjar and data/ inside.";
    }
    else if (tag === "brainRoot") {
        options.title = "Legacy brain folder";
        options.message =
            "Select the M### brain folder (must contain a counting/ subdirectory).";
    }
    return options;
}
function pickDirectory(event, data) {
    return __awaiter(this, void 0, void 0, function* () {
        const parentWindow = dialogParentWindow(event);
        const { tag, defaultPath } = parseDialogArg(data);
        const options = directoryDialogOptions(tag, defaultPath);
        if (parentWindow && !parentWindow.isDestroyed()) {
            parentWindow.show();
            parentWindow.focus();
        }
        else {
            console.warn("pickDirectory: no parent BrowserWindow; showing detached folder dialog");
        }
        let result;
        try {
            result =
                parentWindow && !parentWindow.isDestroyed()
                    ? yield dialog.showOpenDialog(parentWindow, options)
                    : yield dialog.showOpenDialog(options);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("showOpenDialog failed:", err);
            return { canceled: true, tag, error: message };
        }
        if (result.canceled || !result.filePaths[0]) {
            return { canceled: true, tag };
        }
        return { canceled: false, tag, path: result.filePaths[0] };
    });
}
/** Promise-based folder picker (avoids returnPath listener races on the menu). */
ipcMain.handle("showOpenDirectoryDialog", (event, data) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        return yield pickDirectory(event, data);
    }
    catch (err) {
        console.error("showOpenDirectoryDialog failed:", err);
        const { tag } = parseDialogArg(data);
        const message = err instanceof Error ? err.message : String(err);
        return { canceled: true, tag, error: message };
    }
}));
// Handlers
// Directories
ipcMain.on("openDialog", function (event, data) {
    const { tag, defaultPath } = parseDialogArg(data);
    void pickDirectory(event, data).then((result) => {
        if (!result.canceled && "path" in result) {
            event.sender.send("returnPath", [result.path, tag]);
        }
    });
});
// Files
ipcMain.on("openFileDialog", function (event, data) {
    const parentWindow = dialogParentWindow(event);
    const { tag, defaultPath } = parseDialogArg(data);
    if (parentWindow && !parentWindow.isDestroyed()) {
        parentWindow.show();
        parentWindow.focus();
    }
    dialog
        .showOpenDialog(parentWindow, openDialogOptions(["openFile"], defaultPath))
        .then((result) => {
        // Check for a valid result
        if (!result.canceled) {
            // console.log(result.filePaths)
            // Send back the dir and whether this is input or output
            event.sender.send("returnPath", [result.filePaths[0], tag]);
        }
    })
        .catch((err) => {
        console.log(err);
    });
});
function openPDF(relativePath) {
    const pdfPath = path.join(appDir, relativePath);
    shell
        .openPath(pdfPath)
        .then(() => {
        console.log("Guide opened");
    })
        .catch((error) => {
        console.log(error);
    });
}
ipcMain.on("openGuide", function (event, data) {
    openPDF("docs/belljar_guide.pdf");
});
function cleanupPythonKillListener(killChannel) {
    ipcMain.removeAllListeners(killChannel);
}
/** Drop orphaned kill-* IPC listeners on Python child error or exit. Scoped to this process only (no single-instance lock). */
/** Avoid MPS hangs on ops like torchvision::nms during detection on Apple Silicon. */
function pythonShellEnv() {
    const env = Object.assign({}, process.env);
    if (process.platform === "darwin") {
        env.PYTORCH_ENABLE_MPS_FALLBACK = "1";
    }
    if (process.platform === "win32") {
        env.PYTHONIOENCODING = "utf-8";
    }
    return env;
}
function attachPythonShellKillCleanup(pyshell, killChannel) {
    const dropKillListener = () => {
        cleanupPythonKillListener(killChannel);
    };
    pyshell.on("error", function (err) {
        log(err);
        dropKillListener();
    });
    pyshell.on("close", function () {
        dropKillListener();
    });
}
/** When Python exits non-zero, python-shell passes a truthy err — never throw from IPC handlers. */
function describePythonShellFailure(err, code, signal) {
    var _a;
    const c = typeof code === "number" ? code : null;
    const hasErr = err != null && err !== false;
    const badExit = c != null && c !== 0;
    if (!hasErr && !badExit) {
        return null;
    }
    let msg = "";
    if (hasErr && typeof err === "object" && err !== null) {
        const m = err.message;
        if (typeof m === "string" && m.length > 0) {
            msg = m;
        }
    }
    if (!msg && hasErr) {
        msg = String((_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : err);
    }
    const bits = [];
    if (badExit) {
        bits.push(`Python exited with code ${c}`);
    }
    if (msg) {
        bits.push(msg);
    }
    if (typeof signal === "string" && signal.length > 0) {
        bits.push(`signal: ${signal}`);
    }
    return bits.join(" · ") || "Python reported an error.";
}
// Max Projection
ipcMain.on("runMax", function (event, data) {
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: [
            `-o ${data[1]}`,
            `-i ${data[0]}`,
            `-d ${data[2]}`,
            `-t ${data[3]}`,
            "-g False",
        ],
    };
    let pyshell = new PythonShell("max.py", options);
    attachPythonShellKillCleanup(pyshell, "killMax");
    var total = 0;
    var current = 0;
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("maxResult");
                ipcMain.removeAllListeners("killMax");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killMax", function (event, data) {
        pyshell.kill();
    });
});
// Adjust
ipcMain.on("runAdjust", function (event, data) {
    var structPath = path.join(appDir, "csv/structure_map.pkl");
    const adjustArgs = [];
    appendFlagPathArg(adjustArgs, "-i", data[0]);
    appendFlagPathArg(adjustArgs, "-s", structPath);
    appendFlagPathArg(adjustArgs, "-a", data[1]);
    appendSliceListArg(adjustArgs, data, 2);
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: adjustArgs,
    };
    let pyshell = new PythonShell("adjust.py", options);
    attachPythonShellKillCleanup(pyshell, "killAdjust");
    try {
        const parent = dialogParentWindow(event);
        if (parent && !parent.isDestroyed()) {
            parent.blur();
        }
    }
    catch (_e) {
        // best effort: blur should never block tool launch
    }
    var total = 0;
    var current = 0;
    pyshell.on("stderr", function (stderr) {
        queueLogLineForUi(stderr);
    });
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("adjustResult");
                ipcMain.removeAllListeners("killAdjust");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killAdjust", function (event, data) {
        pyshell.kill();
    });
});
// Alignment
ipcMain.on("runAlign", function (event, data) {
    var _a, _b;
    const modelPath = path.join(homeDir, "models/predictor.pt");
    const nrrdPath = path.join(homeDir, "nrrd");
    const mapPath = path.join(appDir, "csv/structure_map.pkl");
    const alignArgs = [];
    appendFlagPathArg(alignArgs, "-o", data[1]);
    appendFlagPathArg(alignArgs, "-i", data[0]);
    alignArgs.push("-w", String((_a = data[2]) !== null && _a !== void 0 ? _a : "").trim());
    appendFlagPathArg(alignArgs, "-a", data[3]);
    appendFlagPathArg(alignArgs, "-m", modelPath);
    appendFlagPathArg(alignArgs, "-n", nrrdPath);
    appendFlagPathArg(alignArgs, "-c", mapPath);
    alignArgs.push("-l", String((_b = data[4]) !== null && _b !== void 0 ? _b : "").trim());
    appendSliceListArg(alignArgs, data, 5);
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: alignArgs,
    };
    let pyshell = new PythonShell("map.py", options);
    attachPythonShellKillCleanup(pyshell, "killAlign");
    try {
        const parent = dialogParentWindow(event);
        if (parent && !parent.isDestroyed()) {
            parent.blur();
        }
    }
    catch (_e) {
        // best effort: blur should never block tool launch
    }
    var total = 0;
    var current = 0;
    pyshell.on("stderr", function (stderr) {
        queueLogLineForUi(stderr);
    });
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("alignResult");
                if (pyFail) {
                    event.sender.send("alignError", [pyFail]);
                }
                ipcMain.removeAllListeners("killAlign");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killAlign", function (event, data) {
        pyshell.kill();
    });
});
// Intensity by Region
ipcMain.on("runIntensity", function (event, data) {
    var _a;
    const structPath = path.join(appDir, "csv/structure_map.pkl");
    const args = [];
    appendFlagPathArg(args, "-i", data[0]);
    appendFlagPathArg(args, "-o", data[1]);
    appendFlagPathArg(args, "-a", data[2]);
    args.push("-w", String((_a = data[3]) !== null && _a !== void 0 ? _a : "").trim());
    appendFlagPathArg(args, "-m", structPath);
    const dapiDir = data.length > 4 && data[4] != null ? String(data[4]).trim() : "";
    if (dapiDir.length > 0) {
        appendFlagPathArg(args, "-d", dapiDir);
    }
    appendSliceListArg(args, data, 5);
    const configPath = data.length > 6 && data[6] != null ? String(data[6]).trim() : "";
    if (configPath.length > 0) {
        appendFlagPathArg(args, "--config", configPath);
    }
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args,
    };
    let pyshell = new PythonShell("region.py", options);
    attachPythonShellKillCleanup(pyshell, "killIntensity");
    var total = 0;
    var current = 0;
    let intensityStderr = "";
    pyshell.on("stderr", function (stderr) {
        intensityStderr += stderr;
        queueLogLineForUi(stderr);
    });
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                const noPkls = intensityStderr.indexOf("NO_PKLS_WRITTEN") >= 0 ||
                    intensityStderr.indexOf("wrote 0 PKL") >= 0;
                const errMsg = pyFail ||
                    (noPkls
                        ? "Isolate Regions wrote no PKL files. Check alignment, selected regions, layer mode, and whole vs hemisphere in the Application log."
                        : null);
                if (errMsg) {
                    reportPythonFailure(errMsg);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("intensityResult");
                if (errMsg) {
                    event.sender.send("intensityError", [errMsg]);
                }
                ipcMain.removeAllListeners("killIntensity");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killIntensity", function (event, data) {
        pyshell.kill();
    });
});
// Export dual-channel ROI TIFs (DAPI + signal PKLs)
ipcMain.on("runExportDualTif", function (event, data) {
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: [String.raw `-i ${data[0]}`, String.raw `-o ${data[1]}`],
    };
    let pyshell = new PythonShell("export_roi_dual_tif.py", options);
    attachPythonShellKillCleanup(pyshell, "killExportDualTif");
    var total = 0;
    var current = 0;
    pyshell.on("stderr", function (stderr) {
        queueLogLineForUi(stderr);
    });
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("exportDualTifResult", pyFail !== null && pyFail !== void 0 ? pyFail : undefined);
                ipcMain.removeAllListeners("killExportDualTif");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killExportDualTif", function (event, data) {
        pyshell.kill();
    });
});
// Counting
ipcMain.on("runCount", function (event, data) {
    var structPath = path.join(appDir, "csv/structure_map.pkl");
    let custom_args = [
        `-p ${data[0]}`,
        `-a ${data[1]}`,
        `-o ${data[2]}`,
        `-m ${structPath}`,
    ];
    if (data[3]) {
        custom_args.push(`--layers`);
    }
    appendSliceListArg(custom_args, data, 4);
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: custom_args,
    };
    let pyshell = new PythonShell("count.py", options);
    attachPythonShellKillCleanup(pyshell, "killCount");
    var total = 0;
    var current = 0;
    pyshell.on("stderr", function (stderr) {
        queueLogLineForUi(stderr);
    });
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("countResult");
                ipcMain.removeAllListeners("killCount");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killCount", function (event, data) {
        pyshell.kill();
    });
});
// Collate
ipcMain.on("runCollate", function (event, data) {
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: [
            String.raw `-o ${data[1]}`,
            String.raw `-i ${data[0]}`,
            `-r ${data[2]}`,
            String.raw `-s ${path.join(appDir, "csv/structure_map.pkl")}`,
            "-g False",
        ],
    };
    let pyshell = new PythonShell("collate.py", options);
    attachPythonShellKillCleanup(pyshell, "killCollate");
    pyshell.end((err, code, signal) => {
        cleanupPythonKillListener("killCollate");
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
            reportPythonFailure(pyFail);
        }
        else {
            console.log("The exit code was: " + code);
            console.log("The exit signal was: " + signal);
        }
        event.sender.send("collateResult");
    });
    ipcMain.once("killCollate", function (event, data) {
        pyshell.kill();
    });
});
// Collate
ipcMain.on("runSharpen", function (event, data) {
    let custom = [
        String.raw `-o ${data[1]}`,
        String.raw `-i ${data[0]}`,
        `-r ${data[2]}`,
        `-a ${data[3]}`,
    ];
    if (data[4]) {
        custom.push(`--equalize`);
    }
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: custom,
    };
    let pyshell = new PythonShell("sharpen.py", options);
    attachPythonShellKillCleanup(pyshell, "killSharpen");
    var total = 0;
    var current = 0;
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("sharpenResult");
                ipcMain.removeAllListeners("killSharpen");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killSharpen", function (event, data) {
        pyshell.kill();
    });
});
// DAPI cleanup
ipcMain.on("runDapiCleanup", function (event, data) {
    let args = ["-i", String(data[0] || "").trim(), "-o", String(data[1] || "").trim()];
    if (data[2]) {
        args.push("--isolate");
    }
    else {
        args.push("--no-isolate");
    }
    if (data[3]) {
        args.push("--clahe");
    }
    args.push("--saturation", String(data[4] != null ? data[4] : 5));
    const backupDir = data[5] != null ? String(data[5]).trim() : "";
    if (backupDir.length > 0) {
        args.push("--backup-dir", backupDir);
    }
    appendSliceListArg(args, data, 6);
    if (data[7]) {
        args.push("--re-backup");
    }
    const bgValue = data[8] != null ? String(data[8]).trim() : "";
    if (bgValue.length > 0) {
        args.push("--bg-value", bgValue);
    }
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: args,
    };
    let pyshell = new PythonShell("dapi_cleanup.py", options);
    attachPythonShellKillCleanup(pyshell, "killDapiCleanup");
    var total = 0;
    var current = 0;
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("dapiCleanupResult");
                ipcMain.removeAllListeners("killDapiCleanup");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killDapiCleanup", function (event, data) {
        pyshell.kill();
    });
});
// Cell Detection
ipcMain.on("runDetection", function (event, data) {
    // Set model path
    var models = {
        somata: "models/chaosdruid.pt",
        nuclei: "models/ankou.pt",
    };
    var sam_model_path = path.join(homeDir, "models/sam_vit_b.pth");
    let selected = data[6];
    var modelPath = path.join(homeDir, models[selected]);
    // Switch over to custom if necessary
    if (data[4].length > 0) {
        modelPath = data[4];
    }
    let custom_args = [
        `-i ${data[0]}`,
        `-o ${data[1]}`,
        `-c ${data[2]}`,
        `-t ${data[3]}`,
        `-a ${data[7]}`,
        `-s ${sam_model_path}`,
        `-e ${data[8]}`,
        `-m ${modelPath}`,
    ];
    if (data[5]) {
        custom_args.push(`--multichannel`);
    }
    appendSliceListArg(custom_args, data, 9);
    let options = {
        mode: "text",
        pythonPath: path.join(envPythonPath, pyCommand),
        scriptPath: pyScriptsPath,
        args: custom_args,
        env: pythonShellEnv(),
    };
    let pyshell = new PythonShell("find_neurons.py", options);
    attachPythonShellKillCleanup(pyshell, "killDetect");
    var total = 0;
    var current = 0;
    pyshell.on("stderr", function (stderr) {
        queueLogLineForUi(stderr);
    });
    pyshell.on("message", (message) => {
        if (total === 0) {
            total = Number(message);
        }
        else if (message == "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                else {
                    console.log("The exit code was: " + code);
                    console.log("The exit signal was: " + signal);
                }
                event.sender.send("detectResult");
                ipcMain.removeAllListeners("killDetect");
            });
        }
        else {
            current++;
            event.sender.send("updateLoad", [
                Math.round((current / total) * 100),
                message,
            ]);
        }
    });
    ipcMain.once("killDetect", function (event, data) {
        pyshell.kill();
    });
});
function mapStartupProgressPct(startupPct) {
    return 3 + Math.round(Math.min(100, Math.max(0, startupPct)) * 0.15);
}
function mapExtractItemProgressPct(itemPct) {
    return 22 + Math.round(Math.min(100, Math.max(0, itemPct)) * 0.70);
}
function mapProbeProgressPct(itemPct) {
    return 5 + Math.round(Math.min(100, Math.max(0, itemPct)) * 0.90);
}
function runCziPythonScript(event, scriptName, args, killChannel, resultChannel) {
    const isProbe = scriptName === "czi_probe.py";
    const pythonExe = path.join(envPythonPath, pyCommand);
    queueLogLineForUi(`Launching Python: ${scriptName} (${pythonExe})`);
    event.sender.send("cziJobLog", `Launching Python: ${scriptName}`);
    const options = {
        mode: "text",
        pythonPath: pythonExe,
        scriptPath: pyScriptsPath,
        args: args,
        env: pythonShellEnv(),
    };
    const pyshell = new PythonShell(scriptName, options);
    attachPythonShellKillCleanup(pyshell, killChannel);
    let total = 0;
    let current = 0;
    let resultPayload = null;
    let processStarted = false;
    function ackProcessStarted() {
        if (!processStarted) {
            processStarted = true;
            queueLogLineForUi("Python process started");
            event.sender.send("cziJobLog", "Python process started");
        }
    }
    pyshell.on("stderr", function (stderr) {
        ackProcessStarted();
        queueLogLineForUi(stderr);
        const trimmed = stderr.trim();
        if (trimmed) {
            event.sender.send("cziJobLog", trimmed);
        }
    });
    pyshell.on("message", (message) => {
        ackProcessStarted();
        if (message.startsWith("LOG:")) {
            const detail = message.slice(4);
            queueLogLineForUi(detail);
            event.sender.send("cziJobLog", detail);
            return;
        }
        if (message.startsWith("PROGRESS:")) {
            const body = message.slice("PROGRESS:".length);
            const colon = body.indexOf(":");
            if (colon >= 0) {
                const startupPct = Number(body.slice(0, colon));
                const text = body.slice(colon + 1);
                if (!Number.isNaN(startupPct)) {
                    const displayPct = mapStartupProgressPct(startupPct);
                    event.sender.send("updateLoad", [displayPct, text]);
                    event.sender.send("cziJobLog", text);
                }
            }
            return;
        }
        if (message.startsWith("RESULT:")) {
            try {
                resultPayload = JSON.parse(message.slice("RESULT:".length));
            }
            catch (parseErr) {
                queueLogLineForUi("CZI: failed to parse result JSON");
                console.error(parseErr);
            }
            return;
        }
        if (total === 0) {
            const n = Number(message);
            if (!Number.isNaN(n) && n > 0) {
                total = n;
                const readyMsg = isProbe
                    ? `Ready — ${n} CZI file(s) to probe`
                    : `Ready — ${n} extraction items`;
                const readyPct = isProbe ? 5 : 20;
                queueLogLineForUi(readyMsg);
                event.sender.send("updateLoad", [readyPct, readyMsg]);
                event.sender.send("cziJobLog", readyMsg);
                return;
            }
        }
        if (message === "Done!") {
            pyshell.end((err, code, signal) => {
                const pyFail = describePythonShellFailure(err, code, signal);
                if (pyFail) {
                    reportPythonFailure(pyFail);
                }
                event.sender.send(resultChannel, pyFail ? { ok: false, error: pyFail } : resultPayload);
                cleanupPythonKillListener(killChannel);
            });
        }
        else if (isProbe) {
            const pctMatch = message.match(/^(\d+)%\s/);
            if (pctMatch) {
                current++;
                const itemPct = Number(pctMatch[1]);
                if (!Number.isNaN(itemPct)) {
                    event.sender.send("updateLoad", [mapProbeProgressPct(itemPct), message]);
                    return;
                }
            }
            if (message.startsWith("Probing ")) {
                const itemPct = total > 0 ? Math.round((current / total) * 100) : 0;
                event.sender.send("updateLoad", [mapProbeProgressPct(itemPct), message]);
                return;
            }
            current++;
            const itemPct = total > 0 ? Math.round((current / total) * 100) : 0;
            event.sender.send("updateLoad", [mapProbeProgressPct(itemPct), message]);
        }
        else {
            current++;
            const itemPct = total > 0 ? Math.round((current / total) * 100) : 0;
            const displayPct = mapExtractItemProgressPct(itemPct);
            event.sender.send("updateLoad", [displayPct, message]);
        }
    });
    ipcMain.once(killChannel, function () {
        pyshell.kill();
    });
}
ipcMain.on("runCziProbe", function (event, data) {
    const inputDir = data[0] || "";
    const probeArgs = [];
    appendCziInputArg(probeArgs, inputDir);
    runCziPythonScript(event, "czi_probe.py", probeArgs, "killCziProbe", "cziProbeResult");
});
ipcMain.on("runCziImport", function (event, data) {
    const bundleRoot = data[0] || "";
    const configPath = data[1] || "";
    const importArgs = [];
    appendCziPathArgs(importArgs, bundleRoot, configPath);
    runCziPythonScript(event, "czi_extract.py", importArgs, "killCziImport", "cziImportResult");
});
ipcMain.on("showLogWindow", function (event) {
    logDismissedByUser = false;
    ensureLogWindowVisible({ force: true });
    replyLogWindowState(event);
});
ipcMain.on("getLogWindowState", function (event) {
    replyLogWindowState(event);
});
ipcMain.on("toggleLogWindow", function (event) {
    if (!logWin || logWin.isDestroyed()) {
        logDismissedByUser = false;
        ensureLogWindowVisible({ force: true });
        replyLogWindowState(event);
        return;
    }
    if (logWin.isVisible()) {
        hideLogWindowByUser();
    }
    else {
        logDismissedByUser = false;
        logWin.show();
        logWin.focus();
    }
    replyLogWindowState(event);
});
ipcMain.on("reportRendererError", function (_event, data) {
    const msg = String(data && data[0] != null ? data[0] : "Renderer error");
    ensureLogWindowVisible({ force: true });
    queueLogLineForUi(`Renderer: ${msg}`);
});
ipcMain.on("runApplyGeometry", function (event, data) {
    const bundleRoot = data[0] || "";
    const configPath = data[1] || "";
    const geometryArgs = [];
    appendCziPathArgs(geometryArgs, bundleRoot, configPath);
    runCziPythonScript(event, "apply_geometry.py", geometryArgs, "killApplyGeometry", "applyGeometryResult");
});
function getBatchQueueDeps() {
    return {
        PythonShell,
        envPythonPath,
        pyCommand,
        pyScriptsPath,
        homeDir,
        appDir,
        describePythonShellFailure,
        queueLogLineForUi,
    };
}
ipcMain.on("runBatch", function (event, plan) {
    const { runBatchQueue } = require("./batch_queue");
    void runBatchQueue(getBatchQueueDeps(), plan, (overallPct, message, detail) => {
        event.sender.send("batchProgress", [overallPct, message, detail || ""]);
    }, (projectName, step) => {
        event.sender.send("batchJobStart", { project: projectName, step });
    }).then((result) => {
        event.sender.send("batchComplete", result);
    });
});
ipcMain.on("killBatch", function () {
    const { killBatchQueue } = require("./batch_queue");
    killBatchQueue();
});
