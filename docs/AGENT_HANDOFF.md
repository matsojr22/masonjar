# Agent session handoff

Last updated: 2026-06-11 (v4.0.0). Use this file to resume work; long-term architecture stays in [`../AGENTS.md`](../AGENTS.md).

**GitHub releases and git commits** use human copy in [`RELEASE_NOTES.md`](RELEASE_NOTES.md) — not this file. See [`COMMIT_AND_RELEASE.md`](COMMIT_AND_RELEASE.md).

## ACTIVE SESSION — 2026-06-09 (real-data validation + long import; agent handoff)

A debug/validation session is **in progress**. A continuing agent should read this block first.

### Environment quirks on this machine (Windows)
- **Shell sandbox:** commands fail with "Sandbox policy 'workspace_readwrite' is not supported" / "no exit status". Run every shell command with `required_permissions: ["all"]`.
- **Venv interpreter is Windows-layout:** `~/.masonjar/benv/Scripts/python.exe` (NOT `benv/bin/python`). It is a python-build-standalone venv, so the `Scripts\python.exe` launcher spawns the base `~/.masonjar/python/python.exe` as a child — seeing **two** python processes for one job is normal, not a double-spawn.
- The benv had **no pytest and no editable `belljar`**; this session ran `pip install pytest` and `pip install -e . --no-deps` (from `python/`) so the suite runs. `tests/test_training.py` has 6 pre-existing torch.amp failures (out of scope; `--ignore` it).
- `node_modules` was absent → ran `npm install`. `tsc`/JS tests/electron-forge now work.
- **App was launched from source** for monitoring (`node_modules\.bin\electron-forge.cmd start`). The main process **batches logs to the in-app Application log window, not stdout**, so terminal capture only shows startup/pip. Monitor failures via `~/.masonjar/masonjar.log` (written only on Python failure / non-zero exit) and inspect on-disk bundle outputs.

### Long import running (~24h)
- Real project building at **`Y:\Matt_Jacobs\testing_site\masonjar_projects\M457_masonjar`** from CZI sources `Y:\Matt_Jacobs\testing_site\M457\{2022-04-20 (45 files), 2022-04-21 (16 files)}` (5–33 GB each). Channels: **0=somata (primary), 1=other "starters", 2=dapi**.
- **NAS bandwidth is the bottleneck** (shared link, another user has a heavy memory job). Probe/extract of a single 33 GB mosaic takes minutes — slow ≠ hung. Do **not** run heavy NAS reads for profiling while the import runs.
- A background monitor shell prints bundle counts every 5 min and emits `MONITOR_ALERT` if `masonjar.log` appears (failure). Restart it if the session resets.

### Uncommitted fixes in the working tree (NOT git-committed — user commits explicitly)
1. `scripts/release_notes.js` — `parseChangeBullets` split `/\r?\n/` (CRLF dropped all-but-last bullet on Windows; broke `publish-release.js`). Proven via runtime probe.
2. `scripts/build-release.js` — `resolveTsc()` returns the node-runnable `typescript/bin/tsc`, not the `#!/bin/sh` `.bin/tsc` shim (the shim ran via `node` → SyntaxError, breaking **every** Windows release build).
3. `python/tests/test_count_region_assignment.py`, `python/tests/test_collate.py` — `_benv_python()` resolves `Scripts/python.exe` on Windows so the **Tier 1 validators actually run** (they were silently skipping on the primary OS).
4. `python/tests/test_czi_multidir_extract.py`, `python/tests/test_tissue_mask.py` — separator-agnostic path assertions (were hardcoded `/`).
5. `py/czi_probe.py` + `python/tests/test_czi_probe_heartbeat.py` — **zero-I/O heartbeat** (`LOG:  still probing <file> (Ns elapsed)…` every 4 s) so a long single-file probe no longer looks hung. This was the user-reported "probe second directory looks hung" issue; confirmed via process I/O sampling (probe was reading ~120 MB/s, not stuck).
6. **Tissue cleanup wizard stuck on step 3 (Apply) — two real bugs, both fixed and verified in-app on M457:**
   - `js/tissue_cleanup_wizard.js` `finishApply()` called `fileIndex.refreshProjectIndex(root)`, but that function lives on the **`project`** module and is **async**. The `TypeError` threw before `setStep(4)`, stranding the wizard on step 3. Fixed to `project.refreshProjectIndex(root).catch(...)` (non-blocking, matching every other caller). Root cause proven by renderer instrumentation.
   - `src/main.ts` `runTissueCleanupApply` only delivered `tissueCleanupApplyResult` on the in-band `"Done!"` stdout line. On very long / resource-starved runs that terminal line is dropped, so the result was never sent. Added a `pyshell.on("close")` / `on("error")` **safety net** that finalizes from the on-disk `tissue_cleanup_manifest.json` (a `finished` guard prevents double-send). Confirmed firing via `close` on every M457 test run. **Recompile `main.js`.**
   - `scripts/test-dapi-cleanup.js` synthetic image flipped to the **DAPI convention** (bright tissue ellipse on dark background) to match this session's `py/tissue_mask.py` polarity fix (`isolate_tissue_mask` keeps the brighter class). It was asserting the old brightfield (dark-tissue) layout.
7. **Dynamic per-section Align layout (whole vs left hemi):** `py/align_tissue_layout.py` auto-detects per DAPI PNG; `py/map.py` always loads full atlas and crops per slice in `AtlasSlice.set_slice`; Napari **Section layout** combo for override; Align UI default **Automatic** (`-w auto`); run manifest `slice_layouts`; Isolate Regions reads layouts via `py/align_layout_manifest.py`. Tests: `python/tests/test_align_tissue_layout.py`, `test_align_layout_manifest.py`; slug `_auto` in `js/pipeline_runs.js`.
8. **Tissue cleanup UX (from the same session):** added a **Keep brush** (green, add tissue) alongside the relabeled **Eraser (remove)** in `pages/tissue_cleanup_wizard.html` + `js/tissue_cleanup_wizard.js` + `js/tissue_cleanup_canvas.js`; keep strokes skip orphan-island pruning. Canvas viewport overflow on wide sections fixed via inline `transform-origin:0 0` + absolute canvas positioning. `py/tissue_mask.py` polarity fix (auto mask was inverting clean DAPI sections to all-remove).

### Validation status (all green)
- **Python: 388 passed, 0 skipped, 0 failed on Windows** (incl. the now-running Tier 1 count/collate tests) + 2 new heartbeat tests.
- Tier 1 **count resize-axis** validated on a non-square annotation (detection maps to correct quadrant). **collate** single+multi totals sum correctly. **max** single-Z passthrough + realistic Z-stack projection correct. `csv/structure_map.pkl` present (Count/Align/Intensity OK).
- **JS: 24/24**. **tsc** clean (`main.js`/`batch_queue.js` in sync — no TS source edits this session). Windows release built: `out/make/zip/win32/x64/masonjar-win32-x64-3.3.7.zip`.

### Still to validate via the live run (monitor outputs)
CZI extract incl. non-primary "starters" channel; Orient with mixed transforms (verify on-disk previews/z-stacks rotate correctly); detection on a real max TIFF; Count→Collate on real annotations (needs alignment first); a cancelled Batch run.

### OPEN DECISION for the user (ask before implementing)
`py/map.py` raises a clear error and stops the whole Alignment session when a DAPI PNG is unreadable. Should it instead estimate that slice's AP position from neighbors (delta spacing) so one bad PNG doesn't block the session? Not yet decided.

### Deferred polish (after real-data #1)
Orientation auto-bake (auto_repairable is conservative/review-only), file-handle leaks, atomic geometry writes, skip-vs-merge run-mode semantics, double overlay render in adjust, unused kill-IPC senders. Also a latent (non-real-data) edge case: `py/max.py` projects over `np.argmin(shape)` — wrong only if a spatial axis is smaller than Z (never with real microscopy images).

## Current release

| Item | Value |
|------|--------|
| `package.json` version | **4.0.0** |
| Latest tag | `v4.0.0` |
| GitHub releases | https://github.com/matsojr22/masonjar/releases |

**v4.0.0** — **Major:** per-section Align layout (`py/align_tissue_layout.py`, `py/map.py`, `-w auto`); Viewer/Editor Paint `QDockWidget` + file index ENAMETOOLONG fix (`js/file_index.js`); tissue cleanup Apply hang + keep brush; CUDA torch pin (`py/requirements.txt` `2.7.1+cu118`); count/collate/batch/CZI fixes from `experimental/masonjar-debug-fixes` merged to `main`.

**v3.3.7** — **Multi-folder CZI import**: [`py/czi_common.py`](../py/czi_common.py) `build_files_lookup` / `resolve_file_entry`; [`py/czi_extract.py`](../py/czi_extract.py) path-aware work items; [`js/czi_import.js`](../js/czi_import.js) `resolveChannelForSlice` for repair targets; [`js/czi_wizard.js`](../js/czi_wizard.js) matched/expected index note. Tests: `python/tests/test_czi_multidir_extract.py`, `scripts/test-czi-import.js`.

**v3.3.6** — **Viewer/Editor launch fix**: [`py/adjust.py`](../py/adjust.py) `_init_paint_region_controls()` after paint-target strip; [`js/project_files.js`](../js/project_files.js) `proj` before `settings`. **Geometry on open**: [`js/geometry_state.js`](../js/geometry_state.js) `reconcileGeometryOnOpen`, workspace banner ([`pages/workspace_menu.html`](../pages/workspace_menu.html)); [`py/geometry_history.py`](../py/geometry_history.py) audit log from [`py/apply_geometry.py`](../py/apply_geometry.py). Tests: `python/tests/test_adjust_overlay_init.py`, `scripts/test-geometry-state.js`.

**v3.3.5** — **Re-import selected CZI sections**: [`pages/czi_reimport_wizard.html`](../pages/czi_reimport_wizard.html) + [`js/czi_reimport_wizard.js`](../js/czi_reimport_wizard.js); `repair_mode: reextract` + `refresh_max_slices_in_run` in [`py/czi_extract.py`](../py/czi_extract.py); blank preview audit in [`js/czi_import.js`](../js/czi_import.js). **Check Orientation Consistency** entry from Orient only (removed from preprocess menu). Tests: `scripts/test-czi-import.js`, `python/tests/test_czi_reextract.py`.

**v3.3.4** — **DAPI geometry repair z-stack path**: [`py/czi_common.py`](../py/czi_common.py) `resolve_original_zstack_path` (DAPI flat `original_scans/{sliceId}.tif`); [`py/apply_geometry.py`](../py/apply_geometry.py) DAPI PNG fallback when no z-stack; [`py/geometry_orientation_match.py`](../py/geometry_orientation_match.py) probe prefers `transform_original` for DAPI without stack. Tests: `python/tests/test_apply_geometry.py`, `python/tests/test_czi_common.py`.

**v3.3.3** — **io_fairshare TIFF repair fix**: [`py/io_fairshare.py`](../py/io_fairshare.py) `_wrap_tiff_imread`/`_wrap_tiff_imwrite` call `orig()` for `BytesIO` buffers; `_path_read_bytes`/`_path_write_bytes` bypass patched `Path` methods — fixes geometry repair `BytesIO` / recursion errors on NAS-throttled z-stack writes. Tests: `python/tests/test_io_fairshare.py`, `python/tests/test_apply_geometry.py`.

**v3.3.2** — **Geometry state shadowing hotfix**: [`js/geometry_state.js`](../js/geometry_state.js) `configFingerprint` / `resolveSliceIds` parameter renamed to `importCfg` so the `czi_import` module is not shadowed; fixes Check orientation slice list resolution from import config (v3.3.1 regression).

**v3.3.1** — **Check orientation UX + M468 fixes**: always-visible **Check orientation** ([`pages/orient.html`](../pages/orient.html), [`js/menu_category.js`](../js/menu_category.js)); [`js/geometry_state.js`](../js/geometry_state.js) signals `reapply_stack_risk`, `partial_pending_subset`, `legacy_partial_suspect`; block unsafe re-Apply; [`py/apply_geometry.py`](../py/apply_geometry.py) `TiffFile` preflight abort + plane-wise z-stack I/O + `derivatives_from_original` repair; wizard polish. Tests: `scripts/test-geometry-state.js`, `python/tests/test_apply_geometry.py`.

**v3.3.0** — **Geometry partial-apply recovery**: [`js/geometry_state.js`](../js/geometry_state.js) policy audit; [`pages/geometry_repair_wizard.html`](../pages/geometry_repair_wizard.html) + [`js/geometry_repair_wizard.js`](../js/geometry_repair_wizard.js) full-series fingerprint probe ([`py/geometry_fingerprint_probe.py`](../py/geometry_fingerprint_probe.py), [`py/geometry_orientation_match.py`](../py/geometry_orientation_match.py)); cross-channel mask IoU (not intensity); [`py/apply_geometry.py`](../py/apply_geometry.py) progress manifest + `repair_mode: geometry`; Orient **Rebuild geometry** / **Finalize only**; batch preflight uses `ops` geometry. Meta: `.masonjar/geometry_apply_progress.json`, `geometry_apply_last_result.json`, `geometry_repair_queue.json`. IPC: `runGeometryFingerprintProbe`. Tests: `scripts/test-geometry-state.js`, `python/tests/test_geometry_orientation_match.py`.

**v3.2.5** — **io-fairshare EPERM fix**: [`src/io_fairshare.ts`](../src/io_fairshare.ts) `writeJsonAtomic` Windows lock fallback + in-place retry; `registerJob`/`touchJob`/heartbeat timer best-effort (no main-process crash). Tests: repeated `writeJsonAtomic` in `scripts/test-io-fairshare.js`.

**v3.2.4** — **Viewer/Editor UX**: [`py/adjust.py`](../py/adjust.py) compact toolbars + paint-target strip + brush cursor; `resolve_label_color` overlay fix; stroke-end/undo/refresh full recolor; floatable **Parcellation** `QDockWidget`; preview excludes; metadata exclude reload. Tests: `python/tests/test_adjust_brush_overlay.py`.

**v3.2.3** — **Settings → Network**: moved fair-share UI off start hub; [`pages/settings.html`](../pages/settings.html) + [`pages/settings_network.html`](../pages/settings_network.html); **Select network drives…** multi-picker → `normalizeNasPathPrefix` / `mergeNasPathPrefixes` → shared `config.json` `nas_path_prefixes`; status fields `nas_path_prefixes`, `shared_config_path`, `shared_link_mbps`; IPC `showOpenNetworkLocationsDialog`, `ioFairshareSharedConfigError`. Docs [`docs/LAB_NETWORK.md`](LAB_NETWORK.md). Tests/smoke extended.

**v3.2.2** — **Import handoff UX**: CZI finish + workspace banner → alignment next; Completed tasks shows import outputs; max run discovery depth 3; [`reconcileProjectRunsOnOpen`](js/pipeline_runs.js) on project open. Publish script defaults to **pre-release** (`--stable` for full release).

**v3.2.1** — **NAS prefix fix**: fair-share throttles UNC + `nas_path_prefixes` in shared config (mapped drives like `Z:\`); local disks not throttled.

**v3.2.0** — **NAS bandwidth fair-share** for multi-instance / multi-user compute servers: [`src/io_fairshare.ts`](../src/io_fairshare.ts), [`py/io_fairshare.py`](../py/io_fairshare.py), `pipeline_io_bootstrap` in heavy `py/` scripts. Coordinator `%ProgramData%\MasonJar\io-fairshare\` (Windows). IPC `getIoFairshareStatus`, `saveIoFairshareUserConfig`. UI [`js/io_fairshare_settings.js`](../js/io_fairshare_settings.js) on start hub. Docs [`docs/LAB_NETWORK.md`](LAB_NETWORK.md). Tests: `scripts/test-io-fairshare.js`, `python/tests/test_io_fairshare.py`.

**v3.1.0** — **Viewer/preprocess UX**: Sharpen/top-hat manual **Preview filter**, display min/max, pan-only base ([`js/preprocess_wizard.js`](../js/preprocess_wizard.js)). **Adjust**: QSplitter parcellation drawer, background channel combo + `00_dapi` fallback ([`py/adjust_channels.py`](../py/adjust_channels.py)), paint search box; bulk parcellation removed from single-section viewer. **Parcellation (bulk)**: included-region dual list ([`js/region_dual_list.js`](../js/region_dual_list.js), `included_region_ids`, [`py/annotation_exclusion.py`](../py/annotation_exclusion.py) `apply_inclusion`). **Count**: removed Save layer info. **Tissue cleanup**: mask overlay hidden until edit; `ensure_keep_mask_polarity` on auto/guided.

**v3.0.0** — **Semi-manual tissue edge cleanup UX**: menu dedupe/rename/order; static canvas; green keep / red remove overlays; `parse_stroke_points` fixes trace `KeyError`; `--edge-shrink` on auto/guided; eraser orphan island prune in [`js/tissue_cleanup_canvas.js`](../js/tissue_cleanup_canvas.js). **Preprocess wizards**: [`js/preprocess_wizard.js`](../js/preprocess_wizard.js) always shows source dataset row; **Back to preprocessing** on sharpen/top-hat. Build: `node scripts/build-release.js`; publish `node scripts/publish-release.js --all-platforms`.

**v2.4.11** — **Tissue edge cleanup wizard** (initial ship): [`pages/tissue_cleanup_wizard.html`](../pages/tissue_cleanup_wizard.html), [`js/tissue_cleanup_wizard.js`](../js/tissue_cleanup_wizard.js), [`js/tissue_cleanup_canvas.js`](../js/tissue_cleanup_canvas.js), [`py/tissue_cleanup.py`](../py/tissue_cleanup.py), [`py/bundle_slice_paths.py`](../py/bundle_slice_paths.py) (sharpen/tophat globs; shared with [`py/apply_geometry.py`](../py/apply_geometry.py)). IPC: `runTissueCleanupAuto`, `runTissueCleanupGuided`, `runTissueCleanupApply`, `killTissueCleanup`. Draft `.masonjar/tissue_cleanup_draft/`; backup `.masonjar/tissue_cleanup_backup/`; `processing.tissue_cleanup` on project JSON. Tests: `python/tests/test_tissue_mask.py`, `scripts/test-tissue-cleanup-paths.js`.

**v2.4.10** — Cumulative orient geometry: per-slice `geometry.ops` (`rot90`, `flipX`, `flipY`) with DOMMatrix preview WYSIWYG in shared [`js/orient_geometry.js`](../js/orient_geometry.js); identical behavior in CZI wizard step 5 and menu **Orient slices**; in-place tile updates on geo clicks; [`py/apply_geometry.py`](../py/apply_geometry.py) `compose_ops_from_spec`. Tests: `scripts/test-orient-geometry.js`, `python/tests/test_apply_geometry.py`.

**v2.4.9** — Hotfix: CZI extract no longer uses `ndarray or planes[0]` when picking a signal preview plane after multi-Z stack write (fixes `ValueError: truth value of an array is ambiguous` on first somata item). Test: `test_extract_multi_z_preview_no_truthiness_error`.

**v2.4.8** — Hotfix: export `collectChannelProbeWarnings` from [`js/czi_import.js`](js/czi_import.js) so CZI wizard reprobe can render per-channel probe alerts (fixes `collectChannelProbeWarnings is not a function`). Includes v2.4.7 CZI sparse-Z + mosaic read fallbacks.

**v2.4.7** — CZI import robustness for mosaic DAPI and sparse-Z counterstain. [`py/czi_common.py`](py/czi_common.py) `z_indices_with_data` skips empty Z slots (single focal-plane counterstain); `read_czi_plane` falls back from `read_mosaic` to `read_image` to per-tile composite on pixel-type errors. [`py/czi_probe.py`](py/czi_probe.py) per-channel `channel_pixel_probe` + wizard channel read alerts. Tests: `python/tests/test_czi_common.py` (sparse-Z, pixel fallback, probe).

**v2.4.6** — CCF parcellation hierarchy in Viewer/Editor and optional Align Finish. [`py/annotation_relabel.py`](py/annotation_relabel.py) + [`py/structure_catalog.py`](py/structure_catalog.py) `ancestor_at_level` / `relabel_to_target` roll annotation PKL borders up semantic tiers or raw `st_level`. Adjust **Parcellation (this section)** panel: preview, apply (confirm + revert brush edits on current slice only), restore fine from `.masonjar/annotation_full/{sliceId}.pkl`, per-slice metadata in `.masonjar/annotation_parcellation.json`. **Quick: layers → functional areas** uses same path. Align Napari **Parcellation** dropdown applies level on Finish (default full detail). Tests: `python/tests/test_annotation_relabel.py`.

**v2.4.5** — CZI multi-folder import reliability. `canonicalSourceDir()` (`path.resolve`) on all wizard `source_dir` strings so Windows path variants cannot reset folder-2 `scan_index` to 0 (fixes M514 two-day interleave). Probe IPC always resolves (`cziProbeResult` on close/kill/error; 60 min wizard timeout; single-flight CZI guard). Step 2 **`probeLog`** mirrors `cziJobLog`/`updateLoad`; Application log replays buffered lines on first open. Re-probe all no longer kills an in-flight probe. Tests: `testResyncScanIndicesCanonicalPaths`, `testMergeProbeDirCanonicalReplace` in `scripts/test-czi-import.js`.

**v2.4.4** — CZI multi-folder import ordering. Step 2 probes **incrementally** (new folder only on add; **Re-probe all** for full refresh); live `probeStatus` from `updateLoad`. Folder list order drives batch concatenation via `scan_index` in `naturalCompare` / `buildSliceOrder` (e.g. two M514 day folders → `M514_s001`… contiguous, not interleaved by section number). Channels keyed by `file.path` for duplicate basenames across folders. Step 2 UI: numbered folders, per-folder file counts, ↑↓ reorder without re-probe, mosaic info capped in DOM. Tests: `testBuildSliceOrderTwoDirsDuplicateNames` in `scripts/test-czi-import.js`.

**v2.4.3** — Align warp failure handling. [`py/demons.py`](py/demons.py) fixes flat-edge divide-by-zero in `preprocess_image`, adds registration preflight/fallbacks (retry without edge preprocess, geometry-only). [`py/map.py`](py/map.py) `finish()` skips failed slices per-section, writes `warp_ok`/`warp_failed` to run manifest + `.masonjar/align_warp_report.json`. Project JSON `processing.step_failures.align` tracks failures; workspace hub **Alignment issues** section; downstream Count/Intensity/Adjust exclude failed slices via `getProcessingSliceIds`. Tests: `python/tests/test_demons_preprocess.py`, `scripts/test-step-failures.js`.

**v2.4.2** — CZI scene counting fix. `scene_indices_from_czi` no longer treats Z-only dim blocks as scenes (`M467(57).czi` with 57 Z planes → 1 scene, not 57 renaming rows). Mosaic files stay single-scene; inconsistent multi-block shapes use S range starts per aicspylibczi. Wizard step 3 help clarifies one row per tissue section. Regression tests in `python/tests/test_czi_common.py` + `scripts/test-czi-import.js`.

**v2.4.1** — CZI import slice ordering fix. Chunked natural sort (digit-run token compare) fixes `M467(57)..M467(108)` and similar ZEN exports; probe-time **Slice number follows** dropdown detects filename prefixes (`M467(`, `file.`, etc.) so users pick which numeric group is the slice index. JS/Python parity in `js/czi_import.js` + `py/czi_common.py`; wizard step 2/3 dropdown refreshes `slice_order` and renaming table on change. Config key `section_identifier` (excluded from resume fingerprint).

**v2.4.0** — Batch wizard rework. Replaces the three-page `batch_select` → `batch_params` → `batch_run` flow with a single 3-step wizard (`pages/batch_wizard.html` + `js/batch_wizard.js`) mirroring the CZI / Intensity wizards. Adds DAPI cleanup, Apply geometry, and Collate (one-shot end-of-batch) to the batch tool set. `src/batch_queue.ts` now matches single-tool handlers: `pythonShellEnv()` everywhere (Windows UTF-8), `--slice-list` on detect/count/intensity, intensity `--config` + `NO_PKLS_WRITTEN` failure path, `applyPostStepSideEffects` (active_runs sync + index refresh), dependency graph with per-project skip-downstream, and lightweight `preflightJob` auto-repair (structure_map copy, slice-list rebuild, geometry no-op detection, DAPI empty check, collate min-projects check). New IPC channels: `batchJobLog`, `batchJobEnd`; extended `batchJobStart` (`projectIndex` / `stepIndex`) and `batchComplete` (`{ summary, errors, cancelled }`). Per-batch summary persists to `<bundleRoot>/.masonjar/last_batch_summary.json`. Small UI tweak: rename "Parent directory" / "Parent folder" labels to "Location to store all Mason Jar Projects" in project_start, project_wizard, czi_wizard. New JS dev tests: `scripts/test-batch-plan.js`, `scripts/test-batch-paths.js` (added to `yarn test:js`).

**v2.3.0** — Align/Viewer windows raise and focus on launch (Electron blurs parent; `py/qt_window_utils.py`); CCF picker gets semantic tiers (Major / Classic regions / Functional areas / Sub-areas / Cortical layers) with **Advanced — show CCFv3 raw depths** toggle in both Viewer/Editor and Isolate Regions wizard.

**v2.2.0** — Viewer/Editor CCF hierarchy + searchable area picker; fix align/adjust launch (overlay init, `qt_image_utils`, IPC argv tokens). Includes Isolate Regions wizard and SAHI cell-detector fix from v2.1.0+.

**v2.1.2** — main window starts maximized on macOS/Windows; pipeline tool pages scroll when content exceeds the viewport (`tool-page` via `js/run.js`).

**v2.1.1** artifacts (all platforms): Windows zip, macOS Intel DMG, macOS Apple Silicon DMG.

## Shipped this session (summary)

1. **Isolate Regions wizard** — `intensity.html` setup → `intensity_wizard.html` (CCF dual-list, layer toggle, parent-area colors, progress, summary). Config: `.masonjar/intensity_run_config.json`; Python `py/region_config.py`, `region.py --config`. Style: `docs/isolate_regions_style.md`, `js/atlas_region_style.js`.
2. **Cell detector SAHI fix** — `py/find_neurons.py` `_call_get_sliced_prediction()` only passes `progress_bar` / `progress_callback` when installed `sahi~=0.11.x` supports them (avoids `TypeError` on Windows package).
3. **Earlier patch line** (already on `main` before wizard): log UX, hub copy, intensity path/whole-flag fixes (v2.0.2–v2.0.4).

## Key paths for agents

| Area | Files |
|------|--------|
| Isolate wizard UI | `pages/intensity_wizard.html`, `js/intensity_wizard.js`, `js/intensity.js` |
| CCF catalog / colors | `js/structure_catalog.js`, `py/structure_catalog.py`, `js/atlas_region_style.js`, `csv/structure_graph.json` |
| CCF tier / Advanced picker | `listTiers` / `list_tiers`, `listCcfLevels` / `list_ccf_levels`, `formatCcfLevelLabel` / `format_ccf_level_label`, `CCF_ADVANCED_HELP` (shared py/js). Wizard: `#tierSelect`, `#levelSelect`, `#ccfAdvancedToggle`, `#ccfAdvancedHelp`; sessionStorage `masonjar.ccfPickerMode`. Viewer: `tier_combo`, `level_combo`, `ccf_advanced_toggle`, `ccf_advanced_help` in `py/adjust.py`. Style guide: `docs/isolate_regions_style.md` (Hierarchy picker section). |
| Window focus on launch | `py/qt_window_utils.py` (`raise_and_activate`, `raise_and_activate_napari`); wired in `py/adjust.py` (after `window.show()`) and `py/map.py` (`AlignmentController.start_viewer`). `src/main.ts` `runAlign` / `runAdjust` blur parent BrowserWindow after `PythonShell` spawn (compile `main.js`). |
| Isolate Python | `py/region.py`, `py/region_config.py`, `py/intensity_flags.py` |
| Detection Python | `py/find_neurons.py` (SAHI compat wrapper) |
| IPC | `src/main.ts` → compile `main.js`; `runIntensity` arg[6] = config path |
| Release | `node scripts/build-release.js`, `node scripts/publish-release.js --all-platforms` |

## Tests to run after changes

```bash
./node_modules/.bin/tsc
node scripts/test-structure-catalog.js
node scripts/test-atlas-region-style.js
cd python && pytest tests/test_structure_catalog.py tests/test_qt_window_utils.py tests/test_adjust_overlay_init.py tests/test_region_config.py tests/test_region_whole_flag.py tests/test_find_neurons_sahi.py -q
```

Full JS suite: `yarn test:js` (or individual `node scripts/test-*.js`).

## User context (optional)

- Primary OS: **Windows**; example project `M465_masonjar` under `Z:\Matt Jacobs\masonjar_projects\`.
- Manual verification still useful: Isolate wizard on a real bundle; cell detection after SAHI fix with **v2.1.1** zip (not an older Downloads build).

## Open / follow-up (not blocking shutdown)

- **Viewer/Editor paint picker** — shipped in working tree: PyQt hierarchy + searchable area combo in `py/adjust.py` via `py/structure_catalog.py` (default level 6). Target release **v2.2.0** when user requests build/publish.
- **SAHI**: When PyPI ships `progress_bar` / `progress_callback` (SAHI main PR #1255), optional `sahi>=0.12` in `py/requirements.txt` + benv refresh via `updatePythonDependencies`.
- **Linux release**: `node scripts/build-release.js --linux` if `.deb` artifacts are needed.
- **Package parity**: `python/src/belljar/detection/detector.py` could share the same SAHI kwargs wrapper (Electron uses `py/` only today).

## Conversation reference

Prior agent transcript (Isolate wizard + releases): [b7c43aa8](b7c43aa8-4142-4158-8377-2b3e66d447e5) in Cursor agent transcripts for this project.

## Picking up next session

1. Read [`AGENTS.md`](../AGENTS.md) for IPC, pipeline runs, and release rules.
2. Read this file for version and what was last shipped.
3. Confirm `git log -1` and `package.json` version match the release you intend to extend.
