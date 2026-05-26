# Agent session handoff

Last updated: 2026-05-26. Use this file to resume work; long-term architecture stays in [`../AGENTS.md`](../AGENTS.md).

## Current release

| Item | Value |
|------|--------|
| `package.json` version | **2.2.0** |
| Latest tag | `v2.2.0` on `main` |
| GitHub releases | https://github.com/matsojr22/masonjar/releases |

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
| Isolate Python | `py/region.py`, `py/region_config.py`, `py/intensity_flags.py` |
| Detection Python | `py/find_neurons.py` (SAHI compat wrapper) |
| IPC | `src/main.ts` → compile `main.js`; `runIntensity` arg[6] = config path |
| Release | `node scripts/build-release.js`, `node scripts/publish-release.js --all-platforms` |

## Tests to run after changes

```bash
./node_modules/.bin/tsc
node scripts/test-structure-catalog.js
node scripts/test-atlas-region-style.js
cd python && pytest tests/test_region_config.py tests/test_structure_catalog.py tests/test_find_neurons_sahi.py tests/test_region_whole_flag.py -q
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
