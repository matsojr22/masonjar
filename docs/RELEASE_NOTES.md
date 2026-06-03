# Mason Jar release notes (human-facing)

Copy for GitHub releases and suggested git commits. **Newest version at the top.**

Do not put agent instructions, file paths, test names, or IPC details here—use [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md) for that.

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
