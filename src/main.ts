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

var win: typeof BrowserWindow = null;
var logWin: typeof BrowserWindow = null;
var isQuitting = false;

/** Batch console mirroring to the log window to avoid IPC/DOM floods. */
const LOG_UI_FLUSH_MS = 150;
const LOG_UI_MAX_QUEUE = 4000;
const LOG_UI_CHUNK_LINES = 350;
let logUiQueue: string[] = [];
let logUiFlushTimer: ReturnType<typeof setTimeout> | null = null;

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

function resolveHomeDir(): string {
  const masonDir = path.join(app.getPath("home"), BRANDING.HOME_DIR);
  const legacyDir = path.join(app.getPath("home"), BRANDING.LEGACY_HOME_DIR);
  if (fs.existsSync(masonDir)) {
    return masonDir;
  }
  const legacyHasEnv =
    fs.existsSync(path.join(legacyDir, "python")) ||
    fs.existsSync(path.join(legacyDir, "benv"));
  if (legacyHasEnv) {
    console.log(
      "Using legacy Bell Jar data directory:",
      legacyDir,
    );
    return legacyDir;
  }
  return masonDir;
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

async function checkForUpdates(parentWin?: typeof BrowserWindow) {
  try {
    const response = await serverFetch(GITHUB_API_RELEASES, {
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
      console.warn(
        `Update check: GitHub API returned ${response.status}; skipping.`
      );
      return;
    }

    const data = await response.json();
    const latestVersionTag = data.tag_name as string | undefined;
    const latestCoerced = latestVersionTag
      ? semver.coerce(latestVersionTag)
      : null;
    const currentCoerced = semver.coerce(CURRENT_VERSION_TAG);

    if (
      latestCoerced &&
      currentCoerced &&
      semver.gt(latestCoerced, currentCoerced)
    ) {
      const userResponse = await dialog.showMessageBox(
        parentWin || undefined,
        {
          type: "info",
          title: "Update Available",
          message: "A new version of Mason Jar is available.",
          detail: `The latest version is ${latestCoerced.version}. Would you like to download it?`,
          buttons: ["Yes", "No"],
          defaultId: 0,
          cancelId: 1,
        }
      );

      if (userResponse.response === 0 && data.html_url) {
        shell.openExternal(data.html_url);
      }
    } else {
      console.log("No updates available.");
    }
  } catch (error) {
    // Network or parse errors should not block launch with a modal dialog.
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
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
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
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    closeable: true,
  });

  win.loadFile("pages/log.html");
  win.on("closed", () => {
    logWin = null;
  });

  return win;
}

function ensureLogWindowVisible(): boolean {
  if (!logWin || logWin.isDestroyed()) {
    logWin = createLogWindow();
    return true;
  }
  if (!logWin.isVisible()) {
    logWin.show();
  }
  logWin.focus();
  return true;
}

app.on("ready", () => {
  win = createWindow();
  logWin = createLogWindow();
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
    // Make a directory to house enviornment, settings, etc.yarn
    checkLocalDir();
    // Setup python for running the pipeline
    setupPython(win)
      .then((installed) => {
        // If we just installed python, we need to continue the complete
        // setup of the enviornment
        if (installed) {
          setupEnvironment(win);
        } else {
          // Otherwise, we can just update the dependencies
          updatePythonDependencies(win).then(() => {
            // Check for new patch
            // Check if any directories are missing
            fixMissingDirectories(win).then(() => {
              loadMenuAndCheckUpdates(win);
            });
          });
        }
      })
      .catch((error) => {
        // Python install failed
        console.log(error);
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
  checkForUpdates(parent || win);
});

ipcMain.on("getVersion", (event: any) => {
  event.sender.send("version", getVersion());
});

function parseDialogArg(data: any): { tag: string; defaultPath?: string } {
  if (typeof data === "string") {
    return { tag: data };
  }
  if (data && typeof data === "object") {
    const tag = data.tag != null ? String(data.tag) : String(data);
    const defaultPath =
      typeof data.defaultPath === "string" ? data.defaultPath : undefined;
    return { tag, defaultPath };
  }
  return { tag: String(data) };
}

function openDialogOptions(
  properties: ("openDirectory" | "openFile")[],
  defaultPath?: string,
): { properties: ("openDirectory" | "openFile")[]; defaultPath?: string } {
  const options: {
    properties: ("openDirectory" | "openFile")[];
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

function directoryDialogOptions(
  tag: string,
  defaultPath?: string,
): {
  properties: ("openDirectory" | "openFile")[];
  defaultPath?: string;
  title?: string;
  message?: string;
} {
  const options = openDialogOptions(["openDirectory"], defaultPath) as {
    properties: ("openDirectory" | "openFile")[];
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

function cleanupPythonKillListener(killChannel: string) {
  ipcMain.removeAllListeners(killChannel);
}

/** Drop orphaned kill-* IPC listeners on Python child error or exit. Scoped to this process only (no single-instance lock). */
/** Avoid MPS hangs on ops like torchvision::nms during detection on Apple Silicon. */
function pythonShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "darwin") {
    env.PYTORCH_ENABLE_MPS_FALLBACK = "1";
  }
  if (process.platform === "win32") {
    env.PYTHONIOENCODING = "utf-8";
  }
  return env;
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
  var total: number = 0;
  var current: number = 0;
  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
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

  let options = {
    mode: "text",
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: [`-i ${data[0]}`, `-s ${structPath}`, `-a ${data[1]}`],
  };
  appendSliceListArg(options.args, data, 2);
  let pyshell = new PythonShell("adjust.py", options);
  attachPythonShellKillCleanup(pyshell, "killAdjust");
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
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("adjustResult");
        ipcMain.removeAllListeners("killAdjust");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });
  ipcMain.once("killAdjust", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

// Alignment
ipcMain.on("runAlign", function (event: any, data: any[]) {
  const modelPath = path.join(homeDir, "models/predictor.pt");
  const nrrdPath = path.join(homeDir, "nrrd");
  const mapPath = path.join(appDir, "csv/structure_map.pkl");

  let options = {
    mode: "text",
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: [
      `-o ${data[1]}`,
      `-i ${data[0]}`,
      `-w ${data[2]}`,
      `-a ${data[3]}`,
      `-m ${modelPath}`,
      `-n ${nrrdPath}`,
      `-c ${mapPath}`,
      `-l ${data[4]}`,
    ],
  };
  appendSliceListArg(options.args, data, 5);
  let pyshell = new PythonShell("map.py", options);
  attachPythonShellKillCleanup(pyshell, "killAlign");
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
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("alignResult");
        ipcMain.removeAllListeners("killAlign");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  ipcMain.once("killAlign", function (event: any, data: any[]) {
    pyshell.kill();
  });
});

// Intensity by Region

ipcMain.on("runIntensity", function (event: any, data: any[]) {
  const structPath = path.join(appDir, "csv/structure_map.pkl");

  const args: string[] = [
    `-i ${data[0]}`,
    `-o ${data[1]}`,
    `-a ${data[2]}`,
    `-w ${data[3]}`,
    `-m ${structPath}`,
  ];
  const dapiDir =
    data.length > 4 && data[4] != null ? String(data[4]).trim() : "";
  if (dapiDir.length > 0) {
    args.push(`-d ${dapiDir}`);
  }
  appendSliceListArg(args, data, 5);

  let options = {
    mode: "text",
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args,
  };

  let pyshell = new PythonShell("region.py", options);
  attachPythonShellKillCleanup(pyshell, "killIntensity");
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
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("intensityResult");
        if (pyFail) {
          event.sender.send("intensityError", [pyFail]);
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
  let options = {
    mode: "text",
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: [String.raw`-i ${data[0]}`, String.raw`-o ${data[1]}`],
  };
  let pyshell = new PythonShell("export_roi_dual_tif.py", options);
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
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
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
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
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
  let options = {
    mode: "text",
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: [
      String.raw`-o ${data[1]}`,
      String.raw`-i ${data[0]}`,
      `-r ${data[2]}`,
      String.raw`-s ${path.join(appDir, "csv/structure_map.pkl")}`,
      "-g False",
    ],
  };
  let pyshell = new PythonShell("collate.py", options);
  attachPythonShellKillCleanup(pyshell, "killCollate");

  pyshell.end((err: unknown, code: unknown, signal: unknown) => {
    cleanupPythonKillListener("killCollate");
    const pyFail = describePythonShellFailure(err, code, signal);
    if (pyFail) {
      queueLogLineForUi(pyFail);
      console.error(pyFail, err);
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

// Collate
ipcMain.on("runSharpen", function (event: any, data: any[]) {
  let custom = [
    String.raw`-o ${data[1]}`,
    String.raw`-i ${data[0]}`,
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
  var total: number = 0;
  var current: number = 0;
  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
        } else {
          console.log("The exit code was: " + code);
          console.log("The exit signal was: " + signal);
        }
        event.sender.send("sharpenResult");
        ipcMain.removeAllListeners("killSharpen");
      });
    } else {
      current++;
      event.sender.send("updateLoad", [
        Math.round((current / total) * 100),
        message,
      ]);
    }
  });

  ipcMain.once("killSharpen", function (event: any, data: any[]) {
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

  let options = {
    mode: "text",
    pythonPath: path.join(envPythonPath, pyCommand),
    scriptPath: pyScriptsPath,
    args: args,
  };
  let pyshell = new PythonShell("dapi_cleanup.py", options);
  attachPythonShellKillCleanup(pyshell, "killDapiCleanup");
  var total: number = 0;
  var current: number = 0;
  pyshell.on("message", (message: string) => {
    if (total === 0) {
      total = Number(message);
    } else if (message == "Done!") {
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
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
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
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

function runCziPythonScript(
  event: any,
  scriptName: string,
  args: string[],
  killChannel: string,
  resultChannel: string,
) {
  const isProbe = scriptName === "czi_probe.py";
  const pythonExe = path.join(envPythonPath, pyCommand);
  queueLogLineForUi(`Launching Python: ${scriptName} (${pythonExe})`);
  event.sender.send("cziJobLog", `Launching Python: ${scriptName}`);

  const options = {
    mode: "text" as const,
    pythonPath: pythonExe,
    scriptPath: pyScriptsPath,
    args: args,
    env: pythonShellEnv(),
  };
  const pyshell = new PythonShell(scriptName, options);
  attachPythonShellKillCleanup(pyshell, killChannel);
  let total = 0;
  let current = 0;
  let resultPayload: unknown = null;
  let processStarted = false;

  function ackProcessStarted() {
    if (!processStarted) {
      processStarted = true;
      queueLogLineForUi("Python process started");
      event.sender.send("cziJobLog", "Python process started");
    }
  }

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
      pyshell.end((err: unknown, code: unknown, signal: unknown) => {
        const pyFail = describePythonShellFailure(err, code, signal);
        if (pyFail) {
          queueLogLineForUi(pyFail);
          console.error(pyFail, err);
        }
        event.sender.send(resultChannel, pyFail ? { ok: false, error: pyFail } : resultPayload);
        cleanupPythonKillListener(killChannel);
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

ipcMain.on("showLogWindow", function () {
  ensureLogWindowVisible();
});

ipcMain.on("toggleLogWindow", function () {
  if (!logWin || logWin.isDestroyed()) {
    ensureLogWindowVisible();
    return;
  }
  if (logWin.isVisible()) {
    logWin.hide();
  } else {
    logWin.show();
    logWin.focus();
  }
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

ipcMain.on("runBatch", function (event: any, plan: BatchPlan) {
  const { runBatchQueue } = require("./batch_queue") as typeof import("./batch_queue");
  void runBatchQueue(
    getBatchQueueDeps(),
    plan,
    (overallPct, message, detail) => {
      event.sender.send("batchProgress", [overallPct, message, detail || ""]);
    },
    (projectName, step) => {
      event.sender.send("batchJobStart", { project: projectName, step });
    },
  ).then((result) => {
    event.sender.send("batchComplete", result);
  });
});

ipcMain.on("killBatch", function () {
  const { killBatchQueue } = require("./batch_queue") as typeof import("./batch_queue");
  killBatchQueue();
});
