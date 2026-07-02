/** Ensure packaged / relocated app roots can resolve production dependencies. */
const path = require("path");
const fs = require("fs");
const Module = require("module");
(function ensureAppNodeModulePaths() {
  const roots: string[] = [__dirname];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    roots.push(path.join(resourcesPath, "app"));
  }
  const globalPaths = Module.globalPaths as string[];
  for (const root of roots) {
    const nodeModules = path.join(root, "node_modules");
    if (fs.existsSync(nodeModules) && !globalPaths.includes(nodeModules)) {
      globalPaths.unshift(nodeModules);
    }
  }
})();

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
import type { BatchPlan } from "./batch_queue";
import {
  createHeavyJobHandle,
  defaultCoordinatorDir,
  detectLinkMbps,
  ensureCoordinatorDir,
  getIoFairshareStatus,
  loadUserConfig,
  saveSharedConfig,
  saveUserConfig,
  resetLinkSpeedCache,
  type IoFairshareSharedConfig,
  type IoFairshareUserConfig,
} from "./io_fairshare";
import { UpdateManager, updateLogPath, refreshUpdateLockState } from "./update_manager";
const { promisify } = require("util");
const { PythonShell } = require("python-shell");
const tar = require("tar");
const mv = promisify(fs.rename);
const exec = promisify(require("child_process").exec);
const stream = require("stream");
const https = require("https");
const serverFetch = require("node-fetch");

var appDir = app.getAppPath();

var win: typeof BrowserWindow = null;
var logWin: typeof BrowserWindow = null;
/** When true, log lines queue but the window stays hidden until user opens it or an error forces show. */
var logDismissedByUser = true;
var isQuitting = false;

/** Batch console mirroring to the log window to avoid IPC/DOM floods. */
const LOG_UI_FLUSH_MS = 150;
const LOG_UI_MAX_QUEUE = 4000;
const LOG_UI_CHUNK_LINES = 350;
let logUiQueue: string[] = [];
let logUiFlushTimer: ReturnType<typeof setTimeout> | null = null;
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
  } catch (_error) {
    // log window was closed
  }
  if (logUiQueue.length > 0) {
    logUiFlushTimer = setTimeout(flushLogUiQueue, LOG_UI_FLUSH_MS);
  }
}

function queueLogLineForUi(line: string) {
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
    } catch (_error) {
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
  } catch (_error) {
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

function resolveHomeDir(): string {
  return path.join(app.getPath("home"), BRANDING.HOME_DIR);
}

function legacyHomePath(): string {
  return path.join(app.getPath("home"), BRANDING.LEGACY_HOME_DIR);
}

function envIsReady(homePath: string): boolean {
  return (
    fs.existsSync(path.join(homePath, "python")) ||
    fs.existsSync(path.join(homePath, "benv"))
  );
}

function needsLegacyHomeMigration(): boolean {
  return !envIsReady(homeDir) && envIsReady(legacyHomePath());
}

async function copyLegacyHomeEntries(
  win: typeof BrowserWindow,
): Promise<void> {
  const legacyDir = legacyHomePath();
  for (const entry of LEGACY_HOME_COPY_ENTRIES) {
    const src = path.join(legacyDir, entry);
    if (!fs.existsSync(src)) {
      continue;
    }
    const dest = path.join(homeDir, entry);
    win.webContents.send(
      "updateStatus",
      `Copying ${entry} from Bell Jar…`,
    );
    await fs.promises.cp(src, dest, { recursive: true });
  }
}

async function maybeMigrateLegacyHome(
  win: typeof BrowserWindow,
): Promise<boolean> {
  if (!needsLegacyHomeMigration()) {
    return true;
  }
  const choice = dialog.showMessageBoxSync(win, {
    type: "question",
    message:
      "Mason Jar uses ~/.masonjar (separate from Bell Jar's ~/.belljar).",
    detail:
      "Copy your existing Bell Jar environment to save re-downloading ~20GB, or install fresh into ~/.masonjar.",
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
    await copyLegacyHomeEntries(win);
    return true;
  } catch (error) {
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
const ioFairshareDir = defaultCoordinatorDir();

const CURRENT_VERSION_TAG = getVersion();
const updateManager = new UpdateManager(
  homeDir,
  CURRENT_VERSION_TAG,
  app.isPackaged,
);

function loadMenuAndCheckUpdates(targetWin: typeof BrowserWindow) {
  targetWin.loadFile("pages/menu.html");
  targetWin.webContents.once("did-finish-load", () => {
    const url = targetWin.webContents.getURL();
    if (url.includes("menu.html")) {
      checkForUpdates(targetWin);
    }
  });
}

function appendSliceListArg(args: string[], data: any[], index: number) {
  if (data.length > index && data[index] != null) {
    const sliceListPath = String(data[index]).trim();
    if (sliceListPath.length > 0) {
      // Long options must be separate argv entries (or --slice-list=path) for argparse.
      args.push("--slice-list", sliceListPath);
    }
  }
}

/** CZI scripts: separate -b/-j argv tokens so Windows paths with spaces parse correctly. */
function appendCziPathArgs(
  args: string[],
  bundleRoot: string,
  configPath?: string,
) {
  args.push("-b", String(bundleRoot || "").trim());
  if (configPath != null && String(configPath).trim().length > 0) {
    args.push("-j", String(configPath).trim());
  }
}

function appendCziInputArg(args: string[], inputDir: string) {
  args.push("-i", String(inputDir || "").trim());
}

/** Separate flag and path argv tokens so Windows paths with spaces parse correctly in argparse. */
function appendFlagPathArg(args: string[], flag: string, value: string) {
  const v = String(value ?? "").trim();
  if (v.length > 0) {
    args.push(flag, v);
  }
}

function navigateToUpdatesSettings(
  targetWin: typeof BrowserWindow,
  pending = false,
) {
  if (pending) {
    targetWin.loadFile("pages/settings_updates.html", {
      query: { pending: "1" },
    });
  } else {
    targetWin.loadFile("pages/settings_updates.html");
  }
}

async function checkForUpdates(
  parentWin?: typeof BrowserWindow,
  options?: { manual?: boolean },
) {
  try {
    const result = await updateManager.checkForUpdatesDetailed();
    if (result.error) {
      console.warn("Failed to check for updates:", result.error);
      if (options?.manual && parentWin) {
        dialog.showMessageBox(parentWin, {
          type: "warning",
          title: "Update check failed",
          message: "Could not reach GitHub to check for updates.",
          detail: result.error,
          buttons: ["OK"],
        });
      }
      return;
    }

    if (result.updateAvailable && result.latest) {
      const detailParts = [
        `The latest version is ${result.latest}.`,
        result.isPrerelease ? "This is a pre-release build." : "",
        result.releaseNotesExcerpt || "",
      ].filter(Boolean);
      const userResponse = await dialog.showMessageBox(parentWin || undefined, {
        type: "info",
        title: "Update Available",
        message: "A new version of Mason Jar is available.",
        detail: detailParts.join("\n\n"),
        buttons: ["Update", "Download in browser", "Later"],
        defaultId: 0,
        cancelId: 2,
      });

      if (userResponse.response === 0) {
        const target = parentWin || win;
        if (target) {
          navigateToUpdatesSettings(target, true);
        }
      } else if (userResponse.response === 1 && result.releaseUrl) {
        shell.openExternal(result.releaseUrl);
      }
    } else if (options?.manual && parentWin) {
      dialog.showMessageBox(parentWin, {
        type: "info",
        title: "No updates",
        message: "You're up to date.",
        detail: `Mason Jar ${CURRENT_VERSION_TAG} is the latest version available for your update settings.`,
        buttons: ["OK"],
      });
    } else {
      console.log("No updates available.");
    }
  } catch (error) {
    console.warn("Failed to check for updates:", error);
  }
}

// Promise version of file moving
function move(o: string, t: string) {
  return new Promise((resolve, reject) => {
    // move o to t, wrapped as promise
    const original = o;
    const target = t;
    mv(original, target).then(() => {
      resolve(0);
    });
  });
}

function createLogFile(message: string) {
  const logPath = path.join(homeDir, BRANDING.LOG_FILE);
  fs.appendFileSync(logPath, message);
}

// Get files asynchonously
function downloadFile(url: string, target: string, win: typeof BrowserWindow) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(target, { highWaterMark: 64 * 1024 });
    // get the file, update the user loading screen with text on progress

    const progress = (receivedBytes: number, totalBytes: number) => {
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
    const request = https.get(url, (response: any) => {
      // create a dummy stream so we can update the user on progress
      var receivedBytes = 0;
      var totalBytes = parseInt(response.headers["content-length"]);
      response.pipe(dummy);
      let lastUpdateTimestamp = Date.now();

      dummy.on("data", (chunk: any) => {
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
        win.webContents.send(
          "updateStatus",
          `Extracting ${target.split("/").pop()}...`
        );
        resolve(true);
      });
    });
  });
}

// Delete a file safely
function deleteFile(file: string) {
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

function setupPython(win: typeof BrowserWindow) {
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
          downloadFile(
            winURL,
            path.join(
              homeDir,
              "cpython-3.10.13+20230826-x86_64-pc-windows-msvc-shared-install_only.tar.gz"
            ),
            win
          )
            .then(() => {
              // Extract the tarball
              tar
                .x({
                  cwd: homeDir,
                  preservePaths: true,
                  file: path.join(
                    homeDir,
                    "cpython-3.10.13+20230826-x86_64-pc-windows-msvc-shared-install_only.tar.gz"
                  ),
                })
                .then(() => {
                  win.webContents.send("updateStatus", "Extracted python...");
                  resolve(true);
                });
            })
            .catch((err: any) => {
              console.log(err);
            });
          break;
        case "linux":
          downloadFile(
            linuxURL,
            path.join(
              homeDir,
              "cpython-3.10.13+20230826-x86_64-unknown-linux-gnu-install_only.tar.gz"
            ),
            win
          ).then(() => {
            tar
              .x({
                cwd: homeDir,
                preservePaths: true,
                file: path.join(
                  homeDir,
                  "cpython-3.10.13+20230826-x86_64-unknown-linux-gnu-install_only.tar.gz"
                ),
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
            downloadFile(
              osxIntelURL,
              path.join(
                homeDir,
                "cpython-3.10.13+20230826-x86_64-apple-darwin-install_only.tar.gz"
              ),
              win
            ).then(() => {
              tar
                .x({
                  cwd: homeDir,
                  preservePaths: true,
                  file: path.join(
                    homeDir,
                    "cpython-3.10.13+20230826-x86_64-apple-darwin-install_only.tar.gz"
                  ),
                })
                .then(() => {
                  win.webContents.send("updateStatus", "Extracted python...");
                  resolve(true);
                });
            });
          } else {
            downloadFile(
              osxURL,
              path.join(
                homeDir,
                "cpython-3.10.13+20230826-aarch64-apple-darwin-install_only.tar.gz"
              ),
              win
            ).then(() => {
              tar
                .x({
                  cwd: homeDir,
                  preservePaths: true,
                  file: path.join(
                    homeDir,
                    "cpython-3.10.13+20230826-aarch64-apple-darwin-install_only.tar.gz"
                  ),
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
    } else {
      // Double check that the environment is setup by confirming if the benv folder exists
      if (!fs.existsSync(envPath)) {
        resolve(true);
      } else {
        resolve(false);
      }
    }
  });
}

// Download the required tar files from the bucket
function downloadResources(win: typeof BrowserWindow, fresh: boolean) {
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
      var downloading: Array<string> = [];
      var total = 0;

      // check the manifest.json and compare versions
      // if the versions are different, delete the dir and download
      const manifestPath = path.join(homeDir, "manifest.json");
      // Make sure the manifest exists and if not lets make one and then delte all these dirs and redownload
      if (!fs.existsSync(manifestPath)) {
        // Create manifest from current versions
        fs.writeFileSync(
          manifestPath,
          JSON.stringify(currnet_versions, null, 2)
        );
        // Delete existing
        downloading.push("models");
        downloading.push("embeddings");
        downloading.push("nrrd");
      }
      const manifest = require(manifestPath);

      // check if each directory exists and its not empty
      for (let i = 0; i < requiredDirs.length; i++) {
        const dir = requiredDirs[i];
        if (
          !fs.existsSync(path.join(homeDir, dir)) ||
          fs.readdirSync(path.join(homeDir, dir)).length === 0
        ) {
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
        fs.writeFileSync(
          manifestPath,
          JSON.stringify(currnet_versions, null, 2)
        );
      }

      downloading.reduce((promiseChain, dir, i) => {
        return promiseChain
          .then(() => {
            win.webContents.send(
              "updateStatus",
              `Redownloading ${dir}...this may take a while`
            );

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

            return downloadFile(
              downloadPath,
              path.join(homeDir, `${dir}.tar.gz`),
              win
            );
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
    } else {
      // Since we are doing a fresh install, we need to ensure no remnants of the old install are left or partially downloaded
      // Check if these directories exist, if they do, we don't need to download any files
      let allDirsExist = true;
      requiredDirs.forEach((dir) => {
        if (!fs.existsSync(path.join(homeDir, dir))) {
          allDirsExist = false;
        }
      });

      // Creat the manifest
      fs.writeFileSync(
        path.join(homeDir, "manifest.json"),
        JSON.stringify(currnet_versions, null, 2)
      );

      if (!allDirsExist) {
        // Something is missing, delete everything and download again
        requiredDirs.forEach((dir) => {
          if (fs.existsSync(path.join(homeDir, dir))) {
            fs.rmSync(path.join(homeDir, dir), { recursive: true });
          }
        });

        // Download the embeddings
        downloadFile(
          embeddingsLink,
          path.join(homeDir, "embeddings.tar.gz"),
          win
        ).then(() => {
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
                downloadFile(
                  modelsLink,
                  path.join(homeDir, "models.tar.gz"),
                  win
                ).then(() => {
                  // Extract the models
                  tar
                    .x({
                      cwd: homeDir,
                      preservePaths: true,
                      file: path.join(homeDir, "models.tar.gz"),
                    })
                    .then(() => {
                      // Delete the tar file
                      deleteFile(path.join(homeDir, "models.tar.gz")).then(
                        () => {
                          // Download the nrrd
                          downloadFile(
                            nrrdLink,
                            path.join(homeDir, "nrrd.tar.gz"),
                            win
                          ).then(() => {
                            // Extract the nrrd
                            tar

                              .x({
                                cwd: homeDir,
                                preservePaths: true,
                                file: path.join(homeDir, "nrrd.tar.gz"),
                              })
                              .then(() => {
                                // Delete the tar file
                                deleteFile(
                                  path.join(homeDir, "nrrd.tar.gz")
                                ).then(() => {
                                  resolve(true);
                                });
                              });
                          });
                        }
                      );
                    });
                });
              });
            });
        });
      } else {
        resolve(true);
      }
    }
  });
}

// Creates the venv and installs the dependencies
function setupEnvironment(win: typeof BrowserWindow) {
  if (!fs.existsSync(envPath)) {
    // We have not created the venv yet, so we probably don't have the models, etc. either

    win.webContents.send(
      "updateStatus",
      "Preparing to download require files..."
    );

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
  async function installVenv() {
    const { stdout, stderr } = await exec(
      `${pyCommand} -m pip install --user virtualenv`,
      { cwd: pythonPath }
    );
    return { stdout, stderr };
  }

  // Create venv
  async function createVenv() {
    const envDir = process.platform === "win32" ? "../benv" : "../../benv";
    const { stdout, stderr } = await exec(`${pyCommand} -m venv ${envDir}`, {
      cwd: pythonPath,
    });
    return { stdout, stderr };
  }

  // Install pip packages
  async function installDeps() {
    let reqs = path.join(appDir, "py/requirements.txt");
    const { stdout, stderr } = await exec(
      `${pyCommand} -m pip install -r "${reqs}" --use-pep517`,
      { cwd: envPythonPath }
    );
    return { stdout, stderr };
  }
}

// Install the latest dependencies, could have changed after an update
function updatePythonDependencies(win: typeof BrowserWindow) {
  return new Promise((resolve, reject) => {
    win.webContents.send("updateStatus", "Updating packages...");
    // Run pip install -r requirements.txt --no-cache-dir to update the packages
    let reqsPath = path.join(appDir, "py/requirements.txt");
    exec(
      `${pyCommand} -m pip install -r "${reqsPath}" --no-cache-dir  --use-pep517`,
      { cwd: envPythonPath }
    )
      .then(({ stdout, stderr }: { stdout: string; stderr: string }) => {
        console.log(stdout);
        win.webContents.send("updateStatus", "Update complete!");
        resolve(true);
      })
      .catch((error: any) => {
        console.log(error);
        createLogFile(error);
        createLogFile("Failed to update python dependencies");
        createLogFile(appDir);
        reject(error);
      });
  });
}

// Ensure all required directories exist and if not, download them
function fixMissingDirectories(win: typeof BrowserWindow) {
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
      flushLogUiQueue();
    } catch (_error) {
      // window closed during load
    }
  });
  win.on("closed", () => {
    logWin = null;
    logDismissedByUser = true;
  });

  return win;
}

function getLogWindowState(): { visible: boolean; dismissed: boolean } {
  const exists = logWin != null && !logWin.isDestroyed();
  return {
    visible: exists && logWin.isVisible(),
    dismissed: logDismissedByUser,
  };
}

function replyLogWindowState(event: { sender: { send: (channel: string, payload: unknown) => void } }) {
  event.sender.send("logWindowState", getLogWindowState());
}

function ensureLogWindowVisible(opts?: { force?: boolean }): boolean {
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
  flushLogUiQueue();
  return true;
}

function hideLogWindowByUser() {
  logDismissedByUser = true;
  if (logWin && !logWin.isDestroyed()) {
    logWin.hide();
  }
}

function reportPythonFailure(pyFail: string | null) {
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
  win.on("close", function (e: any) {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Yes", "Cancel"],
      title: `Quit ${BRANDING.PRODUCT_NAME}?`,
      message:
        `Are you sure you want to quit ${BRANDING.PRODUCT_NAME}? Quitting will kill all running processes.`,
    });
    if (choice === 1) {
      e.preventDefault();
    } else {
      try {
        if (logWin && !logWin.isDestroyed()) {
          logWin.webContents.send("savelogs", []);
          logWin.close();
        }
      } catch (error) {
        // do nothing window was closed
      }
    }
  });

  win.webContents.once("did-finish-load", () => {
    checkLocalDir();
    ensureCoordinatorDir(ioFairshareDir);
    void detectLinkMbps();
    void maybeMigrateLegacyHome(win).then((ok) => {
      if (!ok) {
        return;
      }
      setupPython(win)
        .then((installed) => {
          if (installed) {
            setupEnvironment(win);
          } else {
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
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", function () {
  app.quit();
});

ipcMain.on("checkForUpdates", (event: any) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  checkForUpdates(parent || win, { manual: true });
});

ipcMain.handle("getUpdatePreferences", async () => {
  return updateManager.getPreferences();
});

ipcMain.handle(
  "saveUpdatePreferences",
  async (_event: any, patch: { allowPrerelease?: boolean }) => {
    const saved = updateManager.savePreferences({
      allow_prerelease: !!patch?.allowPrerelease,
    });
    return saved;
  },
);

ipcMain.handle("getUpdateStatus", async () => {
  const lockState = refreshUpdateLockState();
  return {
    preferences: updateManager.getPreferences(),
    cached: updateManager.getCachedCheck(),
    applyInfo: updateManager.getApplyInfo(),
    currentVersion: CURRENT_VERSION_TAG,
    lockCleared: lockState.clearedStale || lockState.clearedOrphan,
  };
});

ipcMain.handle(
  "checkForUpdatesDetailed",
  async (_event: any, opts?: { allowPrerelease?: boolean }) => {
    const result = await updateManager.checkForUpdatesDetailed(
      opts?.allowPrerelease,
    );
    return {
      result,
      applyInfo: updateManager.getApplyInfo(),
    };
  },
);

ipcMain.handle("downloadWindowsUpdate", async (event: any) => {
  const sender = event.sender;
  return updateManager.downloadWindowsUpdate((percent, message) => {
    sender.send("updateDownloadProgress", [percent, message]);
  });
});

ipcMain.handle("applyWindowsUpdate", async () => {
  const prepared = updateManager.prepareWindowsApply();
  if (!prepared.ok) {
    return prepared;
  }
  return updateManager.launchApplyAndQuit(
    prepared.scriptPath!,
    prepared.stagedVersion || "",
    () => {
      app.quit();
    },
  );
});

ipcMain.handle("runWindowsUpdateNow", async (event: any) => {
  const sender = event.sender;
  return updateManager.runWindowsUpdateNow((percent, message) => {
    sender.send("updateDownloadProgress", [percent, message]);
  }, () => {
    app.quit();
  });
});

ipcMain.handle("openUpdateLog", async () => {
  const logPath = updateLogPath(homeDir);
  if (fs.existsSync(logPath)) {
    await shell.openPath(logPath);
    return { ok: true, opened: "file" };
  }
  fs.mkdirSync(homeDir, { recursive: true });
  await shell.openPath(homeDir);
  return {
    ok: true,
    opened: "folder",
    message: "No update log yet — opened Mason Jar settings folder.",
  };
});

ipcMain.handle("openExternalUrl", async (_event: any, url: string) => {
  const target = String(url || "").trim();
  if (target) {
    await shell.openExternal(target);
  }
  return { ok: true };
});

ipcMain.on("getVersion", (event: any) => {
  event.sender.send("version", getVersion());
});

function parseDialogArg(data: any): {
  tag: string;
  defaultPath?: string;
  multi?: boolean;
} {
  if (typeof data === "string") {
    return { tag: data };
  }
  if (data && typeof data === "object") {
    const tag = data.tag != null ? String(data.tag) : String(data);
    const defaultPath =
      typeof data.defaultPath === "string" ? data.defaultPath : undefined;
    const multi = !!data.multi;
    return { tag, defaultPath, multi };
  }
  return { tag: String(data) };
}

function openDialogOptions(
  properties: ("openDirectory" | "openFile" | "multiSelections")[],
  defaultPath?: string,
): {
  properties: ("openDirectory" | "openFile" | "multiSelections")[];
  defaultPath?: string;
} {
  const options: {
    properties: ("openDirectory" | "openFile" | "multiSelections")[];
    defaultPath?: string;
  } = { properties };
  if (defaultPath && fs.existsSync(defaultPath)) {
    options.defaultPath = defaultPath;
  }
  return options;
}

/** Prefer the BrowserWindow that sent the IPC (menu/tools), not getFocusedWindow() (often the log). */
function dialogParentWindow(event: { sender: any }): typeof BrowserWindow | null {
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

/** Minimize Mason Jar when an external tool (e.g. Napari) takes over the desktop. */
function handoffParentForExternalTool(parent: typeof BrowserWindow | null): void {
  try {
    if (parent && !parent.isDestroyed()) {
      parent.minimize();
    }
  } catch (_e) {
    // best effort: handoff should never block tool launch
  }
}

/** Restore Mason Jar after an external tool session ends. */
function restoreParentAfterExternalTool(parent: typeof BrowserWindow | null): void {
  try {
    if (parent && !parent.isDestroyed()) {
      if (parent.isMinimized()) {
        parent.restore();
      }
      parent.show();
      parent.focus();
    }
  } catch (_e) {
    // best effort
  }
}

function directoryDialogOptions(
  tag: string,
  defaultPath?: string,
  multi?: boolean,
): {
  properties: ("openDirectory" | "openFile" | "multiSelections")[];
  defaultPath?: string;
  title?: string;
  message?: string;
} {
  const props: ("openDirectory" | "openFile" | "multiSelections")[] = multi
    ? ["openDirectory", "multiSelections"]
    : ["openDirectory"];
  const options = openDialogOptions(props, defaultPath) as {
    properties: ("openDirectory" | "openFile" | "multiSelections")[];
    defaultPath?: string;
    title?: string;
    message?: string;
  };
  if (tag === "projectBundle") {
    options.title = `Open ${BRANDING.PRODUCT_NAME} project`;
    options.message =
      "Select the project folder (e.g. M528_masonjar) that contains its .masonjar project file or legacy project.belljar.";
  } else if (tag === "newProjectBundle") {
    options.title = `New ${BRANDING.PRODUCT_NAME} project location`;
    options.message =
      "Choose a parent folder. Mason Jar will create Name_masonjar/ with Name.masonjar and data/ inside.";
  } else if (tag === "brainRoot") {
    options.title = "Legacy brain folder";
    options.message =
      "Select the M### brain folder (must contain a counting/ subdirectory).";
  } else if (tag === "nasLocations") {
    options.title = "Select network drives or NAS folders";
    options.message =
      "Choose mapped drives (e.g. Z:\\) or UNC shares. Mason Jar stores the drive or share root for bandwidth fair-share.";
  }
  return options;
}

async function pickDirectory(
  event: { sender: { send: (channel: string, payload: unknown) => void } },
  data: unknown,
): Promise<
  | { canceled: true; tag: string; error?: string }
  | { canceled: false; tag: string; path: string }
> {
  const parentWindow = dialogParentWindow(event);
  const { tag, defaultPath } = parseDialogArg(data);
  const options = directoryDialogOptions(tag, defaultPath);
  if (parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.show();
    parentWindow.focus();
  } else {
    console.warn(
      "pickDirectory: no parent BrowserWindow; showing detached folder dialog",
    );
  }
  let result;
  try {
    result =
      parentWindow && !parentWindow.isDestroyed()
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("showOpenDialog failed:", err);
    return { canceled: true, tag, error: message };
  }
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, tag };
  }
  return { canceled: false, tag, path: result.filePaths[0] };
}

async function pickNetworkLocations(
  event: { sender: { send: (channel: string, payload: unknown) => void } },
  data: unknown,
): Promise<
  | { canceled: true; error?: string }
  | { canceled: false; paths: string[] }
> {
  const parentWindow = dialogParentWindow(event);
  const { tag, defaultPath } = parseDialogArg(data);
  const options = directoryDialogOptions(tag || "nasLocations", defaultPath, true);
  if (parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.show();
    parentWindow.focus();
  }
  let result;
  try {
    result =
      parentWindow && !parentWindow.isDestroyed()
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { canceled: true, error: message };
  }
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }
  return { canceled: false, paths: result.filePaths };
}

/** Promise-based folder picker (avoids returnPath listener races on the menu). */
ipcMain.handle("showOpenDirectoryDialog", async (event: any, data: unknown) => {
  try {
    return await pickDirectory(event, data);
  } catch (err) {
    console.error("showOpenDirectoryDialog failed:", err);
    const { tag } = parseDialogArg(data);
    const message = err instanceof Error ? err.message : String(err);
    return { canceled: true, tag, error: message };
  }
});

ipcMain.handle("showOpenNetworkLocationsDialog", async (event: any, data: unknown) => {
  try {
    const payload =
      data && typeof data === "object"
        ? { ...(data as object), tag: "nasLocations", multi: true }
        : { tag: "nasLocations", multi: true };
    return await pickNetworkLocations(event, payload);
  } catch (err) {
    console.error("showOpenNetworkLocationsDialog failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return { canceled: true, error: message };
  }
});

// Handlers
// Directories
ipcMain.on("openDialog", function (event: any, data: any) {
  const { tag, defaultPath } = parseDialogArg(data);
  void pickDirectory(event, data).then((result) => {
    if (!result.canceled && "path" in result) {
      event.sender.send("returnPath", [result.path, tag]);
    }
  });
});
// Files
ipcMain.on("openFileDialog", function (event: any, data: any) {
  const parentWindow = dialogParentWindow(event);
  const { tag, defaultPath } = parseDialogArg(data);
  if (parentWindow && !parentWindow.isDestroyed()) {
    parentWindow.show();
    parentWindow.focus();
  }
  dialog
    .showOpenDialog(parentWindow, openDialogOptions(["openFile"], defaultPath))
    .then((result: { canceled: boolean; filePaths: any[] }) => {
      // Check for a valid result
      if (!result.canceled) {
        // console.log(result.filePaths)
        // Send back the dir and whether this is input or output
        event.sender.send("returnPath", [result.filePaths[0], tag]);
      }
    })
    .catch((err: Error) => {
      console.log(err);
    });
});

function openPDF(relativePath: string) {
  const pdfPath = path.join(appDir, relativePath);
  shell
    .openPath(pdfPath)
    .then(() => {
      console.log("Guide opened");
    })
    .catch((error: any) => {
      console.log(error);
    });
}

ipcMain.on("openGuide", function (event: any, data: any) {
  openPDF("docs/belljar_guide.pdf");
});

ipcMain.on("openPathInShell", function (event: any, absPath: string) {
  const target = String(absPath || "").trim();
  if (!target) {
    return;
  }
  shell.openPath(target).catch((error: any) => {
    console.log(error);
  });
});

function cleanupPythonKillListener(killChannel: string) {
  ipcMain.removeAllListeners(killChannel);
}

/** Drop orphaned kill-* IPC listeners on Python child error or exit. Scoped to this process only (no single-instance lock). */
/** Avoid MPS hangs on ops like torchvision::nms during detection on Apple Silicon. */
function pythonShellEnvBase(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "darwin") {
    env.PYTORCH_ENABLE_MPS_FALLBACK = "1";
  }
  if (process.platform === "win32") {
    env.PYTHONIOENCODING = "utf-8";
  }
  return env;
}

function pythonShellEnv(): NodeJS.ProcessEnv {
  return pythonShellEnvBase();
}

type PythonShellOptions = {
  mode: "text" | "binary" | "json";
  pythonPath: string;
  scriptPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

function mergeHeavyJobEnv(
  label: string,
  partial: PythonShellOptions,
): { options: PythonShellOptions; release: () => void } {
  const job = createHeavyJobHandle(
    ioFairshareDir,
    homeDir,
    label,
    pythonShellEnvBase(),
  );
  return {
    options: { ...partial, env: job.env },
    release: job.release,
  };
}

function attachIoFairshareRelease(
  pyshell: InstanceType<typeof PythonShell>,
  release: () => void,
): () => void {
  let released = false;
  const onceRelease = () => {
    if (released) {
      return;
    }
    released = true;
    release();
  };
  pyshell.on("close", onceRelease);
  pyshell.on("error", onceRelease);
  return onceRelease;
}

function attachPythonShellKillCleanup(
  pyshell: InstanceType<typeof PythonShell>,
  killChannel: string,
) {
  const dropKillListener = () => {
    cleanupPythonKillListener(killChannel);
  };
  pyshell.on("error", function (err: unknown) {
    log(err);
    dropKillListener();
  });
  pyshell.on("close", function () {
    dropKillListener();
  });
}

/** When Python exits non-zero, python-shell passes a truthy err — never throw from IPC handlers. */
function describePythonShellFailure(
  err: unknown,
  code: unknown,
  signal: unknown,
): string | null {
  const c = typeof code === "number" ? code : null;
  const hasErr = err != null && err !== false;
  const badExit = c != null && c !== 0;
  if (!hasErr && !badExit) {
    return null;
  }
  let msg = "";
  if (hasErr && typeof err === "object" && err !== null) {
    const m = (err as { message?: string }).message;
    if (typeof m === "string" && m.length > 0) {
      msg = m;
    }
  }
  if (!msg && hasErr) {
    msg = String((err as { message?: unknown })?.message ?? err);
  }
  const bits: string[] = [];
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
ipcMain.on("runMax", function (event: any, data: any[]) {
  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: [
      "-o",
      String(data[1]),
      "-i",
      String(data[0]),
      "-d",
      String(data[2]),
      "-t",
      String(data[3]),
      "-g",
      "False",
    ],
  };
  const { options, release } = mergeHeavyJobEnv("max", partial);

  let pyshell = new PythonShell("max.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killMax");
  var total: number = 0;
  var current: number = 0;
  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        releaseJob();
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          reportPythonFailure(pyFail);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("maxResult");
        ipcMain.removeAllListeners("killMax");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  ipcMain.once("killMax", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

// Adjust
ipcMain.on("runAdjust", function (event: any, data: any[]) {
  var structPath = path.join(appDir, "csv/structure_map.pkl");

  const adjustArgs: string[] = [];
  appendFlagPathArg(adjustArgs, "-i", data[0]);
  appendFlagPathArg(adjustArgs, "-s", structPath);
  appendFlagPathArg(adjustArgs, "-a", data[1]);
  appendSliceListArg(adjustArgs, data, 2);
  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: adjustArgs,
  };
  const { options, release } = mergeHeavyJobEnv("adjust", partial);
  let pyshell = new PythonShell("adjust.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killAdjust");
  try {
    const parent = dialogParentWindow(event);
    if (parent && !parent.isDestroyed()) {
      parent.blur();
    }
  } catch (_e) {
    // best effort: blur should never block tool launch
  }
  var total: number = 0;
  var current: number = 0;
  let resultSent = false;
  let adjustViewerClosedHandshake = false;
  let saveExitKillTimer: ReturnType<typeof setTimeout> | null = null;
  const clearSaveExitKillTimer = () => {
    if (saveExitKillTimer != null) {
      clearTimeout(saveExitKillTimer);
      saveExitKillTimer = null;
    }
  };

  const finalizeAdjust = (
    cancelled: boolean,
    err: unknown,
    code: unknown,
    signal: unknown,
  ) => {
    clearSaveExitKillTimer();
    if (resultSent) {
      return;
    }
    resultSent = true;
    releaseJob();
    let pyFail = describePythonShellFailure(err, code, signal);
    if (cancelled) {
      pyFail = null;
    }
    if (pyFail) {
      reportPythonFailure(pyFail);
    } else {
      console.log("The exit code was: " + code);
      console.log("The exit signal was: " + signal);
    }
    event.sender.send("adjustResult", { cancelled });
    if (pyFail) {
      event.sender.send("adjustError", [pyFail]);
    }
    ipcMain.removeAllListeners("killAdjust");
    ipcMain.removeAllListeners("saveAndExitAdjust");
  };

  pyshell.on("stderr", function (stderr: string) {
    queueLogLineForUi(stderr);
  });
  pyshell.on("message", (message: string) => {
    const trimmed = String(message || "").trim();
    if (total === 0 && /^\d+$/.test(trimmed)) {
      total = Number(trimmed);
      return;
    }
    if (trimmed === "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        finalizeAdjust(false, err, code, signal);
      });
      return;
    }
    if (trimmed === "Viewer closed") {
      adjustViewerClosedHandshake = true;
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        finalizeAdjust(true, err, 0, signal);
      });
      return;
    }
    if (trimmed.startsWith("LOG:")) {
      queueLogLineForUi(trimmed);
      return;
    }
    if (total > 0) {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  pyshell.on("close", function (code: unknown, signal: unknown) {
    if (resultSent) {
      return;
    }
    const exitCode = typeof code === "number" ? code : Number(code) || 1;
    const gracefulClose = exitCode === 0 || adjustViewerClosedHandshake;
    if (gracefulClose) {
      finalizeAdjust(true, null, gracefulClose && exitCode !== 0 ? 0 : code, signal);
      return;
    }
    finalizeAdjust(false, null, code, signal);
  });

  const requestAdjustSaveExit = () => {
    if (resultSent) {
      return;
    }
    const imagesDir = String(data[0] ?? "").trim();
    if (imagesDir.length > 0) {
      try {
        fs.writeFileSync(path.join(imagesDir, ".adjust_save_exit"), "1", "utf8");
      } catch (_e) {
        // best effort
      }
    }
    try {
      pyshell.send("SAVE_EXIT\n");
    } catch (_e) {
      // best effort
    }
    clearSaveExitKillTimer();
    saveExitKillTimer = setTimeout(() => {
      if (!resultSent) {
        try {
          pyshell.kill();
        } catch (_e) {
          // best effort
        }
      }
    }, 3000);
  };

  ipcMain.once("saveAndExitAdjust", function () {
    requestAdjustSaveExit();
  });
  ipcMain.once("killAdjust", function () {
    clearSaveExitKillTimer();
    if (!resultSent) {
      pyshell.kill();
    }
  });
});

// Alignment
ipcMain.on("runAlign", function (event: any, data: any[]) {
  const modelPath = path.join(homeDir, "models/predictor.pt");
  const nrrdPath = path.join(homeDir, "nrrd");
  const mapPath = path.join(appDir, "csv/structure_map.pkl");

  const alignArgs: string[] = [];
  appendFlagPathArg(alignArgs, "-o", data[1]);
  appendFlagPathArg(alignArgs, "-i", data[0]);
  alignArgs.push("-w", String(data[2] ?? "").trim());
  appendFlagPathArg(alignArgs, "-a", data[3]);
  appendFlagPathArg(alignArgs, "-m", modelPath);
  appendFlagPathArg(alignArgs, "-n", nrrdPath);
  appendFlagPathArg(alignArgs, "-c", mapPath);
  alignArgs.push("-l", String(data[4] ?? "").trim());
  appendSliceListArg(alignArgs, data, 5);
  appendFlagPathArg(alignArgs, "-b", data[6]);
  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: alignArgs,
  };
  const { options, release } = mergeHeavyJobEnv("align", partial);
  let pyshell = new PythonShell("map.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killAlign");
  const alignParent = dialogParentWindow(event);
  handoffParentForExternalTool(alignParent);
  var total: number = 0;
  var current: number = 0;
  let resultSent = false;
  let alignViewerClosedHandshake = false;
  let alignSessionSavedOnClose = false;

  let saveExitKillTimer: ReturnType<typeof setTimeout> | null = null;
  const clearSaveExitKillTimer = () => {
    if (saveExitKillTimer != null) {
      clearTimeout(saveExitKillTimer);
      saveExitKillTimer = null;
    }
  };

  const finalizeAlign = (
    cancelled: boolean,
    err: unknown,
    code: unknown,
    signal: unknown,
  ) => {
    clearSaveExitKillTimer();
    if (resultSent) {
      return;
    }
    resultSent = true;
    releaseJob();
    let pyFail = describePythonShellFailure(err, code, signal);
    if (cancelled) {
      pyFail = null;
    }
    if (pyFail) {
      reportPythonFailure(pyFail);
    } else {
      console.log("The exit code was: " + code);
      console.log("The exit signal was: " + signal);
    }
    event.sender.send("alignResult", { cancelled });
    if (pyFail) {
      event.sender.send("alignError", [pyFail]);
    }
    restoreParentAfterExternalTool(alignParent);
    ipcMain.removeAllListeners("killAlign");
    ipcMain.removeAllListeners("saveAndExitAlign");
  };

  pyshell.on("stderr", function (stderr: string) {
    queueLogLineForUi(stderr);
  });

  pyshell.on("message", (message: string) => {
    const trimmed = String(message || "").trim();
    if (total === 0 && /^\d+$/.test(trimmed)) {
      total = Number(trimmed);
      return;
    }
    if (trimmed === "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        finalizeAlign(false, err, code, signal);
      });
      return;
    }
    if (trimmed === "Viewer closed") {
      alignViewerClosedHandshake = true;
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        finalizeAlign(true, err, 0, signal);
      });
      return;
    }
    if (/^LOG: align_session_saved reason=(window_close|cancel|viewer_close)/.test(trimmed)) {
      alignSessionSavedOnClose = true;
    }
    if (trimmed.startsWith("LOG:")) {
      queueLogLineForUi(trimmed);
      return;
    }
    if (total > 0) {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  pyshell.on("close", function (code: unknown, signal: unknown) {
    if (resultSent) {
      return;
    }
    const exitCode = typeof code === "number" ? code : Number(code) || 1;
    const gracefulClose =
      exitCode === 0 || alignViewerClosedHandshake || alignSessionSavedOnClose;
    if (gracefulClose) {
      finalizeAlign(true, null, gracefulClose && exitCode !== 0 ? 0 : code, signal);
      return;
    }
    finalizeAlign(false, null, code, signal);
  });

  const requestAlignSaveExit = () => {
    if (resultSent) {
      return;
    }
    const dapiDir = String(data[0] ?? "").trim();
    if (dapiDir.length > 0) {
      try {
        fs.writeFileSync(path.join(dapiDir, ".align_save_exit"), "1", "utf8");
      } catch (_e) {
        // best effort
      }
    }
    try {
      pyshell.send("SAVE_EXIT\n");
    } catch (_e) {
      // best effort
    }
    clearSaveExitKillTimer();
    saveExitKillTimer = setTimeout(() => {
      if (!resultSent) {
        try {
          pyshell.kill();
        } catch (_e) {
          // best effort
        }
      }
    }, 3000);
  };

  ipcMain.once("saveAndExitAlign", function () {
    requestAlignSaveExit();
  });
  ipcMain.once("killAlign", function () {
    clearSaveExitKillTimer();
    if (!resultSent) {
      pyshell.kill();
    }
  });
});

// Intensity by Region

ipcMain.on("runIntensity", function (event: any, data: any[]) {
  const structPath = path.join(appDir, "csv/structure_map.pkl");

  const args: string[] = [];
  appendFlagPathArg(args, "-i", data[0]);
  appendFlagPathArg(args, "-o", data[1]);
  appendFlagPathArg(args, "-a", data[2]);
  args.push("-w", String(data[3] ?? "").trim());
  appendFlagPathArg(args, "-m", structPath);
  const dapiDir =
    data.length > 4 && data[4] != null ? String(data[4]).trim() : "";
  if (dapiDir.length > 0) {
    appendFlagPathArg(args, "-d", dapiDir);
  }
  appendSliceListArg(args, data, 5);
  const configPath =
    data.length > 6 && data[6] != null ? String(data[6]).trim() : "";
  if (configPath.length > 0) {
    appendFlagPathArg(args, "--config", configPath);
  }

  let partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args,
  };

  const { options, release } = mergeHeavyJobEnv("intensity", partial);
  let pyshell = new PythonShell("region.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killIntensity");
  var total: number = 0;
  var current: number = 0;
  let intensityStderr = "";
  pyshell.on("stderr", function (stderr: string) {
    intensityStderr += stderr;
    queueLogLineForUi(stderr);
  });
  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        releaseJob();
        const pyFail = describePythonShellFailure(err, code, signal);
        const noPkls =
          intensityStderr.indexOf("NO_PKLS_WRITTEN") >= 0 ||
          intensityStderr.indexOf("wrote 0 PKL") >= 0;
        const errMsg =
          pyFail ||
          (noPkls
            ? "Isolate Regions wrote no PKL files. Check alignment, selected regions, layer mode, and whole vs hemisphere in the Application log."
            : null);
        if (errMsg) {
          reportPythonFailure(errMsg);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("intensityResult");
        if (errMsg) {
          event.sender.send("intensityError", [errMsg]);
        }
        ipcMain.removeAllListeners("killIntensity");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  ipcMain.once("killIntensity", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

// Export dual-channel ROI TIFs (DAPI + signal PKLs)
ipcMain.on("runExportDualTif", function (event: any, data: any[]) {
  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: ["-i", String(data[0]), "-o", String(data[1])],
  };
  const { options, release } = mergeHeavyJobEnv("dual", partial);
  let pyshell = new PythonShell("export_roi_dual_tif.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killExportDualTif");
  var total: number = 0;
  var current: number = 0;
  pyshell.on("stderr", function (stderr: string) {
    queueLogLineForUi(stderr);
  });
  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        releaseJob();
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          reportPythonFailure(pyFail);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("exportDualTifResult", pyFail ?? undefined);
        ipcMain.removeAllListeners("killExportDualTif");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });
  ipcMain.once("killExportDualTif", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

// Counting
ipcMain.on("runCount", function (event: any, data: any[]) {
  var structPath = path.join(appDir, "csv/structure_map.pkl");

  let custom_args = [
    "-p",
    String(data[0]),
    "-a",
    String(data[1]),
    "-o",
    String(data[2]),
    "-m",
    structPath,
  ];

  appendSliceListArg(custom_args, data, 3);

  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: custom_args,
  };
  const { options, release } = mergeHeavyJobEnv("count", partial);
  let pyshell = new PythonShell("count.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killCount");
  var total: number = 0;
  var current: number = 0;

  pyshell.on("stderr", function (stderr: string) {
    queueLogLineForUi(stderr);
  });

  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        releaseJob();
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          reportPythonFailure(pyFail);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("countResult");
        ipcMain.removeAllListeners("killCount");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  ipcMain.once("killCount", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

// Collate
ipcMain.on("runCollate", function (event: any, data: any[]) {
  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: [
      "-o",
      String(data[1]),
      "-i",
      String(data[0]),
      "-r",
      String(data[2] || ""),
      "-s",
      path.join(appDir, "csv/structure_map.pkl"),
      "-g",
      "False",
    ],
  };
  const { options, release } = mergeHeavyJobEnv("collate", partial);
  let pyshell = new PythonShell("collate.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killCollate");

  pyshell.end((err: unknown, code: unknown, signal: unknown) => {
    releaseJob();
    cleanupPythonKillListener("killCollate");
    const pyFail = describePythonShellFailure(err, code, signal);
    if (pyFail) {
      reportPythonFailure(pyFail);
    } else {
      console.log("The exit code was: " + code);
      console.log("The exit signal was: " + signal);
    }
    event.sender.send("collateResult");
  });

  ipcMain.once("killCollate", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

function handlePreprocessPreviewStdout(
  event: { sender: { send: (channel: string, payload: unknown) => void } },
  message: string,
  resultChannel: string
): boolean {
  if (!message.startsWith("PREVIEW_JSON:")) {
    return false;
  }
  try {
    const payload = JSON.parse(message.slice("PREVIEW_JSON:".length));
    event.sender.send(resultChannel, payload);
  } catch (err) {
    console.warn("Preview JSON parse failed:", err);
  }
  return true;
}

function spawnJsonResultScript(
  event: { sender: { send: (channel: string, payload: unknown) => void } },
  scriptName: string,
  args: string[],
  resultChannel: string,
  killChannel: string,
) {
  const options = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args,
    env: pythonShellEnv(),
  };
  const pyshell = new PythonShell(scriptName, options);
  attachPythonShellKillCleanup(pyshell, killChannel);
  let resultPayload: unknown = null;
  pyshell.on("message", (message: string) => {
    if (message.startsWith("RESULT:")) {
      try {
        resultPayload = JSON.parse(message.slice("RESULT:".length));
      } catch (parseErr) {
        console.warn("JSON result parse failed:", parseErr);
      }
      return;
    }
    if (message.startsWith("LOG:")) {
      queueLogLineForUi(message.slice("LOG:".length));
    } else {
      console.log(message);
    }
  });
  pyshell.end((err: unknown, code: unknown, signal: unknown) => {
    const pyFail = describePythonShellFailure(err, code, signal);
    if (pyFail) {
      reportPythonFailure(pyFail);
      event.sender.send(resultChannel, { ok: false, error: pyFail });
    } else if (resultPayload != null) {
      event.sender.send(resultChannel, resultPayload);
    } else {
      event.sender.send(resultChannel, {
        ok: false,
        error: "Script finished without result payload",
      });
    }
    ipcMain.removeAllListeners(killChannel);
  });
  ipcMain.once(killChannel, function () {
    pyshell.kill();
  });
}

ipcMain.on("runAnnotationLabelAudit", function (event: any, data: any[]) {
  const annodir = String(data[0] || "").trim();
  const structPath =
    String(data[1] || "").trim() || path.join(homeDir, "nrrd", "structure_map.pkl");
  const args: string[] = [];
  appendFlagPathArg(args, "--annotations", annodir);
  appendFlagPathArg(args, "--structures", structPath);
  spawnJsonResultScript(
    event,
    "annotation_label_audit.py",
    args,
    "annotationLabelAuditResult",
    "killAnnotationLabelAudit",
  );
});

function spawnPreprocessPreview(
  event: { sender: { send: (channel: string, payload: unknown) => void } },
  scriptName: string,
  args: string[],
  resultChannel: string,
  killChannel: string
) {
  const options = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args,
  };
  const pyshell = new PythonShell(scriptName, options);
  attachPythonShellKillCleanup(pyshell, killChannel);
  pyshell.on("message", (message: string) => {
    if (message.startsWith("PROGRESS:")) {
      const body = message.slice("PROGRESS:".length);
      const colon = body.indexOf(":");
      if (colon >= 0) {
        const pct = Number(body.slice(0, colon));
        const text = body.slice(colon + 1) || "Preview…";
        if (!Number.isNaN(pct)) {
          event.sender.send("updateLoad", [pct, text]);
        }
      }
      return;
    }
    if (!handlePreprocessPreviewStdout(event, message, resultChannel)) {
      console.log(message);
    }
  });
  pyshell.end((err: unknown, code: unknown, signal: unknown) => {
    const pyFail = describePythonShellFailure(err, code, signal);
    if (pyFail) {
      reportPythonFailure(pyFail);
      event.sender.send(resultChannel, { ok: false, error: pyFail });
    }
    ipcMain.removeAllListeners(killChannel);
  });
  ipcMain.once(killChannel, function () {
    pyshell.kill();
  });
}

ipcMain.on("runSharpenPreview", function (event: any, data: any[]) {
  const params = (data.length > 5 && data[5]) || {};
  const args: string[] = ["--preview"];
  appendFlagPathArg(args, "--image", String(data[0] || ""));
  args.push(
    "--x",
    String(data[1] ?? 0),
    "--y",
    String(data[2] ?? 0),
    "--w",
    String(data[3] ?? 512),
    "--h",
    String(data[4] ?? 512)
  );
  args.push("-r", String(params.radius != null ? params.radius : 3));
  args.push("-a", String(params.amount != null ? params.amount : 2));
  if (params.equalize) {
    args.push("-e");
  }
  const previewDir =
    params.previewDir != null ? String(params.previewDir).trim() : "";
  if (previewDir.length > 0) {
    appendFlagPathArg(args, "--preview-dir", previewDir);
  }
  spawnPreprocessPreview(
    event,
    "sharpen.py",
    args,
    "sharpenPreviewResult",
    "killSharpenPreview"
  );
});

ipcMain.on("runTophatPreview", function (event: any, data: any[]) {
  const params = (data.length > 5 && data[5]) || {};
  const args: string[] = ["--preview"];
  appendFlagPathArg(args, "--image", String(data[0] || ""));
  args.push(
    "--x",
    String(data[1] ?? 0),
    "--y",
    String(data[2] ?? 0),
    "--w",
    String(data[3] ?? 512),
    "--h",
    String(data[4] ?? 512)
  );
  args.push("-f", String(params.radius != null ? params.radius : 10));
  args.push("-c", String(params.gamma != null ? params.gamma : 1.25));
  const previewDir =
    params.previewDir != null ? String(params.previewDir).trim() : "";
  if (previewDir.length > 0) {
    appendFlagPathArg(args, "--preview-dir", previewDir);
  }
  spawnPreprocessPreview(
    event,
    "top_hat.py",
    args,
    "tophatPreviewResult",
    "killTophatPreview"
  );
});

function spawnPreprocessBatch(
  event: any,
  scriptName: string,
  args: string[],
  resultChannel: string,
  killChannel: string,
  jobId: string,
  launchMessage: string
) {
  const { evaluatePreprocessBatchResult } = require(
    path.join(appDir, "js", "preprocess_batch_completion")
  ) as { evaluatePreprocessBatchResult: (state: Record<string, unknown>) => { ok: boolean; message: string; warnOnly?: boolean } };

  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args,
  };
  const { options, release } = mergeHeavyJobEnv(jobId, partial);
  const pyshell = new PythonShell(scriptName, options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, killChannel);
  let total = 0;
  let completedCount = 0;
  let runFailed = false;
  let failMessage = "";
  let resultSent = false;

  const sendResult = (ok: boolean, code: number, message: string) => {
    if (resultSent) {
      return;
    }
    resultSent = true;
    event.sender.send(resultChannel, { ok, code, message });
    ipcMain.removeAllListeners(killChannel);
  };

  const finishBatch = (exitCode: number, pyFail: string | null) => {
    if (resultSent) {
      return;
    }
    releaseJob();
    const verdict = evaluatePreprocessBatchResult({
      runFailed,
      exitCode,
      pyFail: pyFail || "",
      total,
      completedCount,
      failMessage,
    });
    if (!verdict.ok && pyFail) {
      reportPythonFailure(pyFail);
    } else if (verdict.warnOnly && verdict.message) {
      console.log("[preprocess] " + verdict.message);
    }
    sendResult(verdict.ok, exitCode, verdict.message);
  };

  event.sender.send("updateLoad", [0, launchMessage]);
  pyshell.on("message", (message: string) => {
    if (message.startsWith("PREVIEW_JSON:")) {
      return;
    }
    if (
      message.includes("SHARPEN_NO_OUTPUT") ||
      message.includes("TOPHAT_NO_OUTPUT") ||
      message.includes("LOG: no input")
    ) {
      runFailed = true;
      failMessage = message.trim();
    }
    if (total === 0 && /^\d+$/.test(message.trim())) {
      total = Number(message);
    } else if (message === "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        const pyFail = describePythonShellFailure(err, code, signal);
        const exitCode = typeof code === "number" ? code : Number(code) || 0;
        finishBatch(exitCode, pyFail);
      });
    } else if (
      message.startsWith("LOG: sharpen_done ") ||
      message.startsWith("LOG: tophat_done ")
    ) {
      completedCount++;
      if (total > 0) {
        event.sender.send("updateLoad", [
          Math.round((completedCount / total) * 100),
          message,
        ]);
      }
    } else if (message.startsWith("LOG:")) {
      const pct =
        total > 0
          ? Math.min(99, Math.round((completedCount / total) * 100))
          : Math.min(99, completedCount);
      event.sender.send("updateLoad", [pct, message]);
    }
  });
  pyshell.on("close", (code: number) => {
    if (resultSent) {
      return;
    }
    const exitCode = typeof code === "number" ? code : Number(code) || 1;
    const pyFail =
      exitCode !== 0 ? `Python exited with code ${exitCode}` : "";
    finishBatch(exitCode, pyFail || null);
  });
  ipcMain.once(killChannel, function () {
    pyshell.kill();
  });
}

ipcMain.on("runTophat", function (event: any, data: any[]) {
  const args: string[] = ["-g", "False"];
  const first = data[0] != null ? String(data[0]).trim() : "";
  if (first.endsWith(".json")) {
    appendFlagPathArg(args, "-j", first);
  } else {
    appendFlagPathArg(args, "-i", data[0]);
    appendFlagPathArg(args, "-o", data[1]);
    args.push("-f", String(data[2] != null ? data[2] : 10));
    args.push("-c", String(data[3] != null ? data[3] : 1.25));
    if (data[4]) {
      appendFlagPathArg(args, "--slice-list", String(data[4]));
    }
  }
  spawnPreprocessBatch(
    event,
    "top_hat.py",
    args,
    "tophatResult",
    "killTophat",
    "tophat",
    "Launching top-hat filter…"
  );
});

ipcMain.on("runSharpen", function (event: any, data: any[]) {
  const args: string[] = [];
  const first = data[0] != null ? String(data[0]).trim() : "";
  if (first.endsWith(".json")) {
    appendFlagPathArg(args, "-j", first);
  } else {
    appendFlagPathArg(args, "-o", data[1]);
    appendFlagPathArg(args, "-i", data[0]);
    args.push("-r", String(data[2]));
    args.push("-a", String(data[3]));
    if (data[4]) {
      args.push("-e");
    }
  }
  spawnPreprocessBatch(
    event,
    "sharpen.py",
    args,
    "sharpenResult",
    "killSharpen",
    "sharpen",
    "Launching sharpen…"
  );
});

// Parcellation (bulk CCF rollup)
ipcMain.on("runParcellation", function (event: any, data: any[]) {
  const structPath = path.join(appDir, "csv/structure_map.pkl");
  const args: string[] = [];
  appendFlagPathArg(args, "-a", data[0]);
  appendFlagPathArg(args, "-s", structPath);
  const configPath =
    data.length > 1 && data[1] != null ? String(data[1]).trim() : "";
  if (configPath.length > 0) {
    appendFlagPathArg(args, "-j", configPath);
  }

  let partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args,
  };

  const { options, release } = mergeHeavyJobEnv("parcellation", partial);
  let pyshell = new PythonShell("apply_parcellation.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killParcellation");
  event.sender.send("updateLoad", [0, "Launching parcellation…"]);
  var total: number = 0;
  var current: number = 0;
  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        releaseJob();
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          reportPythonFailure(pyFail);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("parcellationResult");
        ipcMain.removeAllListeners("killParcellation");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        "Parcellation " + current + " / " + total,
      ]);
    }
  });

  ipcMain.once("killParcellation", function () {
    pyshell.kill();
  });
});

// DAPI cleanup
ipcMain.on("runDapiCleanup", function (event: any, data: any[]) {
  let args: string[] = ["-i", String(data[0] || "").trim(), "-o", String(data[1] || "").trim()];
  if (data[2]) {
    args.push("--isolate");
  } else {
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

  let partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: args,
  };
  const { options, release } = mergeHeavyJobEnv("dapi_cleanup", partial);
  let pyshell = new PythonShell("dapi_cleanup.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killDapiCleanup");
  var total: number = 0;
  var current: number = 0;
  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        releaseJob();
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          reportPythonFailure(pyFail);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("dapiCleanupResult");
        ipcMain.removeAllListeners("killDapiCleanup");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  ipcMain.once("killDapiCleanup", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

// Tissue edge cleanup wizard
ipcMain.on("runTissueCleanupAuto", function (event: any, data: any[]) {
  const args: string[] = ["--auto"];
  appendFlagPathArg(args, "-i", String(data[0] || ""));
  appendFlagPathArg(args, "-o", String(data[1] || ""));
  const edgeShrink = Number(data[2]);
  if (!Number.isNaN(edgeShrink)) {
    args.push("--edge-shrink", String(Math.max(0, Math.min(5, edgeShrink))));
  }
  spawnPreprocessPreview(
    event,
    "tissue_cleanup.py",
    args,
    "tissueCleanupAutoResult",
    "killTissueCleanup",
  );
});

ipcMain.on("runTissueCleanupGuided", function (event: any, data: any[]) {
  const args: string[] = ["--guided"];
  appendFlagPathArg(args, "-i", String(data[0] || ""));
  appendFlagPathArg(args, "-o", String(data[1] || ""));
  appendFlagPathArg(args, "--stroke-json", String(data[2] || ""));
  const edgeShrink = Number(data[3]);
  if (!Number.isNaN(edgeShrink)) {
    args.push("--edge-shrink", String(Math.max(0, Math.min(5, edgeShrink))));
  }
  spawnPreprocessPreview(
    event,
    "tissue_cleanup.py",
    args,
    "tissueCleanupGuidedResult",
    "killTissueCleanup",
  );
});

ipcMain.on("runTissueCleanupApply", function (event: any, data: any[]) {
  const bundleRoot = data[0] || "";
  const configPath = data[1] || "";
  const args: string[] = ["--apply"];
  appendCziPathArgs(args, bundleRoot, configPath);
  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args,
  };
  const { options, release } = mergeHeavyJobEnv("tissue_cleanup", partial);
  const pyshell = new PythonShell("tissue_cleanup.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killTissueCleanup");
  let total = 0;
  let current = 0;
  let resultPayload: Record<string, unknown> | null = null;
  let finished = false;
  event.sender.send("updateLoad", [0, "Launching tissue cleanup apply…"]);

  // Read the on-disk manifest as a last-resort source of truth. The apply
  // writes it (with ok/applied_files/slices) immediately before emitting the
  // RESULT line + "Done!", so if the in-band handshake is lost we can still
  // report an accurate result instead of leaving the UI hung.
  const readManifestResult = (): Record<string, unknown> | null => {
    try {
      const manifestPath = path.join(
        bundleRoot,
        ".masonjar",
        "tissue_cleanup_manifest.json"
      );
      if (fs.existsSync(manifestPath)) {
        return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      }
    } catch (_err) {
      // fall through to null
    }
    return null;
  };

  const readProgressResult = (): Record<string, unknown> | null => {
    try {
      const progressPath = path.join(
        bundleRoot,
        ".masonjar",
        "tissue_cleanup_apply_progress.json"
      );
      if (!fs.existsSync(progressPath)) {
        return null;
      }
      const progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
      const completed = Number(progress.completed) || 0;
      if (completed <= 0) {
        return null;
      }
      const total = Number(progress.files_total) || 0;
      const slices = progress.slices || {};
      return {
        ok: false,
        partial: true,
        applied_files: completed,
        files_total: total,
        slices_applied: Object.keys(slices).length,
        slices,
        failed: [],
        error: `Tissue cleanup interrupted after ${completed}/${total} file(s)`,
      };
    } catch (_err) {
      return null;
    }
  };

  const readFallbackResult = (): Record<string, unknown> | null => {
    const manifest = readManifestResult();
    if (manifest != null) {
      return manifest;
    }
    return readProgressResult();
  };

  const finalize = (payload: Record<string, unknown>) => {
    if (finished) return;
    finished = true;
    event.sender.send("tissueCleanupApplyResult", payload);
    ipcMain.removeAllListeners("killTissueCleanup");
  };

  pyshell.on("message", (message: string) => {
    if (message.startsWith("LOG:")) {
      const detail = message.slice(4);
      queueLogLineForUi(detail);
      event.sender.send("updateLoad", [
        total > 0 ? Math.min(99, Math.round((current / total) * 100)) : 5,
        detail,
      ]);
      return;
    }
    if (message.startsWith("RESULT:")) {
      try {
        resultPayload = JSON.parse(message.slice("RESULT:".length));
      } catch (parseErr) {
        console.warn("Tissue cleanup result parse failed:", parseErr);
      }
      return;
    }
    if (total === 0) {
      const n = Number(message.trim());
      if (!Number.isNaN(n) && n >= 0) {
        total = n;
        event.sender.send("updateLoad", [10, `Ready — ${n} file(s) to mask`]);
        return;
      }
    }
    if (message === "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        releaseJob();
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          reportPythonFailure(pyFail);
          const partial = readProgressResult();
          finalize(
            partial || { ok: false, error: pyFail },
          );
        } else if (resultPayload != null) {
          finalize(resultPayload);
        } else {
          const fallback = readFallbackResult();
          if (fallback && fallback.ok) {
            finalize(fallback);
          } else if (fallback) {
            finalize(fallback);
          } else {
            finalize({
              ok: false,
              error: "Tissue cleanup finished without result",
            });
          }
        }
      });
    } else if (total > 0) {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });
  // Safety net: if the process exits without us delivering a result via the
  // in-band "Done!" handshake (e.g. a terminal stdout line was dropped on a
  // very long job), still finalize from the on-disk manifest so the wizard
  // never hangs on step 3.
  pyshell.on("close", function () {
    releaseJob();
    if (finished) return;
    if (resultPayload != null) {
      finalize(resultPayload);
      return;
    }
    const fallback = readFallbackResult();
    if (fallback != null) {
      finalize(fallback);
    } else {
      finalize({
        ok: false,
        error: "Tissue cleanup process ended without a result",
      });
    }
  });
  pyshell.on("error", function (err: unknown) {
    releaseJob();
    if (finished) return;
    const fallback = readFallbackResult();
    if (fallback != null && fallback.ok) {
      finalize(fallback);
    } else if (fallback != null) {
      finalize(fallback);
    } else {
      finalize({
        ok: false,
        error: String((err as any) || "Tissue cleanup process error"),
      });
    }
  });
  ipcMain.once("killTissueCleanup", function () {
    pyshell.kill();
  });
});

// Cell Detection
ipcMain.on("runDetection", function (event: any, data: any[]) {
  // Set model path
  var models: { [key: string]: string } = {
    somata: "models/chaosdruid.pt",
    nuclei: "models/ankou.pt",
  };

  var sam_model_path = path.join(homeDir, "models/sam_vit_b.pth");

  let selected = data[6] as string;
  var modelPath = path.join(homeDir, models[selected]);
  // Switch over to custom if necessary
  if (data[4].length > 0) {
    modelPath = data[4];
  }

  let custom_args = [
    "-i",
    String(data[0]),
    "-o",
    String(data[1]),
    "-c",
    String(data[2]),
    "-t",
    String(data[3]),
    "-a",
    String(data[7]),
    "-s",
    sam_model_path,
    "-e",
    String(data[8]),
    "-m",
    modelPath,
  ];

  if (data[5]) {
    custom_args.push(`--multichannel`);
  }

  appendSliceListArg(custom_args, data, 9);
  if (data.length > 10 && data[10]) {
    custom_args.push("--per-slice-qc");
  }
  if (data.length > 11 && Number(data[11]) > 0) {
    custom_args.push("--intensity-min", String(data[11]));
  }

  const partial = {
    mode: "text" as const,
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: custom_args,
  };
  const { options, release } = mergeHeavyJobEnv("detect", partial);
  let pyshell = new PythonShell("find_neurons.py", options);
  const releaseJob = attachIoFairshareRelease(pyshell, release);
  attachPythonShellKillCleanup(pyshell, "killDetect");
  var total: number = 0;
  var current: number = 0;

  pyshell.on("stderr", function (stderr: string) {
    queueLogLineForUi(stderr);
  });

  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        releaseJob();
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          reportPythonFailure(pyFail);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("detectResult");
        ipcMain.removeAllListeners("killDetect");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  ipcMain.once("killDetect", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

function mapStartupProgressPct(startupPct: number): number {
  return 3 + Math.round(Math.min(100, Math.max(0, startupPct)) * 0.15);
}

function mapExtractItemProgressPct(itemPct: number): number {
  return 22 + Math.round(Math.min(100, Math.max(0, itemPct)) * 0.70);
}

function mapProbeProgressPct(itemPct: number): number {
  return 5 + Math.round(Math.min(100, Math.max(0, itemPct)) * 0.90);
}

/** One CZI PythonShell at a time per app process (probe or extract). */
let activeCziPythonShell: InstanceType<typeof PythonShell> | null = null;

function runCziPythonScript(
  event: any,
  scriptName: string,
  args: string[],
  killChannel: string,
  resultChannel: string,
) {
  if (activeCziPythonShell) {
    event.sender.send(resultChannel, {
      ok: false,
      error: "Another CZI job is already running in this app instance",
    });
    return;
  }

  const isProbe = scriptName === "czi_probe.py";
  const pythonExe = path.join(envPythonPath, pyCommand);
  queueLogLineForUi(`Launching Python: ${scriptName} (${pythonExe})`);
  event.sender.send("cziJobLog", `Launching Python: ${scriptName}`);

  const partial = {
    mode: "text" as const,
    pythonPath: pythonExe,
    scriptPath: pyScriptsPath,
    args: args,
  };
  const cziLabel =
    scriptName === "czi_extract.py"
      ? "czi_extract"
      : scriptName === "apply_geometry.py"
        ? "apply_geometry"
        : scriptName === "geometry_fingerprint_probe.py"
          ? "geometry_fingerprint_probe"
          : "czi";
  const jobBundle = isProbe
    ? { options: { ...partial, env: pythonShellEnv() }, release: () => undefined }
    : mergeHeavyJobEnv(cziLabel, partial);
  const pyshell = new PythonShell(scriptName, jobBundle.options);
  const releaseJob = attachIoFairshareRelease(pyshell, jobBundle.release);
  activeCziPythonShell = pyshell;
  let total = 0;
  let current = 0;
  let resultPayload: unknown = null;
  let processStarted = false;
  let resultSent = false;
  let doneMessageReceived = false;

  function releaseActiveCziShell() {
    if (activeCziPythonShell === pyshell) {
      activeCziPythonShell = null;
    }
  }

  function sendCziResult(payload: unknown) {
    if (resultSent) {
      return;
    }
    resultSent = true;
    releaseJob();
    releaseActiveCziShell();
    cleanupPythonKillListener(killChannel);
    event.sender.send(resultChannel, payload);
  }

  function finalizeCziFailure(err: unknown, code: unknown, signal: unknown) {
    const pyFail = describePythonShellFailure(err, code, signal);
    if (pyFail) {
      reportPythonFailure(pyFail);
      sendCziResult({ ok: false, error: pyFail });
      return;
    }
    sendCziResult({ ok: false, error: "CZI script ended without result" });
  }

  function ackProcessStarted() {
    if (!processStarted) {
      processStarted = true;
      queueLogLineForUi("Python process started");
      event.sender.send("cziJobLog", "Python process started");
    }
  }

  pyshell.on("error", function (err: unknown) {
    log(err);
    if (!resultSent) {
      sendCziResult({ ok: false, error: String(err) });
    }
  });

  pyshell.on("close", function (code: unknown, signal: unknown) {
    if (resultSent) {
      releaseActiveCziShell();
      cleanupPythonKillListener(killChannel);
      return;
    }
    if (doneMessageReceived) {
      return;
    }
    finalizeCziFailure(null, code, signal);
  });

  pyshell.on("stderr", function (stderr: string) {
    ackProcessStarted();
    queueLogLineForUi(stderr);
    const trimmed = stderr.trim();
    if (trimmed) {
      event.sender.send("cziJobLog", trimmed);
    }
  });
  pyshell.on("message", (message: string) => {
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
      } catch (parseErr) {
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
      doneMessageReceived = true;
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          reportPythonFailure(pyFail);
          sendCziResult({ ok: false, error: pyFail });
          return;
        }
        if (resultPayload != null) {
          sendCziResult(resultPayload);
        } else {
          sendCziResult({ ok: false, error: "CZI script finished without result payload" });
        }
      });
    } else if (isProbe) {
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
    } else {
      current++;
      const itemPct = total > 0 ? Math.round((current / total) * 100) : 0;
      const displayPct = mapExtractItemProgressPct(itemPct);
      event.sender.send("updateLoad", [displayPct, message]);
    }
  });

  ipcMain.once(killChannel, function () {
    pyshell.kill();
    if (!resultSent) {
      setTimeout(function () {
        if (!resultSent) {
          sendCziResult({ ok: false, error: "CZI job cancelled" });
        }
      }, 500);
    }
  });
}

ipcMain.on("runCziProbe", function (event: any, data: any[]) {
  const inputDir = data[0] || "";
  const probeArgs: string[] = [];
  appendCziInputArg(probeArgs, inputDir);
  runCziPythonScript(
    event,
    "czi_probe.py",
    probeArgs,
    "killCziProbe",
    "cziProbeResult",
  );
});

ipcMain.on("runCziImport", function (event: any, data: any[]) {
  const bundleRoot = data[0] || "";
  const configPath = data[1] || "";
  const importArgs: string[] = [];
  appendCziPathArgs(importArgs, bundleRoot, configPath);
  runCziPythonScript(
    event,
    "czi_extract.py",
    importArgs,
    "killCziImport",
    "cziImportResult",
  );
});

ipcMain.on("showLogWindow", function (event: { sender: { send: (channel: string, payload: unknown) => void } }) {
  logDismissedByUser = false;
  ensureLogWindowVisible({ force: true });
  replyLogWindowState(event);
});

ipcMain.on("getLogWindowState", function (event: { sender: { send: (channel: string, payload: unknown) => void } }) {
  replyLogWindowState(event);
});

ipcMain.on("toggleLogWindow", function (event: { sender: { send: (channel: string, payload: unknown) => void } }) {
  if (!logWin || logWin.isDestroyed()) {
    logDismissedByUser = false;
    ensureLogWindowVisible({ force: true });
    replyLogWindowState(event);
    return;
  }
  if (logWin.isVisible()) {
    hideLogWindowByUser();
  } else {
    logDismissedByUser = false;
    logWin.show();
    logWin.focus();
    flushLogUiQueue();
  }
  replyLogWindowState(event);
});

ipcMain.on("reportRendererError", function (_event: unknown, data: unknown[]) {
  const msg = String(data && data[0] != null ? data[0] : "Renderer error");
  ensureLogWindowVisible({ force: true });
  queueLogLineForUi(`Renderer: ${msg}`);
});

ipcMain.on("runApplyGeometry", function (event: any, data: any[]) {
  const bundleRoot = data[0] || "";
  const configPath = data[1] || "";
  const geometryArgs: string[] = [];
  appendCziPathArgs(geometryArgs, bundleRoot, configPath);
  runCziPythonScript(
    event,
    "apply_geometry.py",
    geometryArgs,
    "killApplyGeometry",
    "applyGeometryResult",
  );
});

ipcMain.on("runGeometryFingerprintProbe", function (event: any, data: any[]) {
  const bundleRoot = data[0] || "";
  const configPath = data[1] || "";
  const probeArgs: string[] = [];
  appendCziPathArgs(probeArgs, bundleRoot, configPath);
  runCziPythonScript(
    event,
    "geometry_fingerprint_probe.py",
    probeArgs,
    "killGeometryFingerprintProbe",
    "geometryFingerprintResult",
  );
});

function getBatchQueueDeps() {
  return {
    PythonShell,
    envPythonPath,
    pyCommand,
    pyScriptsPath,
    homeDir,
    appDir,
    ioFairshareDir,
    describePythonShellFailure,
    queueLogLineForUi,
    pythonShellEnv,
  };
}

ipcMain.on("getIoFairshareStatus", function (event: any) {
  event.sender.send("ioFairshareStatus", getIoFairshareStatus(ioFairshareDir, homeDir));
});

ipcMain.on("saveIoFairshareUserConfig", function (event: any, patch: IoFairshareUserConfig) {
  const saved = saveUserConfig(homeDir, patch || {});
  event.sender.send("ioFairshareStatus", getIoFairshareStatus(ioFairshareDir, homeDir));
  event.sender.send("ioFairshareUserConfigSaved", saved);
});

ipcMain.on(
  "saveIoFairshareSharedConfig",
  function (event: any, patch: Partial<IoFairshareSharedConfig>) {
    try {
      const saved = saveSharedConfig(ioFairshareDir, patch || {});
      resetLinkSpeedCache();
      event.sender.send("ioFairshareStatus", getIoFairshareStatus(ioFairshareDir, homeDir));
      event.sender.send("ioFairshareSharedConfigSaved", saved);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      event.sender.send("ioFairshareSharedConfigError", { message: message });
    }
  },
);

ipcMain.on("runBatch", function (event: any, plan: BatchPlan) {
  const { runBatchQueue } = require("./batch_queue") as typeof import("./batch_queue");
  void runBatchQueue(getBatchQueueDeps(), plan, {
    onProgress: (overallPct, message, detail) => {
      event.sender.send("batchProgress", [overallPct, message, detail || ""]);
    },
    onJobStart: (projectName, step, projectIndex, stepIndex) => {
      event.sender.send("batchJobStart", {
        project: projectName,
        step,
        projectIndex,
        stepIndex,
      });
    },
    onJobLog: (projectName, step, line) => {
      event.sender.send("batchJobLog", [projectName, step, line]);
    },
    onJobEnd: (result) => {
      event.sender.send("batchJobEnd", result);
    },
  }).then((result) => {
    event.sender.send("batchComplete", result);
  });
});

ipcMain.on("killBatch", function () {
  const { killBatchQueue } = require("./batch_queue") as typeof import("./batch_queue");
  killBatchQueue();
});
