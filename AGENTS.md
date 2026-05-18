# AGENTS.md — working on Mason Jar

Mason Jar is an Electron desktop app for mouse brain neurohistology (alignment, projections, intensity, detection, counting, collation). It is a fork of Bell Jar with dual compatibility for legacy Bell Jar paths. This file orients contributors and coding agents.

## Branding and dual compatibility

Shared constants live in [`js/branding.js`](js/branding.js) (renderer) and `BRANDING` in [`src/main.ts`](src/main.ts) (main process):

| Constant | New (default) | Legacy (still accepted) |
|----------|---------------|-------------------------|
| Product name | `Mason Jar` | `Bell Jar` (credits only) |
| User data dir | `~/.masonjar` | `~/.belljar` (fallback if mason missing but legacy has python/benv) |
| Log file | `masonjar.log` | read legacy dir if using `~/.belljar` |
| Bundle suffix | `.masonjar` | `.belljar` |
| Project file | `project.masonjar` | `project.belljar` |
| Meta dir | `.masonjar/` | `.belljar/` |
| Layout id | `masonjar_v1` | `belljar_v1` |
| localStorage keys | `masonjar.*` | migrate/read `belljar.*` once |

UI theme: [`css/theme.css`](css/theme.css) (amber/sage) linked after Bootstrap on all pages.

Updates API: `https://api.github.com/repos/matsojr22/masonjar/releases/latest`. Model CDN remains `storage.googleapis.com/belljar_updates`.

## Repository layout

| Path | Purpose |
|------|---------|
| `src/main.ts` | Electron **main process** (authoritative source): windows, `~/.masonjar` bootstrap (legacy `~/.belljar` fallback), IPC, `python-shell` workers |
| `main.js` | **Emitted** JavaScript from TypeScript (`tsconfig.json` sets `outDir` to the repo root). **Edit `src/main.ts`, then compile** so `main.js` stays in sync. |
| `pages/`, `css/`, `js/` | Renderer UI: static HTML, Bootstrap + theme, vanilla JS using `ipcRenderer` |
| `py/` | **Legacy Python** scripts the packaged app runs (`PythonShell`, `scriptPath: app/py`) |
| `vendor/rsat` | Optional **git submodule** pointing at [asoronow/rsat](https://github.com/asoronow/rsat) — for source alignment; see **RSAT** below |
| `python/src/belljar/` | **Modern Python package**: typed pipeline steps, Pydantic config, CLI, JSON-RPC server (`belljar server`) — not wired to Electron today |
| `python/tests/` | `pytest` suite for the `belljar` package |
| `docs/belljar_guide.pdf` | User-facing workflow guide |

## Main process bootstrap (`~/.masonjar`)

On startup (`app.on("ready")` → `did-finish-load`), the main process uses `resolveHomeDir()`: prefer `~/.masonjar`; if missing and `~/.belljar` has `python/` or `benv`, use the legacy directory.

1. **`checkLocalDir()`** — ensures the resolved home dir exists.
2. **`setupPython(win)`** — if `{homeDir}/python` is missing, downloads a **standalone CPython 3.10.13** tarball from `https://storage.googleapis.com/belljar_updates/` (platform-specific: Windows, Linux x64, macOS Intel vs Apple Silicon), extracts into `homeDir`.
3. **First-time path** (`setupPython` resolves `true`): **`setupEnvironment(win)`** — `downloadResources(win, true)` pulls **embeddings**, **models**, **nrrd** archives into `homeDir`, then:
   - `installVenv`: `python -m pip install --user virtualenv` with `cwd` = extracted `python/` (or `python/bin/` on Unix — see `pythonPath` / `pyCommand` in `src/main.ts`).
   - `createVenv`: `python -m venv` targeting `{homeDir}/benv` (`benv`).
   - `installDeps`: `pip install -r py/requirements.txt` with `cwd` = venv’s `Scripts/` or `bin/`.
   - Loads `pages/index.html` on success.
4. **Returning user path** (`setupPython` resolves `false` when `python` and `benv` already exist): **`updatePythonDependencies`** then **`fixMissingDirectories`** (incremental `downloadResources(win, false)` using `manifest.json` version keys vs embedded `currnet_versions`), then loads `pages/index.html`.

**Path constants** (under resolved `homeDir`, typically `~/.masonjar` or legacy `~/.belljar`):

- `pythonPath` → `{homeDir}/python/` (Windows) or `{homeDir}/python/bin/` (Unix) for the embedded interpreter.
- `envPath` → `{homeDir}/benv` (virtualenv).
- `envPythonPath` → `benv/Scripts` (Windows) or `benv/bin` (Unix) — used for **`pip install`** and as **`pythonPath` passed to `PythonShell`** (script runner uses `pyCommand`: `python.exe` or `./python3`).

**Logs**: `console.log` is wrapped and **batched** to the log window (bounded queue + flush interval); `before-quit` drains the queue. The log page caps DOM lines and localStorage size ([js/log.js](js/log.js)). `createLogFile` appends to `{homeDir}/masonjar.log` on some failure paths.

## IPC: renderer → main → Python

Renderer scripts use `require("electron").ipcRenderer`. Main handlers are `ipcMain.on(...)` in `src/main.ts`.

### Channels the renderer sends

| `ipc.send` channel | Main handler | Legacy `py/` script | Notes |
|--------------------|-------------|---------------------|--------|
| `getVersion` | `getVersion` | — | Reply: `version` |
| `openDialog` | `openDialog` | — | Reply: `returnPath` `[path, tag]` |
| `openFileDialog` | `openFileDialog` | — | Reply: `returnPath` |
| `openGuide` | `openGuide` | — | Opens `docs/belljar_guide.pdf` |
| `runMax` | `runMax` | `max.py` | Progress: `updateLoad`; done: `maxResult` |
| `killMax` | once `killMax` | — | Kills max job |
| `runAdjust` | `runAdjust` | `adjust.py` | `adjustResult`, `updateLoad` |
| `killAdjust` | once `killAdjust` | — | |
| `runAlign` | `runAlign` | `map.py` | `alignResult`, `updateLoad` |
| `killAlign` | once `killAlign` | — | |
| `runIntensity` | `runIntensity` | `region.py` | `intensityResult`, `updateLoad`. Optional 5th arg: DAPI directory → `-d` (same stem as intensity files; see `region.py` for supported extensions) |
| `killIntensity` | once `killIntensity` | — | |
| `runExportDualTif` | `runExportDualTif` | `export_roi_dual_tif.py` | `exportDualTifResult`, `updateLoad` |
| `killExportDualTif` | once `killExportDualTif` | — | |
| `runCount` | `runCount` | `count.py` | `countResult`, `updateLoad` |
| `killCount` | once `killCount` | — | |
| `runCollate` | `runCollate` | `collate.py` | `collateResult` |
| `killCollate` | once `killCollate` | — | Cancel for collate (renderer must send this name) |
| `runSharpen` | `runSharpen` | `sharpen.py` | `sharpenResult`, `updateLoad` |
| `killSharpen` | once `killSharpen` | — | |
| `runDetection` | `runDetection` | `find_neurons.py` | `detectResult`, `updateLoad` |
| `killDetect` | once `killDetect` | — | |

### Channels the main process pushes (selection)

| Channel | Typical use |
|---------|----------------|
| `updateStatus` | Loading / setup / download status (`loading.html`) |
| `updateLoad` | `[percent, message]` progress for long jobs |
| `log` | Log window stream |
| `version` | Reply to `getVersion` |
| `returnPath` | Directory or file picker result |

Some renderer files register `*Error` listeners (e.g. `alignError`, `detectError`). The main process logs Python non-zero exits to the Log and avoids throwing; **Isolate Regions** also emits `intensityError` with a short message after `intensityResult` when Python fails.

## Isolate Regions PKL schema (with DAPI)

**Pairing** ([py/region.py](py/region.py)): each intensity image is matched to an Align annotation PKL by slice id (case-insensitive), not by sorted list index. Accepts **`Annotation_{id}.pkl`** (as written by [py/map.py](py/map.py)), plain **`{id}.pkl`**, and the map.py stripped basename (e.g. `M528_s061.ome.tiff` → `Annotation_M528_s061.pkl` or `Annotation_M528_s061.ome.pkl`). Slice id is the part before the first dot (`M528_s061`).

When DAPI is enabled in **Isolate Regions** ([pages/intensity.html](pages/intensity.html)), each ROI pickle may include:

- `roi`: sparse `(y,x) → uint8` signal (unchanged).
- `name`: region acronym.
- `dapi_roi`: same keys as `roi`, values from DAPI resized to the intensity grid.
- `channel_order_tif`: `["DAPI", "signal"]` for downstream two-channel TIFs.

**Export dual-channel ROI TIFs** ([pages/dual_export.html](pages/dual_export.html)) runs [py/export_roi_dual_tif.py](py/export_roi_dual_tif.py) and writes `*_dual.tif` (ImageJ hyperstack: channel 1 DAPI, channel 2 signal).

## RSAT submodule

Upstream RSAT’s `py/main.py` imports `train_seg` at load time (PyTorch Lightning / Transformers). That is **not** imported from the Mason Jar Electron venv. The repo may include **`vendor/rsat`** as a **git submodule** for reference and future refactors; runtime export uses `export_roi_dual_tif.py` only. Clone once with:

`git submodule update --init --recursive`

(or `git submodule add https://github.com/asoronow/rsat.git vendor/rsat` when first adding).

## Which Python to change

- **Electron app behavior** (what users run from the menu): change **`py/`** scripts and any IPC args in **`src/main.ts`** / **`js/*.js`**. Recompile TypeScript to refresh **`main.js`** before release or if your environment uses `main.js` directly.
- **Library, headless runs, automated tests, or future JSON-RPC integration**: change **`python/src/belljar/`**, expose steps via **`python/src/belljar/cli.py`** or **`python/src/belljar/server.py`**, and add tests under **`python/tests/`**.

Avoid implementing the same behavior twice in `py/` and `python/src/belljar/` without a deliberate migration plan. The JSON-RPC server (`belljar server`) is a single long-lived stdin/stdout process; Electron today uses **one short-lived `PythonShell` per tool run**.

## Local development

- **Electron app**: install Node/Yarn per `README.md`, then `yarn install` and `yarn start`.
- **Compile main process TS**: `yarn compile` (runs `tsc`). **Commit updated `main.js` when you change `src/main.ts`**, unless your team standardizes otherwise.
- **Python package**: from `python/`, install in editable mode (`pip install -e .` / Hatch) and run `belljar --help` or pytest.

## Packaging

`forge.config.js` uses `asar: false` and excludes `src/` from the packager ignore list’s intent is that shipped bits include **`main.js`**, **`py/`**, assets, and **`pages/`** / **`js/`** — not TypeScript sources.

## CI

This snapshot may not include `.github/` workflows; confirm on the branch you use before assuming automated checks.

## Memory debugging (long Windows sessions)

If RAM grows over days while the UI looks idle, confirm where it grows before changing code:

1. **Process Explorer** (or Task Manager “Details”): note each `electron.exe` / Mason Jar **PID** and **Working Set**. Check whether growth is in the **log window renderer** vs **main** vs **GPU** process.
2. **Chromium DevTools**: start the app with a remote-debugging port if needed, attach to the **log** `BrowserWindow` (`pages/log.html`), take a **heap snapshot**, and look for retained strings / DOM under the log container.
3. **Repro**: leave the app open, run a verbose pipeline step (e.g. alignment), and watch log DOM / process memory over time.

The main process batches lines to the log window, and the log UI caps stored lines; per-progress spam to `console.log` in Python handlers is reduced so progress still uses `updateLoad` IPC.
