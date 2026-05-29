# AGENTS.md — working on Mason Jar

Mason Jar is an Electron desktop app for mouse brain neurohistology (alignment, projections, intensity, detection, counting, collation). It is a fork of Bell Jar with dual compatibility for legacy Bell Jar paths.

**Session handoff** (current version, recent releases, open follow-ups): [`docs/AGENT_HANDOFF.md`](docs/AGENT_HANDOFF.md). Bump that file when cutting a release or ending a long agent session. This file orients contributors and coding agents.

## Branding and dual compatibility

Shared constants live in [`js/branding.js`](js/branding.js) (renderer) and `BRANDING` in [`src/main.ts`](src/main.ts) (main process):

| Constant | New (default) | Legacy (still accepted) |
|----------|---------------|-------------------------|
| Product name | `Mason Jar` | `Bell Jar` (credits only) |
| User data dir | `~/.masonjar` only (never `~/.belljar`) | `~/.belljar` (Bell Jar app) |
| Log file | `~/.masonjar/masonjar.log` | (Bell Jar’s own log) |
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
| `src/main.ts` | Electron **main process** (authoritative source): windows, `~/.masonjar` bootstrap (optional one-time copy from `~/.belljar`), IPC, `python-shell` workers |
| `js/home_dir.js` | Shared home-dir helpers: `masonHomePath`, `needsLegacyHomeMigration`, `LEGACY_HOME_COPY_ENTRIES` |
| `main.js` | **Emitted** JavaScript from TypeScript (`tsconfig.json` sets `outDir` to the repo root). **Edit `src/main.ts`, then compile** so `main.js` stays in sync. |
| `pages/`, `css/`, `js/` | Renderer UI: static HTML, Bootstrap + theme, vanilla JS using `ipcRenderer` |
| `py/` | **Legacy Python** scripts the packaged app runs (`PythonShell`, `scriptPath: app/py`) |
| `vendor/rsat` | Optional **git submodule** pointing at [asoronow/rsat](https://github.com/asoronow/rsat) — for source alignment; see **RSAT** below |
| `python/src/belljar/` | **Modern Python package**: typed pipeline steps, Pydantic config, CLI, JSON-RPC server (`belljar server`) — not wired to Electron today |
| `python/tests/` | `pytest` suite for the `belljar` package |
| `docs/belljar_guide.pdf` | User-facing workflow guide |

## Main process bootstrap (`~/.masonjar`)

On startup (`app.on("ready")` → `did-finish-load`), the main process **always** uses `~/.masonjar` (`resolveHomeDir()`). Mason Jar never reads or writes Bell Jar’s `~/.belljar` except for an optional **read-only** one-time copy when `~/.masonjar` has no `python/` or `benv/` but `~/.belljar` does.

1. **`checkLocalDir()`** — ensures `~/.masonjar` exists.
2. **Legacy migration dialog** (when `needsLegacyHomeMigration()`): **Copy from Bell Jar** copies `python`, `benv`, `models`, `embeddings`, `nrrd`, `manifest.json` into `~/.masonjar`; **Fresh install** leaves `~/.belljar` untouched; **Cancel** quits. Copy errors log to `masonjar.log`, show an error dialog, and quit.
3. **`setupPython(win)`** — if `{homeDir}/python` is missing, downloads a **standalone CPython 3.10.13** tarball from `https://storage.googleapis.com/belljar_updates/` (platform-specific: Windows, Linux x64, macOS Intel vs Apple Silicon), extracts into `homeDir`.
4. **First-time path** (`setupPython` resolves `true`): **`setupEnvironment(win)`** — `downloadResources(win, true)` pulls **embeddings**, **models**, **nrrd** archives into `homeDir`, then:
   - `installVenv`: `python -m pip install --user virtualenv` with `cwd` = extracted `python/` (or `python/bin/` on Unix — see `pythonPath` / `pyCommand` in `src/main.ts`).
   - `createVenv`: `python -m venv` targeting `{homeDir}/benv` (`benv`).
   - `installDeps`: `pip install -r py/requirements.txt` with `cwd` = venv’s `Scripts/` or `bin/`.
   - Loads `pages/menu.html` on success (start hub).
5. **Returning user path** (`setupPython` resolves `false` when `python` and `benv` already exist): **`updatePythonDependencies`** then **`fixMissingDirectories`** (incremental `downloadResources(win, false)` using `manifest.json` version keys vs embedded `currnet_versions`), then loads `pages/menu.html`.

**Path constants** (under `~/.masonjar` only):

- `pythonPath` → `{homeDir}/python/` (Windows) or `{homeDir}/python/bin/` (Unix) for the embedded interpreter.
- `envPath` → `{homeDir}/benv` (virtualenv).
- `envPythonPath` → `benv/Scripts` (Windows) or `benv/bin` (Unix) — used for **`pip install`** and as **`pythonPath` passed to `PythonShell`** (script runner uses `pyCommand`: `python.exe` or `./python3`).

**Logs**: `console.log` is wrapped and **batched** to the log window (bounded queue + flush interval); `before-quit` drains the queue. The log UI is **ephemeral per app launch** ([js/log.js](js/log.js)): main sends `resetLogSession` with a new session id on each process start; the log window does **not** restore or persist HTML to `localStorage` (legacy `log` / `logTime` keys are cleared). DOM is capped at 8000 lines. `createLogFile` appends to `{homeDir}/masonjar.log` on some failure paths. On startup the log window is **not** created (`logDismissedByUser` defaults true); [`createLogWindow`](src/main.ts) uses `show: false`. Closing or hiding the log sets dismissed; normal log/stderr lines still queue but do not auto-show. **Python non-zero exit** and renderer errors call `reportPythonFailure` / `reportRendererError`, which **force** show and focus the log. Hub **Show log** / **Hide log** ([`js/app_log_toggle.js`](js/app_log_toggle.js) on [`pages/menu.html`](pages/menu.html) and [`pages/workspace_menu.html`](pages/workspace_menu.html)): `toggleLogWindow` / `getLogWindowState` / `logWindowState`; preference `masonjar.logDismissed` (migrates legacy `masonjar.showLogWindow` once).

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
| `runIntensity` | `runIntensity` | `region.py` | `intensityResult`, `updateLoad`. Args: `[indir, outdir, annodir, whole, dapiDir, sliceList, configPath]`. Index 4 = DAPI dir (`-d`); index 6 = run config JSON (`--config`, separate argv tokens for Windows paths). |
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
| `runParcellation` | `runParcellation` | `apply_parcellation.py` | `parcellationResult`, `updateLoad`. Args: `[annodir, configJsonPath]` → `-a`, `-s` (structure_map.pkl), `-j` as separate argv tokens. Config at `{bundle}/.masonjar/parcellation_run_config.json`: `tier_id`, `st_level`, `excluded_region_ids`, optional `slice_ids`. |
| `killParcellation` | once `killParcellation` | — | |
| `runDetection` | `runDetection` | `find_neurons.py` | `detectResult`, `updateLoad`. Optional 10th IPC element: slice-list path (`--slice-list`). `-o` is the run output leaf directory. |
| `killDetect` | once `killDetect` | — | |
| `runCziProbe` | `runCziProbe` | `czi_probe.py` | `cziProbeResult` (JSON payload), `updateLoad`. Arg: CZI directory. |
| `killCziProbe` | once `killCziProbe` | — | |
| `runCziImport` | `runCziImport` | `czi_extract.py` | `cziImportResult`, `updateLoad`. Args: bundle root, import config JSON path. Main passes `-b` and `-j` as **separate argv tokens** (required for Windows paths with spaces). |
| `killCziImport` | once `killCziImport` | — | |
| `runApplyGeometry` | `runApplyGeometry` | `apply_geometry.py` | `applyGeometryResult`, `updateLoad`. Args: bundle root, config JSON (includes `geometry` map). |
| `killApplyGeometry` | once `killApplyGeometry` | — | |
| `showLogWindow` | `showLogWindow` | — | User open: clear dismissed, show/focus `pages/log.html`; replies `logWindowState`. |
| `toggleLogWindow` | `toggleLogWindow` | — | Show/focus or hide (does not destroy); replies `logWindowState`. |
| `getLogWindowState` | `getLogWindowState` | — | Reply: `logWindowState` `{ visible, dismissed }`. |
| `reportRendererError` | `reportRendererError` | — | Force log visible; queue error line ([`js/page_init.js`](js/page_init.js)). |
| `runBatch` | `runBatch` | (queue) | Drives [`src/batch_queue.ts`](src/batch_queue.ts); per-job pushes (`batchJobStart`/`batchJobLog`/`batchJobEnd`) + overall (`batchProgress`/`batchComplete`). |
| `killBatch` | `killBatch` | — | Cancels the running batch; remaining jobs marked `cancelled`. |

### Channels the main process pushes (selection)

| Channel | Typical use |
|---------|----------------|
| `updateStatus` | Loading / setup / download status (`loading.html`) |
| `updateLoad` | `[percent, message]` progress for long jobs |
| `cziJobLog` | Detail line from CZI Python (`LOG:` prefix); does not advance extract progress counter |
| `log` | Log window stream |
| `version` | Reply to `getVersion` |
| `returnPath` | Directory or file picker result |
| `batchJobStart` | `{ project, step, projectIndex, stepIndex }` — batch wizard step 2 grid + status block |
| `batchJobLog` | `[project, step, line]` — verbose Python output for the wizard `pre.wizard-log` |
| `batchJobEnd` | `{ project, step, status, reason?, elapsedMs, tail?, outputAbs? }` — flips matrix cells, captures error tails |
| `batchProgress` | `[overallPct, message, detail?]` — striped overall bar |
| `batchComplete` | `{ summary, errors, cancelled }` — Step 3 summary; `summary.byProject[<path>][<step>]` carries per-job result |

Some renderer files register `*Error` listeners (e.g. `alignError`, `detectError`). The main process logs Python non-zero exits to the Log (forcing the log window visible) and avoids throwing; **Isolate Regions** also emits `intensityError` with a short message after `intensityResult` when Python fails or writes zero PKLs.

## Isolate Regions wizard and config

**Flow**: [`pages/intensity.html`](pages/intensity.html) (setup: paths, whole/hemisphere, DAPI, run mode) → **Configure outputs** → [`pages/intensity_wizard.html`](pages/intensity_wizard.html) + [`js/intensity_wizard.js`](js/intensity_wizard.js) (steps 2–4: CCF region picker, progress, summary). Setup is stashed in `sessionStorage` (`masonjar.intensity.setup`). **Process** writes run config and calls `runIntensity` with config path at IPC index 6.

**Run config** (project: `.masonjar/intensity_run_config.json`; legacy: temp file): `selected_region_ids`, `include_layers`, `whole`, `use_dapi`, paths, `slice_list`. Python: [`py/region_config.py`](py/region_config.py), [`py/region.py`](py/region.py) `--config`. Without `--config`, legacy batch/CLI still uses the built-in VIS/RSP acronym set.

**Region picker**: [`js/structure_catalog.js`](js/structure_catalog.js) flattens [`csv/structure_graph.json`](csv/structure_graph.json). The default **Hierarchy** dropdown (`#tierSelect`) lists semantic tiers from `listTiers(catalog)` — **Major divisions / Classic regions / Functional areas / Sub-areas / Cortical layers** (default `areas`). **Advanced — show CCFv3 raw depths** (`#ccfAdvancedToggle`) swaps the picker to CCFv3 `st_level` rows from `listCcfLevels(catalog)` with `formatCcfLevelLabel` (e.g. `Level 6 — 34 regions (AUD, DORpm, GU, MO, SS, …)`); selected region ids are preserved across the swap. Picker mode persists in `sessionStorage["masonjar.ccfPickerMode"]`. **Include cortical layers** (`include_layers`): off = one PKL per selected parent aggregating descendants (default); on = separate PKLs for layer structures under selected parents ([`py/count.py`](py/count.py)-style `"layer"` in structure name). **Visual cortex preset** restores the legacy VIS+RSP ID set. Parent-area row colors: [`js/atlas_region_style.js`](js/atlas_region_style.js), [`docs/isolate_regions_style.md`](docs/isolate_regions_style.md) (`GROUP_STYLE_LEVEL=6`, Allen `color_hex_triplet`).

**Slug** ([`js/pipeline_runs.js`](js/pipeline_runs.js)): span + `_whole`/`_hemi` + optional `_dapi` + `_r{N}` (selection count) + optional `_layers` + subset token.

**Parcellation-aware matching:** When the active align run has per-slice parcellation metadata (`{align_leaf}/.masonjar/annotation_parcellation.json`), [`py/annotation_match.py`](py/annotation_match.py) rolls selected region IDs to the annotation resolution before PKL aggregation ([`py/region.py`](py/region.py) logs `LOG: intensity_parcellation_context …`). **Include cortical layers** is disabled when parcellation is coarser than layer resolution (UI banners in [`js/intensity.js`](js/intensity.js) / [`js/intensity_wizard.js`](js/intensity_wizard.js); batch preflight in [`js/batch_wizard.js`](js/batch_wizard.js) and [`src/batch_queue.ts`](src/batch_queue.ts)). Re-run Isolate Regions after changing parcellation.

## Isolate Regions PKL schema (with DAPI)

**Whole vs hemisphere** ([py/region.py](py/region.py), setup page): IPC/config `whole` as `True`/`False` strings. Processing uses `parse_whole_flag()` (never `bool("False")` or `eval`). **Whole Slice** (`True`): only pixels with `x < width/2` (left half). **Hemisphere Only** (`False`): all pixels in matched selected regions. UI choice persists in `masonjar.intensity.whole`. Logs include `LOG: intensity_mode=whole|hemisphere`, `LOG: intensity_layers=on|off`, and per-slice `LOG: … wrote N PKLs`.

**Zero PKL output is a failed run**: if at least one slice was processed but no `{sliceId}_{region}.pkl` files were written for the configured regions, Python prints `NO_PKLS_WRITTEN`, writes `run_manifest.json` with `pkls_written: 0`, and exits **1**; main sends `intensityError` and forces the log open.

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

**Warp failures (Finish):** [`py/demons.py`](py/demons.py) guards flat Sobel edges (no divide-by-zero) and retries registration without edge preprocess / geometry-only fallback on Mattes MI failure. [`py/map.py`](py/map.py) `finish()` warps per slice in try/except — failed slices skip `Annotation_` / `Atlas_` / `Composite_` writes, log `LOG: align_warp_failed`, and record `warp_ok` / `warp_failed` in `run_manifest.json` plus `<align leaf>/.masonjar/align_warp_report.json`. Exit **0** when at least one slice warps; **1** only when zero slices succeed.

**Project tracking:** `processing.step_failures.align` maps `sliceId → { message, file, at }`. [`js/align.js`](js/align.js) calls `mergeAlignWarpReport` on `alignResult`; successes clear prior failures. [`js/file_index.js`](js/file_index.js) `getProcessingSliceIds` and [`js/pipeline_run.js`](js/pipeline_run.js) exclude failed align slices from Count / Intensity / Adjust plans. Workspace hub **Alignment issues** (`projectStepFailuresSection` on [`pages/workspace_menu.html`](pages/workspace_menu.html)) lists persistent failures below **Completed tasks**.

### Run-aware output organization (all pipeline steps)

Shared contract: [`js/pipeline_runs.js`](js/pipeline_runs.js), [`py/run_manifest.py`](py/run_manifest.py).

| Step | Output role | Branch | Example leaf | Manifest writer |
|------|-------------|--------|--------------|-----------------|
| Max projection | `max` | `max` | `03_max/max/<slug>/` | [`py/max.py`](py/max.py) |
| Sharpen | `max` | `sharpen` | `03_max/sharpen/<slug>/` | [`py/sharpen.py`](py/sharpen.py) |
| Align | `slices` | `align` | `01_slices/align/<slug>/` | [`py/map.py`](py/map.py) |
| Isolate regions | `pkls` | `intensity` | `07_pkls/intensity/<slug>/` | [`py/region.py`](py/region.py) |
| Cell detection | `predictions` | model branch | `05_predictions/somata/<slug>/` | [`py/find_neurons.py`](py/find_neurons.py) |

## Cell detection (SAHI)

[`py/find_neurons.py`](py/find_neurons.py) uses `sahi~=0.11.0` ([`py/requirements.txt`](py/requirements.txt)). `_call_get_sliced_prediction()` passes `progress_bar` / `progress_callback` only if `inspect.signature(get_sliced_prediction)` includes those parameters (0.11.x on PyPI does not; newer SAHI main will). Tile progress in the Mason Jar log uses `make_tile_progress_printer` when supported; otherwise rely on `verbose=1` and the pre-detection stdout line. Tests: [`python/tests/test_find_neurons_sahi.py`](python/tests/test_find_neurons_sahi.py).
| Count | `quantification` | `count` | `06_quantification/count/<slug>/` | [`py/count.py`](py/count.py) |
| Collate | `quantification` | `collate` | `06_quantification/collate/<slug>/` | [`py/collate.py`](py/collate.py) |
| Dual export | `dual` | `dual` | `08_dual/dual/<slug>/` | [`py/export_roi_dual_tif.py`](py/export_roi_dual_tif.py) |

- **Project state**: `processing.active_runs[<role>]` stores the path relative to that role’s base (e.g. `align/M528_s027-…`, `somata/M528_…`). Legacy `active_prediction_run` migrates to `active_runs.predictions` on open. **UI** labels this **Completed tasks** on the workspace menu (`projectActiveRunsSection`); Count page uses role names **predictions** / **slices** (code identifiers unchanged).
- **Flat legacy checkbox**: each output step page offers *Write outputs directly to the output folder*; when checked, `-o` stays the role root for that run only.
- **Indexing**: [`js/file_index.js`](js/file_index.js) indexes output roles only under the **active run leaf** (no blind merge of sibling run folders). Full run inventory for pickers lives in `.masonjar/runs_catalog.json` on rescan.
- **Import**: [`project.importSourceToRoleWithLayout`](js/project.js) preserves nested run trees; flat files in a mixed source go to `import_<ISO-date>/`.
- **Downstream IO**: tools resolve inputs from active upstream leaves via `pipeline_runs.resolveInputLeafAbsForStep` (sharpen reads `max/max/…`, count reads active `predictions` + `slices`, etc.). Batch [`resolvePathsForBundle`](js/project.js) uses the same active leaves.

Input-only roles (`dapi`, `original_scans`) stay flat at the role root; `active_runs` is unused for them.

### Count pairing and active runs

[`py/count.py`](py/count.py) pairs **`Predictions_*.pkl`** with **`Annotation_*.pkl`** by **shared slice stem**. In project mode, the **Count** page selects active **predictions** and **slices** runs; output goes to `quantification/count/<slug>/`. [`js/pipeline_run.js`](js/pipeline_run.js) filters the count slice list to slices with a matching prediction PKL in the active predictions leaf and an annotation in the active slices leaf.

### Viewer/Editor (adjust) stem pairing

[`py/adjust.py`](py/adjust.py) pairs DAPI images to annotation PKLs by **slice stem** (via [`py/slice_index.py`](py/slice_index.py)), not sorted folder order. In project mode, [`js/adjust.js`](js/adjust.js) passes a **`--slice-list`** from matched DAPI + **active slices** leaf pairs through IPC.

The PyQt viewer shows a **Background channel** bar listing only **`data/counting/_previews/{sliceId}_*.png`** (see [`py/adjust_channels.py`](py/adjust_channels.py); optional `--previews-dir`) — no duplicate entry from `00_dapi`. Switching channels reloads only the background image; annotation pairing stays keyed by slice id. **Paint region** controls: **Hierarchy** tier combo (default `areas`, populated from `list_tiers()`) + **Advanced — show CCFv3 raw depths** checkbox that swaps the dropdown to `list_ccf_levels()` rows with `format_ccf_level_label` and shows a small italic help label below it. Search/area combo is backed by [`py/structure_catalog.py`](py/structure_catalog.py) and sibling `csv/structure_graph.json` of `structure_map.pkl`; the previously-selected `selected_region_id` is preserved across tier and advanced-mode swaps. Left-click brush uses the selected atlas id (empty background OK). **Right-click** still picks from the slice and re-syncs the picker (level combo in advanced mode, area combo always) when the label is in the catalog. **Refresh drawings** rebuilds the overlay from `current_label` without changing region IDs.

**Parcellation (per section):** A separate **Parcellation (this section)** panel ([`py/annotation_relabel.py`](py/annotation_relabel.py)) lets users roll annotation borders up the CCF hierarchy (semantic tiers or raw `st_level`) for **the current section only**. **Preview borders** shows a non-destructive overlay; **Apply parcellation** requires confirmation and relabels from that section’s full-detail backup at `{align_leaf}/.masonjar/annotation_full/{sliceId}.pkl` (written once on first open if missing), which **reverts manual brush edits on that section**. Other sections’ `Annotation_*.pkl` files are never touched. Applied level is recorded per slice in `{align_leaf}/.masonjar/annotation_parcellation.json` (optional `excluded_region_ids`). **Restore fine** reloads the backup for the current section only. **Quick: layers → functional areas** applies the functional-areas tier via the same path. **Bulk in Adjust:** checkable slice list + **Apply to selected sections…** (optional per-slice confirm) calls [`py/apply_parcellation.py`](py/apply_parcellation.py) per slice. **Electron bulk wizard:** [`pages/parcellation_wizard.html`](pages/parcellation_wizard.html) + `runParcellation` IPC (hub: Atlas alignment → **Parcellation (bulk)**). **Batch step:** `parcellation` in batch wizard (after `dapi_cleanup`); per-project headless apply via `runBatch` / [`src/batch_queue.ts`](src/batch_queue.ts). **Headless core:** [`py/apply_parcellation.py`](py/apply_parcellation.py), [`py/annotation_exclusion.py`](py/annotation_exclusion.py); package mirror under [`python/src/belljar/annotation/`](python/src/belljar/annotation/) + `belljar parcellate` CLI. Alignment **Finish** optionally applies one parcellation level to every warped section (Napari **Parcellation** control) and writes the same per-slice backups/metadata.

### Window focus on launch ([`py/qt_window_utils.py`](py/qt_window_utils.py))

When the user starts Alignment or Viewer/Editor from Mason Jar, the Electron main process **`blur()`s** the parent `BrowserWindow` immediately after `PythonShell` spawn (`runAlign` / `runAdjust` in [`src/main.ts`](src/main.ts)) so Mason Jar stops competing for foreground. The Python side calls [`raise_and_activate`](py/qt_window_utils.py) from `adjust.py` after `window.show()` and [`raise_and_activate_napari`](py/qt_window_utils.py) from `AlignmentController.start_viewer()` (resolves `viewer.window._qt_window`). Each helper runs `show/raise_/activateWindow` immediately plus deferred `QTimer.singleShot(0, …)` and `QTimer.singleShot(200, …)` retries; on Windows it also tries `user32.SetForegroundWindow(hwnd)` (best-effort, all ctypes calls wrapped in try/except). No `WindowStaysOnTopHint`.

### Legacy workspace scan ([`js/workspace.js`](js/workspace.js))

When resolving `05_predictions`, if there are no top-level `Predictions_*.pkl` files but nested folders contain them, the workspace picks the **most recently modified** leaf and may set a short warning for ambiguous multi-run trees (also surfaced in the import wizard review when a predictions source path is set).

## Batch wizard ([`pages/batch_wizard.html`](pages/batch_wizard.html) + [`js/batch_wizard.js`](js/batch_wizard.js))

Three-step wizard (Setup → Run → Summary) mirroring the CZI / Isolate Regions pattern (`body.wizard-page`, `#wizardSteps` pills, `setStep()`, sticky cancel hidden while running, dual logging to wizard `pre.wizard-log` + the global Application log). The hub Batch card links here ([`pages/menu.html`](pages/menu.html)).

**Step 1 (Setup)**: Projects (add / scan / remove via [`project.isBundleRoot`](js/project.js), `readProjectJson`, `listBundlesInDirectory`) · Tools (checkbox list ordered by dependency, with one-line description and `deps:` hint) · Parameters (Bootstrap accordion per selected step, including the Intensity tier/CCFv3-advanced picker reused from `js/structure_catalog.js` + `js/atlas_region_style.js`) · live **Preflight matrix** (projects × steps; green/amber/red). Defaults persist to `localStorage["masonjar.batchDefaults"]`; the resolved plan is stashed in `sessionStorage["masonjar.batchPlan"]`. The Next/Start button is disabled while any cell is red, when Intensity has no regions selected, or when Collate is selected with fewer than two projects.

**Step 2 (Run)**: striped overall progress bar driven by `batchProgress`, a per-project status grid that flips `pending → running → done/failed/skipped/cancelled`, `pre.wizard-log` consuming `batchJobLog`, and a Cancel button wired to `killBatch` (remaining jobs marked `cancelled`).

**Step 3 (Summary)**: headline counts (ok / failed / skipped / cancelled) and a full matrix table; clicking a failed cell expands the captured Python tail (~50 lines per job). Each touched project's `processing.active_runs` snapshot is shown. A run summary is persisted to `<bundleRoot>/.masonjar/last_batch_summary.json` for one-project diagnostics.

### Dependency graph (skip-downstream propagation)

| Step | Downstream steps marked `skipped: prerequisite_failed` on per-project failure |
|------|-------------------------------------------------------------------------------|
| `apply_geometry` | dapi_cleanup, parcellation, max, sharpen, detect, count, intensity, dual, collate |
| `dapi_cleanup` | parcellation, intensity, dual |
| `parcellation` | count, intensity, dual, collate |
| `max` | sharpen, detect, intensity, count, collate, dual |
| `sharpen` | detect, intensity, count, collate, dual |
| `detect` | count, collate |
| `count` | collate |
| `intensity` | dual |
| `dual` | (none) |
| `collate` | (none — runs once at end across selected projects) |

Failures in one project never short-circuit other projects; only that project's downstream cells flip to `skipped`.

### Per-job repair policy ([`preflightJob`](src/batch_queue.ts))

Auto-repairs run immediately before launching Python and log each action via `batchJobLog`:

- **Count missing `structure_map.pkl`** — copy from `~/.masonjar/nrrd/` if available (in the Python venv's working tree).
- **Detect / Count / Intensity missing slice list** — build on the fly from the active `slices` leaf intersected with `00_dapi` (signal branch where applicable) and pass `--slice-list`.
- **Apply geometry** — skip with reason `no pending geometry` when `settings.czi_import.geometry` is identity or `geometry_applied_at` is already set with no pending changes.
- **DAPI cleanup** — skip with reason `no DAPI input` when `00_dapi` has zero images.
- **Parcellation** — skip with reason `no parcellation change` when tier is `full` with no exclusions, or `no annotation PKLs` when active slices leaf is empty.
- **Collate** — skip with reason `collate needs >= 2 counted projects` when fewer than two selected projects have a count leaf.
- **Intensity** — write `intensity_run_config.json` from the Step 1 plan and pass `--config` as separate argv tokens; treat `NO_PKLS_WRITTEN` on stderr as failure with a descriptive error.

After every successful job, [`applyPostStepSideEffects`](src/batch_queue.ts) updates `processing.active_runs[<role>]`, saves the project JSON, and refreshes the file index so the next step reads the leaf that was just produced.

### New tools wired into batch

- **DAPI cleanup** (`py/dapi_cleanup.py`) — Step 1 params: isolate, CLAHE, saturation %, backup dir, optional bg value. In-place mode backs up originals to `data/counting/00_dapi_backup/`.
- **Parcellation** (`py/apply_parcellation.py`) — Step 1 params: CCF tier (or advanced `st_level`), optional exclude regions. In-place rollup on active `slices` leaf; skips when tier is `full` with no exclusions.
- **Apply geometry** (`py/apply_geometry.py`) — reads `settings.czi_import.geometry`; resets to identity + sets `geometry_applied_at` on success (mirrors `js/orient.js`).
- **Collate** (`py/collate.py`) — **runs once at end of the batch** across the selected projects that have a quantification leaf. Step 1 picker chooses the output destination project and a slug; the grid renders collate as a single bottom row spanning all project columns.

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

  **Slice ordering and renaming:** Step 2 accepts **multiple CZI source folders** (add/remove, incremental probe per folder, optional **Re-probe all**). Folders are processed in **user list order** (numbered list with ↑↓ reorder); each folder is sorted internally by section identifier / natural sort, then batches are **concatenated** via `scan_index` in [`js/czi_import.js`](js/czi_import.js) `naturalCompare` / `buildSliceOrder` (not a global merge by section number alone). **`canonicalSourceDir()`** (`path.resolve`) normalizes every `source_dir` string on add, merge, resync, and hydrate so Windows path variants (`Z:\…` vs `Z:/…`, trailing slash) cannot reset folder-2 `scan_index` to 0. Adding a folder probes **only that folder** and refreshes the file table immediately; `updateLoad` + step-2 **`probeLog`** mirror `cziJobLog` during probe (Application log replays buffered lines when first opened). Probe IPC always resolves (`cziProbeResult` on close/kill/error; 60 min timeout; single-flight guard in main). Use **one Mason Jar instance** during long probes so logs are not split across PIDs. **Re-probe all** does not preempt an in-flight probe. **Scenes** are the CZI **S** dimension only — one renaming row per tissue section; **Z** stacks and **C** channels never create extra rows (Z is max-projected in extract; channel roles are set on step 3). After probe, a **Slice number follows** dropdown detects likely filename prefixes (e.g. `M467(` for `M467(57).czi`, or `file.` for `scan1.file.001.czi`) and chooses which numeric group defines slice order; default is the highest-scoring prefix that matches all (or ≥95%) probed files. Files without a matching section number (e.g. bare `M514.czi` alongside `M514(1).czi`) sort **after** numbered sections within the same folder. **Automatic (natural sort)** uses chunked natural sort (digit runs compared numerically, e.g. `M467(57)` before `M467(108)`). Changing the identifier immediately rebuilds `slice_order` and re-sorts the file table and step 3 renaming table. Step 3 duplicates the same dropdown. Multiple folders default to rename mode (`Project_s001` … contiguous across concatenated batches). Config persists `source_dirs` (add order, not alphabetized), `slice_numbering`, `section_identifier`, and `slice_order` in `.masonjar/czi_import_config.json` and `settings.czi_import` (identifier is excluded from `config_fingerprint` so resume keeps the saved choice). Channel rows key by absolute **`file.path`** so duplicate basenames across folders do not collide. [`js/czi_import.js`](js/czi_import.js) builds `slice_order` via `naturalCompare` (`scan_index`, then chunked tokens or identifier-driven section int + remainder), then syncs `files[].scenes[].sliceId`. [`py/czi_common.py`](py/czi_common.py) `scene_indices_from_czi` follows aicspylibczi S-dimension semantics (never `len(blocks)` for Z-only fragments). [`py/czi_extract.py`](py/czi_extract.py) iterates work items in `slice_order` when present, otherwise falls back to the same sort honoring `section_identifier`. **Primary signal** is one channel-wide choice on step 3 (not per file row).

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

**Rotation contract (preview ↔ disk):** Stored `geometry.rotate` (90/180/270) and flips mean the same transform in the Orient grid and in [`py/apply_geometry.py`](py/apply_geometry.py). CSS `rotate(+Ndeg)` is **clockwise** ([`geometryCssTransform`](js/orient_geometry.js)); Python uses `np.rot90` with **k=-1** for 90°, **k=2** for 180°, **k=1** for 270°. One ↻90° click sets `rotate: 90` on both sides. Flip X/Y match `scaleX(-1)` / `scaleY(-1)` vs `fliplr` / `flipud`.

**Geometry state after apply:** `settings.czi_import.geometry` is **pending-only** — after a successful apply ([`js/orient.js`](js/orient.js), [`js/czi_wizard.js`](js/czi_wizard.js) call [`resetGeometryMap`](js/orient_geometry.js)), every slice resets to identity and `geometry_applied_at` is set. The Orient grid then shows **on-disk `_previews` pixels without CSS transform** (preview URLs cache-bust with `geometry_applied_at`). Re-applying with non-identity geometry **stacks** transforms on current files (guarded by confirm when `geometry_applied_at` is set). Apply is disabled when all geometry is identity. Wizard step 6 offers **Review orientation** (or click step 5 pill) to revisit baked previews.

**Bundles oriented before v1.3.16:** A preview/disk rotation mismatch (CSS clockwise vs old `np.rot90` k=1 for 90°) could bake wrong `00_dapi` / `_previews` / z-stacks / max. The code fix does not revert them. Recovery: restore from backup, re-import, or re-run Orient from unmodified `original_scans` z-stacks (if still intact) with a fixed build.

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
- **Dev tests** (not shipped in the app): `yarn test:js` (file index, pipeline, CZI, structure catalog, atlas region style, …), `yarn test:smoke` (Electron page load + key DOM ids). Python: `cd python && pytest tests/test_region_config.py tests/test_find_neurons_sahi.py tests/test_region_whole_flag.py` (and other `tests/test_*.py` as needed).

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
