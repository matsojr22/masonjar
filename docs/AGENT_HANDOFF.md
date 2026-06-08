# Agent session handoff

Last updated: 2026-06-05 (io-fairshare EPERM fix v3.2.5). Use this file to resume work; long-term architecture stays in [`../AGENTS.md`](../AGENTS.md).

**GitHub releases and git commits** use human copy in [`RELEASE_NOTES.md`](RELEASE_NOTES.md) — not this file. See [`COMMIT_AND_RELEASE.md`](COMMIT_AND_RELEASE.md).

## Current release

| Item | Value |
|------|--------|
| `package.json` version | **3.2.5** |
| Latest tag | `v3.2.5` (pre-release on GitHub, pending publish) |
| GitHub releases | https://github.com/matsojr22/masonjar/releases |

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
