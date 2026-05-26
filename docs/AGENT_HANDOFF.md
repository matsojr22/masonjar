# Agent session handoff

Last updated: 2026-05-26 (batch wizard rework). Use this file to resume work; long-term architecture stays in [`../AGENTS.md`](../AGENTS.md).

## Current release

| Item | Value |
|------|--------|
| `package.json` version | **2.3.0** (next release: 2.4.0 — batch wizard rework) |
| Latest tag | `v2.3.0` on `main` |
| GitHub releases | https://github.com/matsojr22/masonjar/releases |

**v2.4.0** (pending release) — Batch wizard rework. Replaces the three-page `batch_select` → `batch_params` → `batch_run` flow with a single 3-step wizard (`pages/batch_wizard.html` + `js/batch_wizard.js`) mirroring the CZI / Intensity wizards. Adds DAPI cleanup, Apply geometry, and Collate (one-shot end-of-batch) to the batch tool set. `src/batch_queue.ts` now matches single-tool handlers: `pythonShellEnv()` everywhere (Windows UTF-8), `--slice-list` on detect/count/intensity, intensity `--config` + `NO_PKLS_WRITTEN` failure path, `applyPostStepSideEffects` (active_runs sync + index refresh), dependency graph with per-project skip-downstream, and lightweight `preflightJob` auto-repair (structure_map copy, slice-list rebuild, geometry no-op detection, DAPI empty check, collate min-projects check). New IPC channels: `batchJobLog`, `batchJobEnd`; extended `batchJobStart` (`projectIndex` / `stepIndex`) and `batchComplete` (`{ summary, errors, cancelled }`). Per-batch summary persists to `<bundleRoot>/.masonjar/last_batch_summary.json`. Small UI tweak: rename "Parent directory" / "Parent folder" labels to "Location to store all Mason Jar Projects" in project_start, project_wizard, czi_wizard. New JS dev tests: `scripts/test-batch-plan.js`, `scripts/test-batch-paths.js` (added to `yarn test:js`).

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
