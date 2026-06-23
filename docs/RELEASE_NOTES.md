# Mason Jar release notes (human-facing)

Copy for GitHub releases and suggested git commits. **Newest version at the top.**

Do not put agent instructions, file paths, test names, or IPC details here—use [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md) for that.

---

## v4.1.4

**What's new**

- Align: Mason Jar minimizes when Napari opens and shows a clear handoff message; Mason Jar restores when you Finish or Cancel.
- Align: Napari layout uses a top toolbar plus Tuning/Options docks on the left; layer list and layer controls on the right.

**Fixes**

- Align: Napari opens maximized and keeps focus on remote desktops (no double-click maximize).
- Image preprocessing: DAPI cleanup and Orient slices moved under **Deprecated & Experimental** (collapsed by default).

**Commit subject**

Align: calmer Napari handoff, layout polish, and deprecated preprocess submenu

---

## v4.1.3

**What's new**

Large full-resolution sharpen slices run reliably on remote desktops and memory-limited machines.

**Fixes**

- Sharpen: large max-projection TIFFs no longer fail with "Python exited with code 1" on memory-limited or remote-desktop machines; processing runs in tiles with progress in the log.
- Sharpen wizard: progress bar no longer jumps to 100% as soon as processing starts.

**Commit subject**

Sharpen: tile large slices to avoid OOM on remote desktops

---

## v4.1.2

**What's new**

Align controls in Napari use one scrollable panel; Previous, Next, and Finish stay visible on short or remote-desktop screens.

**Fixes**

- Align: canceling the tissue-damage marker no longer excludes the whole atlas from registration.
- Align and DAPI cleanup: a prior align failure no longer blocks re-running align or DAPI cleanup on the same slice.
- Align: the Napari window opens within your screen bounds on remote desktops.

**Commit subject**

Align: fix damage-mask cancel, retry blocking, and Napari controls on RDP

---

## v4.1.1

**What's new**

Sharpen batch runs reliably on Windows and network drives — the same sequential processing model as the top-hat filter.

**Fixes**

- Sharpen: fixed batch runs that wrote zero files with `SHARPEN_NO_OUTPUT` and "process pool was terminated abruptly" on Windows/NAS.
- Sharpen: per-slice error messages in the log when a file fails.

**Commit subject**

Sharpen: fix batch failures on Windows by processing slices sequentially

---

## v4.1.0

**What's new**

Align again saves your AP and angle tuning when you close Napari and re-open Align. Forward AP suggestions follow the spacing you set on sections you have already tuned. Mason Jar automatically removes broken alignment session files from your project's DAPI folder when they cannot be loaded.

**Fixes**

- Align: tuning persists across close and re-open (pickle save no longer fails silently).
- Align: AP suggestions use your confirmed sections only, not raw model predictions (fixes wild values like 1100).
- Align: going to a previous section no longer overwrites saved AP values.
- Align: re-open always starts at section 1 with your saved tuning restored.
- Align: incompatible or corrupt `alignment.pkl` / `alignment_session.json` in `00_dapi` are cleared automatically on the next run — no manual delete step.

**Commit subject**

Align: save tuning across sessions and clear broken session files automatically

---

## v4.0.8

**What's new**

Align forward AP suggestions now follow the direction you set on the first sections you tune (posterior sections get higher AP when your first two do). Alignment saves and diagnostic lines appear in the Application log.

**Fixes**

- Align: fixed backwards AP spacing after visiting the first two sections (`adjust_positions` off-by-one).
- Align: spinbox updates no longer race with Next/close saves (`blockSignals` on display refresh).
- Align: `LOG:` lines from Align/Adjust appear in the Application log, not only the progress bar.

**Recovery:** If a prior run saved bad AP values, delete `00_dapi/alignment.pkl` and `alignment_session.json` once, then re-run Align.

**Commit subject**

Align: fix AP spacing direction, persistence races, and log visibility

---

## v4.0.7

**What's new**

Align again opens with sensible predicted AP positions and angles on the first section. If a bad autosave from v4.0.6 is on disk, Mason Jar clears it automatically and re-runs predictions.

**Fixes**

- Align: restored tissue predictor results on startup (v4.0.6 could save AP=0 and zero angles before the viewer opened).
- Align: automatically discards corrupt `predict_complete` autosaves from v4.0.6 and re-runs predictions.
- Align: closing Napari with X still saves your tuning (v4.0.6 behavior preserved).

**Commit subject**

Align hotfix: stop predict_complete autosave from wiping predictions

---

## v4.0.6

**What's new**

Align saves your section tuning when you close Napari with the window **X** or **Cancel** on the Align page. Re-run Align and your AP, angles, and layout choices restore from the saved session in `00_dapi`.

**Fixes**

- Align: spinbox edits are saved immediately before Next/Previous and on window close (no 500 ms debounce gap).
- Align: closing Napari no longer shows a false **Python exited with code 1** error or duplicate log lines.
- Align / Adjust: viewer close with a non-zero exit code is treated as a clean cancel when tuning was saved.

**Commit subject**

Align saves tuning when Napari closes; fix false exit code 1 on window X

---

## v4.0.5

**What's new**

Align and Viewer/Editor no longer leave Mason Jar stuck when you **Cancel** or close the viewer window. Alignment tuning is saved on Cancel as well as when you close Napari. Tissue cleanup **Apply** handles large NAS z-stack bundles without crashing. **Check Orientation Consistency** applies confirmed rotations across the full pipeline, and the orient grid lists all sections.

**Changes**

- Align / Adjust: Cancel requests a graceful save and exit; UI always returns to Run.
- Align: tissue edge-cleanup masks and gap warp strategies for registration.
- Tissue cleanup Apply: streaming TIFF I/O and resume checkpoint for large jobs.
- Orient / geometry repair: full-pipeline apply from repair wizard; slice list includes all sections.

**Commit subject**

Align and Adjust Cancel no longer hang; tissue cleanup and geometry repair fixes

---

## v4.0.4

**What's new**

Closing the Atlas Alignment Napari window without clicking **Finish** no longer leaves Mason Jar stuck on a running job. Your section tuning (AP, angles, layout) is saved automatically, and the Align page returns to **Run** so you can reopen and continue—or click **Finish** when you are ready to warp.

**Changes**

- Align: tuning autosave when you close Napari; saved choices restore on the next run even if the output folder slug changed.
- Align: closing Napari without Finish resets the UI without marking a completed alignment run.

**Commit subject**

Align saves tuning on Napari close and no longer hangs the UI

---

## v4.0.3

**What's new**

Sharpen and Top-hat **Preview filter** no longer turns the tissue completely black. The filter now runs on the same preview image you see in the wizard, pan/zoom clears a stale filter overlay, and display min/max sliders apply to the filtered region.

**Changes**

- Sharpen / Top-hat: preview filter uses the displayed signal preview (not mismatched full-res coordinates).
- Sharpen / Top-hat: filtered ROI overlay respects display levels; pan/zoom resets filter preview until you click Preview filter again.

**Commit subject**

Sharpen and Top-hat preview filter no longer black out the image

---

## v4.0.2

**What's new**

Sharpen and Top-hat filter wizards now show the correct signal-channel preview (not DAPI) when you pick a rabies, somata, or other branch. Filter preview matches the region you pan and zoom, display min/max sliders work on filtered previews, and runs write TIFF outputs instead of leaving an empty sharpen or top-hat folder. The wizard stays on the progress step and reports an error when processing fails.

**Changes**

- Sharpen / Top-hat: branch-aware preview images, scaled filter ROI, composite filtered preview with pan/zoom.
- Sharpen / Top-hat: slice list intersected with source dataset; TIFF-only slice picker.
- Sharpen: reliable TIFF output (uint16 and `.ome.tif` inputs supported).
- Run failure surfaced in wizard UI instead of false success on empty output folders.

**Commit subject**

Sharpen and Top-hat wizards preview and run correctly again

---

## v4.0.1

**What's new**

The Windows download now extracts into a single folder named `masonjar-win32-x64`, so unzipping in Downloads no longer scatters app files into that folder.

**Changes**

- Windows zip layout: all app files live under `masonjar-win32-x64/` at the top level of the archive.

**Commit subject**

Windows zip extracts into masonjar-win32-x64 folder

---

## v4.0.0

**What's new**

Align Sections now handles mixed whole-brain and single-hemisphere series automatically — each section is detected and can be overridden in Napari. Viewer/Editor has a redesigned Paint panel (floatable dock) so region picking and brush tools stay accessible on smaller screens. Cell detection uses your NVIDIA GPU again on Windows after a fix to the bundled PyTorch install.

**Changes**

- **Align:** Automatic per-section layout (whole vs left hemisphere); Section layout override in Napari; layouts flow through to Isolate Regions.
- **Viewer/Editor:** Paint controls in a floatable dock; slim header for section navigation, channel, overlay, and Allow Adjustment.
- **Viewer/Editor:** File index rebuild after large align runs no longer fails on Windows, so DAPI/annotation pairing works again.
- **Tissue edge cleanup:** Apply step no longer hangs; Keep brush to add tissue; mask polarity fix for DAPI counterstain.
- **Cell detection:** Pin CUDA PyTorch on Windows/Linux so detection uses the GPU instead of CPU-only wheels.
- **Pipeline:** Count, collate, batch, CZI import, max/sharpen/tophat slice lists, align warp retries, and related fixes from the 3.3.x line.

**Commit subject**

Mason Jar 4.0 — mixed-section align, Viewer/Editor Paint dock, GPU detection

**Commit body**

Major release combining automatic per-section align layout, Viewer/Editor UI and index fixes, tissue cleanup reliability, CUDA PyTorch for cell detection, and accumulated pipeline hardening from experimental validation on real M457 data.

---

## v3.3.7

**What's new**

Multi-folder CZI imports (two or more source directories with the same `.czi` filenames) now extract and repair all sections correctly.

**Changes**

- Python extract resolves each channel row by full file path, not basename alone, so folder 2 slices are no longer mapped to folder 1’s CZI files.
- Preview repair picks the DAPI channel for each slice from `slice_order`, fixing missing counterstain on later folders.
- CZI wizard shows matched vs expected slice counts (e.g. `45 / 61`) and warns when DAPI and max pairing is incomplete.

**Commit subject**

Fix multi-folder CZI import when source folders share filenames

---

## v3.3.6

**What's new**

Viewer/Editor (Adjust) opens again after a crash on launch in v3.3.5.

**Changes**

- Fix startup crash when the paint-target toolbar initialized before its widgets were created.
- Fix workspace menu error when opening a project with CZI import history.
- Geometry apply recovery: workspace banner when a prior orient/geometry run was interrupted; audit log under `.masonjar/geometry_history.jsonl`.

**Commit subject**

Fix Viewer/Editor launch crash and workspace settings error

---

## v3.3.5

**What's new**

You can re-import selected sections from the original CZI files when a few slices have bad counterstain (e.g. black DAPI) without re-running the full import. Use **Re-import sections from CZI** from the workspace, Image preprocessing menu, or Orient when blank DAPI is detected.

**Changes**

- New wizard: pick sections and channels, confirm overwrite, re-read only those slices from source `.czi` files.
- Blank DAPI preview detection flags nearly black counterstain images and offers a direct link to re-import.
- **Check Orientation Consistency** moved off the preprocess menu; open it from **Orient slices** (renamed from “Check orientation”).

**Commit subject**

Re-import selected CZI sections without full re-import

---

## v3.3.4

**What's new**

Check orientation repair no longer fails on DAPI preview files looking for a z-stack under `original_scans/dapi/`. DAPI stacks from CZI import live at `original_scans/{section}.tif`; when no stack exists, repair transforms the existing DAPI PNGs instead.

**Changes**

- Geometry repair resolves DAPI z-stack paths using the same layout as CZI import (flat under `original_scans/`).
- Fallback transforms `_previews` and `00_dapi` PNGs when no DAPI z-stack is on disk.
- Orientation audit suggests in-place DAPI transform when no z-stack is available.

**Commit subject**

Fix DAPI geometry repair z-stack path

---

## v3.3.3

**What's new**

Geometry repair (**Check orientation** → repair) no longer fails on z-stack TIFFs stored on network drives. v3.3.2 could error with "expected str, bytes or os.PathLike object, not BytesIO" partway through a repair run.

**Changes**

- io_fairshare TIFF read/write patches no longer recurse through themselves when buffering to memory.
- Throttled file writes use the original Path helpers, avoiding infinite recursion on small files.

**Commit subject**

Fix geometry repair TIFF writes on network drives

---

## v3.3.2

**What's new**

Fixes **Check orientation** failing to load slice lists on projects that rely on the CZI import config (v3.3.1 regression).

**Changes**

- Geometry state helpers no longer confuse the import config object with the CZI import module when resolving slice IDs.

**Commit subject**

Fix Check orientation slice list after geometry state regression

---

## v3.3.1

**What's new**

**Check orientation** is always available from Orient and the Image preprocessing menu — you no longer need an interrupted-apply flag to reach the full-series audit.

**Changes**

- Blocks unsafe re-Apply when files were already modified but pending geometry remains (e.g. partial apply on 25 of 71 slices).
- Detects legacy partial-apply crashes (pre-v3.3.0) via mtime signals without progress meta files.
- Large z-stack TIFFs on NAS paths: preflight probes metadata via `TiffFile` and aborts before the transform loop; plane-wise reads avoid io_fairshare `BytesIO` failures.
- Geometry repair executes `derivatives_from_original` — rebuilds previews from `original_scans` z-stacks.
- Repair wizard renamed **Check orientation** with clearer healthy-state and audit-error copy.

**Commit subject**

Check orientation UX, block unsafe re-Apply, large TIFF geometry fix

---

## v3.3.0

**What's new**

Orient and CZI import now detect interrupted geometry applies and offer a **Rebuild geometry** wizard that audits every tissue section, flags cross-channel mismatches, and repairs only what you approve.

**Changes**

- Apply geometry is blocked when a prior run stopped partway; use **Rebuild geometry** from Orient instead of re-Applying blindly.
- Repair wizard runs a full-series orientation audit (progress bar + log), then optional per-slice review before writing files.
- **Finalize only** when files are done but project settings were not reset.
- Batch **Apply geometry** respects the same interrupted-state checks.

**Commit subject**

Geometry repair wizard and interrupted-apply detection

---

## v3.2.5

**What's new**

Fixes a Windows crash during long jobs (e.g. Apply geometry) when network fair-share could not update its registry file.

**Changes**

- Registry heartbeats use Windows-safe writes with retry; failures are logged, not fatal.
- Orient / geometry and other heavy jobs continue even if `%ProgramData%\MasonJar\io-fairshare\registry\` is briefly locked.

**Commit subject**

Fix io-fairshare EPERM crash on Windows registry heartbeats

---

## v3.2.4

**What's new**

Viewer/Editor (Adjust) is easier to use: a compact paint toolbar, always-visible paint target, working refresh after brush strokes, and parcellation in a detachable side panel.

**Changes**

- Brush strokes show correct atlas colors when you finish painting, refresh, or undo.
- Paint-target strip shows region name, color, tier, and adjustment state; brush cursor ring when painting is enabled.
- Parcellation opens in a floatable dock (toggle **Parcellation…**); rollup preview respects exclude list.

**Commit subject**

Viewer/Editor brush overlay fix and compact parcellation dock

---

## v3.2.3

**What's new**

Network sharing settings moved to **Start → Settings → Network**. An admin or first user on a shared server can pick mapped drives or UNC shares with **Select network drives…**; Mason Jar saves normalized drive/share roots for everyone on that machine.

**Changes**

- Settings hub with **Network** page (per-user fair-share toggle and link speed unchanged).
- Shared `nas_path_prefixes` list visible to all RDP users; no manual JSON editing required for typical setup.
- Multi-select folder picker writes machine-wide config under `%ProgramData%\MasonJar\io-fairshare\`.

**Commit subject**

Settings Network page with shared NAS drive picker

---

## v3.2.2

**What's new**

After CZI import, the workspace now shows what was already produced (max projections, DAPI previews) and points you to **Atlas alignment** as the next step instead of re-running Max Projection. Opening an existing project rescans output folders once and fills in missing run selections.

**Changes**

- CZI wizard finish step and workspace banner explain next steps (alignment; counterstain cleanup if alignment is hard).
- Completed tasks discovers CZI max runs at the correct folder depth and lists DAPI/preview counts from import.
- Project open validates stored active runs against disk; clears broken slugs; auto-selects when only one run exists per role.

**Commit subject**

Import handoff UX and legacy run discovery on project open

---

## v3.2.1

**What's new**

Network fair-share now throttles mapped NAS drives (e.g. `Z:\`) when you list them in the shared config, not only UNC paths. Local disk I/O is left unthrottled.

**Changes**

- `nas_path_prefixes` in `%ProgramData%\MasonJar\io-fairshare\config.json` (e.g. `["Z:\\"]`).

**Commit subject**

Fix NAS fair-share for mapped drive letters on Windows

---

## v3.2.0

**What's new**

When several people run Mason Jar on the same Windows compute server, pipeline jobs now **share NAS bandwidth fairly** instead of one instance saturating the network. Each active job gets a slice of the link speed; when fewer jobs are running, each job can use more. Turn it on from the start hub under **Network sharing** (on by default). Link speed can auto-detect or be set manually if your server has multiple NICs.

**Changes**

- Adaptive fair-share for heavy pipeline steps (max, align, detect, CZI extract, batch, etc.).
- Start hub and workspace show active job count and approximate Mbps share.
- Sharpen reduces parallel workers when bandwidth share is small.

**Commit subject**

Share NAS bandwidth fairly when many Mason Jar instances run on one server

**Commit body**

Mason Jar 3.2.0 adds machine-wide adaptive I/O fair-share so pipeline jobs on a shared compute server split NAS bandwidth instead of one instance saturating the NIC. Configure link speed from the start hub Network sharing section.

---

## v3.1.0

**What's new**

Sharpen and Top-hat wizards are faster and easier to tune: pan and zoom stay responsive, display min/max sliders help you see faint tissue, and you click **Preview filter** when you want to see the filtered result. The Viewer/Editor gives images more room with a collapsible parcellation drawer, a background-channel dropdown (including pipeline DAPI when previews are missing), and a search box for paint-brush regions. Bulk parcellation now uses an **Included regions** list with multi-select. Count Brain no longer has the confusing **Save layer info** checkbox — use parcellation instead. Tissue edge cleanup only shows green/red overlays after you start editing a mask.

**Changes**

- Preprocess wizards: manual filter preview, optional auto-refresh after pan, display window sliders.
- Viewer/Editor: QSplitter parcellation drawer, channel combo, region search; bulk parcellation removed from single-section view.
- Parcellation (bulk): include-region dual list; `included_region_ids` in config.
- Count: removed layer-info option from UI and batch.
- Tissue cleanup: mask overlay hidden until edit; auto mask polarity fix.

**Commit subject**

Sharpen and Adjust UX improvements plus parcellation include list for v3.1

**Commit body**

Mason Jar 3.1.0 makes preprocess previews manual and fast, reworks the Adjust layout, switches bulk parcellation to included regions, drops Count layer info, and fixes tissue mask overlay semantics.

---

## v3.0.0

**What's new**

**Semi-manual tissue edge cleanup** (renamed from Tissue edge cleanup) is easier to use: click to place trace points, a fixed preview (no accidental pan/zoom), green overlay for tissue you keep and red for areas that will be removed, and a gentler **Attempt Auto** with adjustable **Edge shrink**. The eraser cleans up small stray pixels after you paint. **Sharpen** and **Top-hat filter** wizards now always show the **Source dataset** picker and a **Back to preprocessing** link. The preprocessing menu lists **DAPI cleanup** before the semi-manual tissue tool.

**Changes**

- Trace + Auto: fixed crash when finishing a trace; clearer click-to-trace instructions.
- Tissue wizard: static image, green/red masks, orphan pixel cleanup after erasing.
- Sharpen / Top-hat: source dataset row always visible; exit to preprocessing menu.

**Commit subject**

Improve tissue cleanup wizard and preprocess navigation for v3

**Commit body**

Renames the tissue edge tool, fixes trace JSON and mask UX, and makes sharpen/top-hat wizards easier to leave. Ships as Mason Jar 3.0.0 with desktop builds for macOS and Windows.

---

## v2.4.11

**What's new**

**Tissue edge cleanup** is a new wizard under Image preprocessing. Open a DAPI preview for each section, use **Attempt Auto** or **Trace edge then Auto** to build a keep mask, touch up with the **Eraser**, then confirm and **Apply**. Mason Jar backs up originals under `.masonjar/tissue_cleanup_backup/` and updates DAPI previews, orient previews, original-scan z-stacks, and max/sharpen/top-hat TIFFs for edited sections only. If you already ran **Align**, run it again after cleanup.

**Changes**

- New wizard: Tissue edge cleanup (4 steps: mask, confirm, apply, summary).
- Shared bundle path list includes sharpen and top-hat outputs when masking a section.

**Commit subject**

Add tissue edge cleanup wizard for section masks

**Commit body**

New preprocess wizard masks stray tissue at scan edges on DAPI previews, then applies keep masks across bundle images with backup. Re-run Align after cleanup if alignment was already done.

---

## v2.4.10

**What's new**

When you rotate a slice in Orient, then flip it, the preview keeps both steps instead of looking like only a flip or only a rotation. The same behavior applies in the CZI import wizard (Orient step) and in **Orient slices** from the start menu, and what you see in the preview matches what gets written when you click **Apply geometry**.

**Changes**

- Orient and CZI import: rotate and flip actions stack in the order you click them.
- CZI import (2.4.7–2.4.9): more reliable mosaic and counterstain reads; wizard reprobe and multi-Z extract fixes on Windows.

**Commit subject**

Orient preview keeps rotate and flip steps together

**Commit body**

Rotating then flipping a slice no longer reset the preview. Orient slices and the CZI wizard now apply geometry clicks in order so the preview matches the files written on disk.
