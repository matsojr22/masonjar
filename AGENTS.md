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
| Project file | `{name}.masonjar` (e.g. `M528.masonjar` in `M528_masonjar/`) | `project.belljar` / `project.masonjar` |
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
   - Loads `pages/menu.html` on success (start hub).
4. **Returning user path** (`setupPython` resolves `false` when `python` and `benv` already exist): **`updatePythonDependencies`** then **`fixMissingDirectories`** (incremental `downloadResources(win, false)` using `manifest.json` version keys vs embedded `currnet_versions`), then loads `pages/menu.html`.

**Path constants** (under resolved `homeDir`, typically `~/.masonjar` or legacy `~/.belljar`):

- `pythonPath` → `{homeDir}/python/` (Windows) or `{homeDir}/python/bin/` (Unix) for the embedded interpreter.
- `envPath` → `{homeDir}/benv` (virtualenv).
- `envPythonPath` → `benv/Scripts` (Windows) or `benv/bin` (Unix) — used for **`pip install`** and as **`pythonPath` passed to `PythonShell`** (script runner uses `pyCommand`: `python.exe` or `./python3`).

**Logs**: `console.log` is wrapped and **batched** to the log window (bounded queue + flush interval); `before-quit` drains the queue. The log UI is **ephemeral per app launch** ([js/log.js](js/log.js)): main sends `resetLogSession` with a new session id on each process start; the log window does **not** restore or persist HTML to `localStorage` (legacy `log` / `logTime` keys are cleared). DOM is capped at 8000 lines. `createLogFile` appends to `{homeDir}/masonjar.log` on some failure paths. The log window is **closeable**; when closed, `logWin` is nulled and recreated on demand (same session, empty DOM). Hub **Application log** ([`pages/menu.html`](pages/menu.html), [`pages/workspace_menu.html`](pages/workspace_menu.html)) sends `toggleLogWindow` / `showLogWindow` (preference `masonjar.showLogWindow`).

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
| `runDapiCleanup` | `runDapiCleanup` | `dapi_cleanup.py` | `dapiCleanupResult`, `updateLoad`. Args: input dir, output dir, isolate, CLAHE, saturation %, backup dir (in-place), slice list, re-backup, optional bg value. Separate `-i`/`-o` argv tokens for Windows paths with spaces. In-place mode backs up originals to `data/counting/00_dapi_backup/`; separate mode writes `data/counting/00_dapi_clean/` without touching `00_dapi`. |
| `killDapiCleanup` | once `killDapiCleanup` | — | |
| `runDetection` | `runDetection` | `find_neurons.py` | `detectResult`, `updateLoad`. Optional 10th IPC element: slice-list path (`--slice-list`). `-o` is the run output leaf directory. |
| `killDetect` | once `killDetect` | — | |
| `runCziProbe` | `runCziProbe` | `czi_probe.py` | `cziProbeResult` (JSON payload), `updateLoad`. Arg: CZI directory. |
| `killCziProbe` | once `killCziProbe` | — | |
| `runCziImport` | `runCziImport` | `czi_extract.py` | `cziImportResult`, `updateLoad`. Args: bundle root, import config JSON path. Main passes `-b` and `-j` as **separate argv tokens** (required for Windows paths with spaces). |
| `killCziImport` | once `killCziImport` | — | |
| `runApplyGeometry` | `runApplyGeometry` | `apply_geometry.py` | `applyGeometryResult`, `updateLoad`. Args: bundle root, config JSON (includes `geometry` map). |
| `killApplyGeometry` | once `killApplyGeometry` | — | |
| `showLogWindow` | `showLogWindow` | — | Recreate or show/focus `pages/log.html`. |
| `toggleLogWindow` | `toggleLogWindow` | — | Show/focus log window if hidden or closed; otherwise hide (does not destroy). |

### Channels the main process pushes (selection)

| Channel | Typical use |
|---------|----------------|
| `updateStatus` | Loading / setup / download status (`loading.html`) |
| `updateLoad` | `[percent, message]` progress for long jobs |
| `cziJobLog` | Detail line from CZI Python (`LOG:` prefix); does not advance extract progress counter |
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

## Atlas alignment viewer, flags, and prediction runs

### Alignment (Napari / [`py/map.py`](py/map.py))

The left **Controls** dock shows the current **slice index and filename**, and the viewer / window title is kept in sync. Optional **Flag section…** appends one JSON object per line to **`<align output / 01_slices>/.masonjar/alignment_flags.json`** (same directory tree as warped outputs / `Annotation_*.pkl`), e.g. `{ "sliceId", "filename", "index", "note", "timestamp" }`. This keeps notes out of `alignment.pkl` in the input folder.

### Run-aware output organization (all pipeline steps)

Shared contract: [`js/pipeline_runs.js`](js/pipeline_runs.js), [`py/run_manifest.py`](py/run_manifest.py).

| Step | Output role | Branch | Example leaf | Manifest writer |
|------|-------------|--------|--------------|-----------------|
| Max projection | `max` | `max` | `03_max/max/<slug>/` | [`py/max.py`](py/max.py) |
| Sharpen | `max` | `sharpen` | `03_max/sharpen/<slug>/` | [`py/sharpen.py`](py/sharpen.py) |
| Align | `slices` | `align` | `01_slices/align/<slug>/` | [`py/map.py`](py/map.py) |
| Isolate regions | `pkls` | `intensity` | `07_pkls/intensity/<slug>/` | [`py/region.py`](py/region.py) |
| Cell detection | `predictions` | model branch | `05_predictions/somata/<slug>/` | [`py/find_neurons.py`](py/find_neurons.py) |
| Count | `quantification` | `count` | `06_quantification/count/<slug>/` | [`py/count.py`](py/count.py) |
| Collate | `quantification` | `collate` | `06_quantification/collate/<slug>/` | [`py/collate.py`](py/collate.py) |
| Dual export | `dual` | `dual` | `08_dual/dual/<slug>/` | [`py/export_roi_dual_tif.py`](py/export_roi_dual_tif.py) |

- **Project state**: `processing.active_runs[<role>]` stores the path relative to that role’s base (e.g. `align/M528_s027-…`, `somata/M528_…`). Legacy `active_prediction_run` migrates to `active_runs.predictions` on open.
- **Flat legacy checkbox**: each output step page offers *Write outputs directly to the output folder*; when checked, `-o` stays the role root for that run only.
- **Indexing**: [`js/file_index.js`](js/file_index.js) indexes output roles only under the **active run leaf** (no blind merge of sibling run folders). Full run inventory for pickers lives in `.masonjar/runs_catalog.json` on rescan.
- **Import**: [`project.importSourceToRoleWithLayout`](js/project.js) preserves nested run trees; flat files in a mixed source go to `import_<ISO-date>/`.
- **Downstream IO**: tools resolve inputs from active upstream leaves via `pipeline_runs.resolveInputLeafAbsForStep` (sharpen reads `max/max/…`, count reads active `predictions` + `slices`, etc.). Batch [`resolvePathsForBundle`](js/project.js) uses the same active leaves.

Input-only roles (`dapi`, `original_scans`) stay flat at the role root; `active_runs` is unused for them.

### Count pairing and active runs

[`py/count.py`](py/count.py) pairs **`Predictions_*.pkl`** with **`Annotation_*.pkl`** by **shared slice stem**. In project mode, the **Count** page selects active **predictions** and **slices** runs; output goes to `quantification/count/<slug>/`. [`js/pipeline_run.js`](js/pipeline_run.js) filters the count slice list to slices with a matching prediction PKL in the active predictions leaf and an annotation in the active slices leaf.

### Viewer/Editor (adjust) stem pairing

[`py/adjust.py`](py/adjust.py) pairs DAPI images to annotation PKLs by **slice stem** (via [`py/slice_index.py`](py/slice_index.py)), not sorted folder order. In project mode, [`js/adjust.js`](js/adjust.js) passes a **`--slice-list`** from matched DAPI + **active slices** leaf pairs through IPC.

The PyQt viewer shows a **Background channel** bar: **DAPI** from `00_dapi` (**PNG** preferred; legacy `.tif` fallback with log) plus optional low-res previews from `data/counting/_previews/{sliceId}_{branch}.png` (legacy `.tif` still accepted; see [`py/adjust_channels.py`](py/adjust_channels.py); optional `--previews-dir`). Switching channels reloads only the background image; annotation pairing stays keyed by slice id. **Refresh drawings** rebuilds the overlay from `current_label` without changing region IDs; **Convert Layers to Parents** still runs atlas layer→parent ID conversion.

### Legacy workspace scan ([`js/workspace.js`](js/workspace.js))

When resolving `05_predictions`, if there are no top-level `Predictions_*.pkl` files but nested folders contain them, the workspace picks the **most recently modified** leaf and may set a short warning for ambiguous multi-run trees (also surfaced in the import wizard review when a predictions source path is set).

## RSAT submodule

Upstream RSAT’s `py/main.py` imports `train_seg` at load time (PyTorch Lightning / Transformers). That is **not** imported from the Mason Jar Electron venv. The repo may include **`vendor/rsat`** as a **git submodule** for reference and future refactors; runtime export uses `export_roi_dual_tif.py` only. Clone once with:

`git submodule update --init --recursive`

(or `git submodule add https://github.com/asoronow/rsat.git vendor/rsat` when first adding).

## Which Python to change

- **Electron app behavior** (what users run from the menu): change **`py/`** scripts and any IPC args in **`src/main.ts`** / **`js/*.js`**. Recompile TypeScript to refresh **`main.js`** before release or if your environment uses `main.js` directly.
- **Library, headless runs, automated tests, or future JSON-RPC integration**: change **`python/src/belljar/`**, expose steps via **`python/src/belljar/cli.py`** or **`python/src/belljar/server.py`**, and add tests under **`python/tests/`**.

Avoid implementing the same behavior twice in `py/` and `python/src/belljar/` without a deliberate migration plan. The JSON-RPC server (`belljar server`) is a single long-lived stdin/stdout process; Electron today uses **one short-lived `PythonShell` per tool run**.

## Renderer script loading (`js/run.js`)

HTML under `pages/` must **not** load feature modules with `<script src="../js/menu.js">` alone: Node resolves `require("./foo")` relative to **`pages/`**, not `js/`, so imports fail silently and buttons do nothing.

Pattern:

```html
<script src="../js/run.js" data-entry="menu.js"></script>
```

[`js/run.js`](js/run.js) derives the app root from `window.location.pathname` and `require(path.join(appRoot, "js", name))`. Load failures call `alert()` with the module name. Hub version: [`js/hub_version.js`](js/hub_version.js) on [`pages/menu.html`](pages/menu.html).

[`js/loading.js`](js/loading.js) must not assume `#guide` exists on [`pages/loading.html`](pages/loading.html) (Guide lives on the hub via [`js/open_guide.js`](js/open_guide.js)).

Global [`css/style.css`](css/style.css) sets `body { text-align: center; }`. Wizard and form panels should use `workspace-block` or `text-start` so radios and labels stay aligned (see [`pages/project_wizard.html`](pages/project_wizard.html) step 3).

## Start hub and project flows

After bootstrap, the main window loads [`pages/menu.html`](pages/menu.html) (not the old index hub). Pipeline tools are gated until a `.masonjar` / `.belljar` bundle or legacy workspace is active ([`js/pipeline_gate.js`](js/pipeline_gate.js), [`pages/workspace_menu.html`](pages/workspace_menu.html)).

- **New project**: [`pages/project_start.html`](pages/project_start.html) → wizard or legacy-only scan.
- **Import wizard**: [`pages/project_wizard.html`](pages/project_wizard.html) + [`js/project_wizard.js`](js/project_wizard.js). **Build project** runs `runBuildAsync()` with live progress on step 4, `[ProjectWizard]` `console.log` lines, and per-file copy progress via [`js/project.js`](js/project.js) `onProgress` / `copyDirRecursiveAsync`.
- **CZI import wizard**: [`pages/project_start.html`](pages/project_start.html) → **Import from Zeiss CZI** → [`pages/czi_wizard.html`](pages/czi_wizard.html) + [`js/czi_wizard.js`](js/czi_wizard.js). Uses `aicspylibczi` ([`py/czi_probe.py`](py/czi_probe.py), [`py/czi_extract.py`](py/czi_extract.py)) to populate `original_scans`, `00_dapi`, and `03_max/{somata|nuclei|axons}/max/<slug>/`, then [`py/apply_geometry.py`](py/apply_geometry.py) (OpenCV) for per-slice rotation/flip. Project JSON stores `settings.czi_import`; long jobs write `.masonjar/czi_import_state.json` and `.masonjar/czi_import_config.json`. After finish: `refreshProjectIndex`, set active `max` run from primary signal branch. **Step 4** mirrors the project import console: `extractStatus`, striped `extractProgress` (`aria-*`), monospace `wizard-log` pre (`verboseExtractLog`, `[CziWizard]` console mirror). Progress uses `updateLoad`; per-item detail uses Python `LOG:` lines → main `cziJobLog` + global log window (not counted toward extract %). While extracting, only **Cancel extraction** (`killCziImport`) is shown; footer **Cancel wizard** is hidden.

  **CZI paths on Windows:** Bundle and config paths may contain spaces (`Matt Jacobs`). Do not pass `-j path` as one combined argv string from main — use separate entries (`-b`, bundleRoot, `-j`, configPath) as in `appendCziPathArgs` in [`src/main.ts`](src/main.ts). Python strips paths defensively in `load_import_config`.

 **Windows LOG encoding:** `pythonShellEnv()` sets `PYTHONIOENCODING=utf-8` on win32; [`py/czi_common.py`](py/czi_common.py) reconfigures stdio to UTF-8 and `emit_log` / `emit_progress` use `_safe_print` so decorative Unicode in log strings cannot abort CZI jobs on cp1252 consoles.

  **CZI read path (aicspylibczi 3.x):** `read_image` returns `(ndarray, dims_list)` — never `np.asarray()` the raw tuple. [`py/czi_common.py`](py/czi_common.py) `read_czi_plane` unpacks the tuple, collapses fixed S/Z/C axes, and selects the **largest Y×X plane** when pyramid levels stack. Mosaic files use `read_mosaic(scale_factor=…, Z=…, C=…)` **without `S`** (libCZI rejects `S` on mosaic reads); multi-scene mosaics pass scene `region` from `get_mosaic_scene_bounding_box`. **Probe** is metadata-fast: [`py/czi_probe.py`](py/czi_probe.py) calls `assess_mosaic_import(sample_read=False)` (tile/scene bounding-box union only — no `read_mosaic`). Main maps probe stdout to `Ready — N CZI file(s) to probe` and a 5–95% probe bar (`Probing …` per file). **Extract** runs a one-time `assess_mosaic_import(sample_read=True, sample_scale=0.05)` on first open per `.czi` (fast stitch sanity check); full `read_mosaic(1.0)` still happens per Z in `extract_z_stack`. Reports `is_mosaic`, `m_tile_count`, `mosaic_stitch_status` (`ok`|`suspect`|`unknown`), `likely_unstitched`, and `mosaic_warnings`; the wizard shows an **info** alert for ZEN-stitched mosaic structure (M>1) and a **warning** when bbox coverage or sample read indicates unstitched tiles (<85% coverage, etc.). **Unstitched** Zen mosaics may import with seams or wrong geometry — users should stitch in ZEN first. **Single Z:** `extract_z_stack` writes a 2D TIFF (not a Z=1 stack); max projection copies/collapses a single plane instead of failing on `argmin` over equal dimensions.

  **Extract console verbosity:** Step 4 is high-volume by design. The inline console and Application log show staged library imports (`LOG: Importing numpy…`, `still loading aicspylibczi…`), directory creation, per-file CZI opens (one open per source `.czi`, cached across work items), **every Z plane read**, TIFF writes, and max-projection inputs. Progress bar phases: **0–3%** JS preamble/spawn (`Launching Python`, heartbeat while waiting); **3–18%** staged imports (`PROGRESS:` from Python, mapped in main); **~20%** `Ready — N extraction items`; **22–92%** per-item extract (`updateLoad` counter); **92–99%** max projection; **100%** done. If the bar appears frozen, check the Application log and stderr mirror (`cziJobLog`) — large jobs (300+ items) remain slow but should never look idle while Python is running. The wizard emits a 1–2 s heartbeat and gap watchdog until the first Python ack.

  **Slice ordering and renaming:** Step 2 accepts **multiple CZI source folders** (add/remove, sequential probe merge). Step 3 (**Channels / Renaming**) lets the user choose **keep scene names** vs **rename on import** (default **rename** when more than one source folder). The renaming table lists every scene in canonical order with editable final `sliceId` values (read-only in preserve mode); duplicates are blocked before extract. Config persists `source_dirs`, `slice_numbering`, and `slice_order` in `.masonjar/czi_import_config.json` and `settings.czi_import`. [`js/czi_import.js`](js/czi_import.js) builds `slice_order` with natural sort on section suffix (`_sNNN`), then syncs `files[].scenes[].sliceId`. [`py/czi_extract.py`](py/czi_extract.py) iterates work items and max-projection inputs in that order (natural-sort fallback when `slice_order` is absent). **Primary signal** is one channel-wide choice on step 3 (not per file row).

### CZI channel roles

Step 3 (**Channels / Renaming**) includes a **global channel bar**: pick channel index `N`, set role (and optional **Other** name), then **Apply to all Ch N** to update every row with that index across all `.czi` files. Per-row edits remain possible. All channels default to **Keep** checked after probe; uncheck **Keep** (or use the header master toggle) to skip extraction. A **Primary signal** dropdown selects one kept signal role for the default max run. Config stores `channel_defaults`, `slice_order`, and per-file `channels[]`.

| Role | Destination |
|------|-------------|
| `dapi` | **`data/counting/00_dapi/{sliceId}.png`** (uint8 low-res) + full-res z-stack TIFF under `original_scans` if kept |
| `signal_somata` / `signal_nuclei` / `signal_axons` | `data/original_scans/{branch}/` (TIFF z-stack), max → `data/counting/03_max/{branch}/max/<slug>/` |
| `other` + `other_name` | Custom branch slug (sanitized `[a-zA-Z0-9_-]`): `original_scans/{other_name}/`, max → `03_max/{other_name}/max/<slug>/`; `primary_signal_role` = `other:{name}` |
| `unused` | skipped when **Keep** unchecked or role unused |

**PNG low-res contract** (`preview_format_version: 4`):

| Tier | Format | Paths | Used by |
|------|--------|-------|---------|
| Low-res display | **PNG uint8** | `00_dapi/{sliceId}.png` (pipeline), `_previews/{sliceId}_{branch}.png` and `_previews/{sliceId}_dapi.png` (orient) | **Align** / **Adjust** / Isolate Regions read `00_dapi`; orient UI reads `_previews` only |
| Full-res analysis | **TIFF** (uint8 default; axon 16-bit opt-in) | `original_scans/{branch}/{sliceId}.tif`, `03_max/{run}/{sliceId}.tif` | Max, Sharpen, Detect, Intensity, geometry apply |

Do **not** write TIFF into `00_dapi` or low-res `_previews` — Align ignores TIFF there and Adjust cannot load it reliably.

Slice IDs default to `{czi_stem}_s{scene:03d}` when multi-scene; **rename on import** assigns `{projectStem}_s{ordinal:03d}` in natural sort order across all merged folders. Preview scale defaults to `0.05` (5% linear). **Axon bit depth** (step 3): `bit_depth_by_role.signal_axons` = `8` (default) or `16` for full-res z-stack/max TIFF only; previews always uint8 PNG.

**Orient previews (step 5) and standalone Orient:** Low-res previews are **uint8 PNG** at **5% linear** (`preview_scale` 0.05). **Orient display** reads `_previews` only: signal `_previews/{sliceId}_{branch}.png`, DAPI `_previews/{sliceId}_dapi.png`. **Pipeline DAPI** for Align/Adjust is `00_dapi/{sliceId}.png` only — **never TIFF** in `00_dapi`. CZI extract/repair **dual-writes** both DAPI PNG paths from the same plane. [`resolveOrientPreviewPath`](js/czi_import.js) (default channel `dapi`) and [`orientDapiPreviewPath`](js/czi_import.js) point at `_previews`, not `00_dapi`. [`listOrientDisplayChannels`](js/czi_import.js) labels DAPI as **DAPI (_previews)**. Legacy bundles: `ensureOrientDapiPreviewsFromPipeline` copies `00_dapi` PNG → `_previews/*_dapi.png`; **Repair previews** runs migrate + z-stack repair. Geometry is **per slice**, not per channel. Shared geometry UI: [`js/orient_geometry.js`](js/orient_geometry.js). Entry points: CZI wizard step 5 → [`py/apply_geometry.py`](py/apply_geometry.py); **Orient slices** ([`pages/orient.html`](pages/orient.html), [`js/orient.js`](js/orient.js)).

**Geometry apply targets** (same rotation/flip per slice): `00_dapi/*.png`, `_previews/{sliceId}_*.png`, `original_scans/**/{sliceId}.tif`, `03_max/**/{sliceId}.tif`. Preflight `LOG:` lists each file (PNG vs TIFF, size, shape); progress is **file-based** (`files_total`, per-file read/write timing in finish payload).

**Geometry state after apply:** `settings.czi_import.geometry` is **pending-only** — after a successful apply ([`js/orient.js`](js/orient.js), [`js/czi_wizard.js`](js/czi_wizard.js) call [`resetGeometryMap`](js/orient_geometry.js)), every slice resets to identity and `geometry_applied_at` is set. The Orient grid then shows **on-disk `_previews` pixels without CSS transform**. Re-applying with non-identity geometry **stacks** transforms on current files (guarded by confirm when `geometry_applied_at` is set). Apply is disabled when all geometry is identity. Wizard step 6 offers **Review orientation** (or click step 5 pill) to revisit baked previews.

**Repair / migration:** [`migrate_low_res_tiffs`](py/czi_extract.py) converts `00_dapi/*.tif` → pipeline + orient PNG (then **deletes** TIFF), `_previews/*.tif` → `.png`, and syncs missing `_previews/*_dapi.png` from `00_dapi` PNG. Repair mode always migrates first; empty `repair_targets` = migrate-only. `00_dapi` must contain **zero** `.tif`/`.tiff` after migrate.

**DAPI cleanup** ([`py/dapi_cleanup.py`](py/dapi_cleanup.py)): reads PNG or legacy TIFF; **writes PNG** to `00_dapi` / `00_dapi_clean` (Align expects PNG).

**CZI wizard resume:** After step 1 **Next**, if the bundle already exists and `settings.czi_import.config_fingerprint` matches [`cziImportFingerprint`](js/czi_import.js), [`auditCziImportCompletion`](js/czi_import.js) may **skip to step 5 (Orient)** when extract is complete and previews are valid (no low-res TIFFs), or land on **step 4** for **repair-only** extract (`repair_mode: "previews"`, `repair_targets` in config) to rebuild previews from existing `original_scans` z-stacks (no full CZI re-read when z-stack exists; max projection skipped if max runs already on disk). Fingerprint mismatch (different source dirs, slice plan, or channels) returns to the normal wizard from step 2.

## Release builds (required for agents)

When the user asks to **build**, **package**, or **cut a release**, do **not** run a single-host `electron-forge make` (e.g. only `--arch=arm64` on Apple Silicon). That produces a macOS-only DMG and **does not** work on Windows.

**Always run the canonical release script:**

```bash
node scripts/build-release.js
# or: npm run build:release   /   yarn build:release
```

Compiles TypeScript, runs JS dev tests, then builds **all desktop targets locally** (Linux omitted unless `--linux`):

| Target | Platform / arch | Typical artifact |
|--------|-----------------|------------------|
| macOS Intel | `darwin` / `x64` | `.dmg` |
| macOS Apple Silicon | `darwin` / `arm64` | `.dmg` |
| Windows | `win32` / `x64` | `.zip` under `out/make/zip/win32/x64/` |

`node scripts/build-release.js --windows-only` skips macOS when you only need a Windows package.

**Publish to GitHub** (after tag `v<version>` matches `package.json`): upload **Windows zip only** by default (Zen users are Windows-centric; faster publish). macOS DMGs remain local unless you opt in:

```bash
node scripts/publish-release.js          # Windows zip only
node scripts/publish-release.js --all-platforms   # upload DMGs + zip
```

Optional: `--linux` on the build script adds Linux `.deb` (requires `dpkg` and `fakeroot`).

Checklist: `out/make/RELEASE-<version>.md`. Releases: [matsojr22/masonjar releases](https://github.com/matsojr22/masonjar/releases).

**Local dev package only** (not for GitHub): `node scripts/build-release.js --local` — builds for the current machine OS/arch only.

Bump `version` in `package.json` before a release when appropriate. Commit `main.js` after `src/main.ts` changes.

## Packaging notes

- [`forge.config.js`](forge.config.js): ignore pattern must be `"^python/"` (not `"python"`) so `node_modules/python-shell` is not stripped from the package.
- [`scripts/build-release.js`](scripts/build-release.js) invokes Forge via `node` (works when `npm` is not on PATH).
- Smoke: `./node_modules/.bin/electron scripts/smoke-pages.js` loads key pages in one window.

## Local development

- **Electron app**: install Node/Yarn per `README.md`, then `yarn install`. Prefer `./node_modules/.bin/electron-forge start` if `yarn start` exits immediately (some environments shim `yarn` without running scripts).
- **Compile main process TS**: `yarn compile` (runs `tsc`). **Commit updated `main.js` when you change `src/main.ts`**, unless your team standardizes otherwise.
- **Python package**: from `python/`, install in editable mode (`pip install -e .` / Hatch) and run `belljar --help` or pytest.
- **Dev tests** (not shipped in the app): `yarn test:js` (file index + pipeline plan), `yarn test:smoke` (Electron page load + key DOM ids). Python slice-index tests: `cd python && pip install -e . && pytest tests/test_slice_index_py.py tests/test_project.py`.

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
