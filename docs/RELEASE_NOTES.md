# Mason Jar release notes (human-facing)

Copy for GitHub releases and suggested git commits. **Newest version at the top.**

Do not put agent instructions, file paths, test names, or IPC details here—use [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md) for that.

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
