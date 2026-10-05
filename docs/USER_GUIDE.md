# Mason Jar User Guide

This is the usage manual for Mason Jar. It explains how to install the app, how a project is organized, how information moves from one tool to the next, and the exact steps for every tool, including Batch and Settings.

Open this same manual in the app from the start screen (**Guide**) or from **Credits**.

## How to read this manual

Read **Projects** and **How information flows** before you run tools. Each tool chapter then uses the same headings:

- **What this tool does**
- **Why it is in Mason Jar**
- **Expected inputs**
- **What it writes and what uses it next**
- **Before you start**
- **Step-by-step**
- **Outputs**
- **If something goes wrong**

Paths below use a project named `M528` as the example. Your project name replaces `M528`. On Windows, `~` means your user profile (`%USERPROFILE%`).

## What Mason Jar does

Mason Jar analyzes mouse-brain neurohistology. A typical experiment imports Zeiss CZI sections, builds focused images, aligns those sections to the Allen Mouse Brain Atlas (CCFv3), detects labeled cells, counts cells by region, and can export region images.

Mason Jar is a fork of Bell Jar. It keeps the same scientific pipeline and adds `.masonjar` project bundles, CZI import, wizards, and batch runs across many brains.

## Requirements

- About 20 GB of free disk for the app environment (Python, models, embeddings), plus room for your projects.
- 32 GB of RAM minimum. 64 GB is recommended.
- A recent desktop CPU (Intel, Apple Silicon, or AMD Ryzen).
- A GPU with at least 6 GB of VRAM. Cell detection on Windows and Linux expects CUDA.

The app environment is separate from your project folders. Do not put the app inside a path that contains spaces or unusual characters if you are launching a portable build.

## Installation

1. Download the release for your computer from [GitHub Releases](https://github.com/matsojr22/masonjar/releases).
2. macOS: open the DMG and run **Mason Jar**. Windows: unzip `masonjar-win32-x64` so the app stays inside that folder, then run the executable.
3. macOS may block an unsigned app the first time. Use Apple's steps for opening an app from an identified developer, or open the app from the Finder context menu and choose **Open**.
4. The first launch downloads the embedded Python environment, models, and embeddings into `~/.masonjar` (Windows: `%USERPROFILE%\.masonjar`). That download is large. Leave the app open until the start screen appears.

If you already use Bell Jar, the first launch can **copy** `~/.belljar` into `~/.masonjar` so you do not download the environment again. The copy does not change Bell Jar's folder.

To run from source instead of a release: clone the repository, then `yarn install`, `yarn compile`, and `yarn start`.

## The start screen

After launch you land on the Mason Jar start screen.

| Control | What it does |
| --- | --- |
| **New project** | Start a CZI import, import existing images, or create an empty bundle. |
| **Load project file** | Open an existing `.masonjar` (or legacy `.belljar`) project file. |
| **Continue to tools** | Opens the workspace for the project that is already loaded. Hidden until a project is open. |
| **Guide** | Opens this manual. |
| **Check for updates…** | Shown when the update flow is available. Same checks as Settings → Updates. |
| **Rescan project files** | Rebuilds the file index for the open project. |
| **Credits** | Attribution, including Bell Jar. |
| **Settings** | Network, dialogs, and updates. |
| **Application log** | Opens the log window. Use it when a run looks stuck. |
| **Batch** | Runs selected steps across many projects. |
| **Recent projects** | Reopens a project you used before. |

## Projects

A Mason Jar project is a folder, not a single image. Prefer a **`.masonjar` project bundle**. Legacy Bell Jar folders still open, with limits described below.

### Bundle layout

For the name `M528`, **New project** creates:

```
LocationYouChose/
  M528_masonjar/
    M528.masonjar
    data/
      original_scans/
      counting/
        00_dapi/
        01_slices/
        03_max/
        05_predictions/
        06_quantification/
        07_pkls/
        08_dual/
```

`M528.masonjar` is the file you load later. `data/` is where tools read and write. Older bundles that use `project.masonjar` still open.

### How to create a project

On the start screen choose **New project**. Three choices:

**Import from Zeiss CZI (.czi)** — use this for new microscope data. The CZI wizard creates the bundle, extracts images, max-projects signal channels, and asks you to confirm orientation. Full steps are in **Import from Zeiss CZI**.

**Import existing** — use this when images already exist on disk.

1. **Migrate to .masonjar (new bundle)** opens the project wizard in new-bundle mode.
2. **Migrate legacy brain folder** opens the same wizard aimed at a classic `M###` folder.
3. **Legacy mode only** works in the old Bell Jar folder without creating a `.masonjar` file. Read the consent dialog before you continue. Some tools will be missing.

**Create blank project (no initial import)** — use this when you will add files yourself.

1. Enter a **Project name** (for example `M528`).
2. **Choose folder** for the location that should hold all Mason Jar projects.
3. Confirm the **Project folder** path (`…/M528_masonjar`).
4. Click **Create project**.

### Project wizard (migrate)

Use this when you already have folders of scans, DAPI, max images, or annotations and you want them inside a bundle.

1. **Location.** Enter the project name, choose the parent folder, and check the bundle path. Click **Next**.
2. **Sources.** Map each role to a source folder. For a legacy brain, scan the `M###` root first so Mason Jar can find `counting/`. Click **Next**.
3. **Review.** Check the mapping. Click **Next** to import.
4. **Import.** Wait until the copy finishes.
5. **Finish.** Open the workspace. If the bundle has no CZI orientation history, you may be offered **Orient slices** before alignment.

### Load, recents, and the workspace

1. **Load project file** and choose `M528.masonjar`, or click the project under **Recent projects**.
2. Click **Continue to tools**. The workspace title is **Pipeline**.
3. The chip under the title shows which project is open.
4. **Completed tasks** lists work Mason Jar has already recorded for this project (active runs).
5. **Alignment issues** lists sections that failed during alignment, when any exist.
6. A geometry banner appears when orientation was interrupted. Follow its link rather than guessing which files were rotated.
7. **Back to start** returns to the hub without closing the project. **Application log** opens the log from here as well.

### Processing subset

On the workspace, **Processing subset (project)** limits later tools to chosen sections.

1. Turn on **Process only a subset of sections**.
2. Check the sections that should be included.
3. Leave the box off when a tool should see every section.

**Rescan project files** rebuilds the index after you add or replace files outside a wizard. **Add files to role…** attaches files to a project role (DAPI, max, and so on). **Re-import sections from CZI…** is the same tool as **Re-import sections from CZI** under Image preprocessing.

### Legacy mode

Legacy mode is a classic Bell Jar tree (`M528/counting/00_dapi/`), not `M528_masonjar/data/counting/`. A `.masonjar` bundle will not scan correctly in legacy mode.

Fully available: Max Projection, Align Sections, Viewer/Editor, DAPI cleanup, Collate Counts, Export dual-channel ROI TIFs.

Limited (you type paths yourself; dataset pickers and slice subsets are absent): Cell Detection, Count Brain, Isolate Regions.

Unavailable: Sharpen, Top-hat, tissue edge cleanup, Orient slices, Check Orientation Consistency, Parcellation (bulk), CZI import and re-import, and Batch.

The workspace shows **Legacy workspace — limited features.** Click **View limitations** to read the list again. Migrate to a `.masonjar` bundle when you need the full pipeline.

## How information flows

Each tool reads a folder and writes the folder the next tool expects. In a bundle those folders are fixed:

| Folder | Written by | Read next by |
| --- | --- | --- |
| CZI files on disk (outside the bundle) | Your microscope export | Import from Zeiss CZI, and later Re-import |
| `data/original_scans/` | CZI extract (z-stacks) | Max Projection; also overwritten when you apply orientation or tissue cleanup |
| `data/counting/00_dapi/` | CZI extract and geometry (counterstain PNGs) | Align Sections. Tissue cleanup and DAPI cleanup edit these PNGs |
| `data/counting/00_dapi_basic/` | BaSiC shading (display copies only) | Your eyes. **Align still warps `00_dapi`, not this folder** |
| `data/counting/01_slices/` | Align Sections (annotation `.pkl` files) | Viewer/Editor, Parcellation, Count Brain, Isolate Regions |
| `data/counting/03_max/` | CZI import (signal max) and Max Projection. Sharpen, Top-hat, and BaSiC add sibling datasets here | Sharpen, Top-hat, BaSiC, Cell Detection, Isolate Regions |
| `data/counting/05_predictions/` | Cell Detection (`Predictions_*.pkl` plus optional QC) | Count Brain |
| `data/counting/06_quantification/` | Count Brain (`count_results.csv` and related tables) | Collate Counts, and the Batch collate step |
| `data/counting/07_pkls/` | Isolate Regions (ROI `.pkl`, optional `dapi_roi`) | Export dual-channel ROI TIFs |
| `data/counting/08_dual/` | Dual-channel export (`*_dual.tif`) | ImageJ or your own figure tools |

Low-resolution preview PNGs live under `_previews`. Orient and the CZI orient step show those previews, then write the same rotation or flip onto `00_dapi`, every preview, the z-stacks, and the max TIFFs for that section.

**Flat layout.** Several tools have **Write outputs directly to the output folder (legacy flat layout)**. Leave it off for a `.masonjar` bundle so each run stays in its own subfolder and the project index can tell runs apart. Turn it on only when you are matching an old Bell Jar folder that has no run subfolders.

### Recommended order

1. Create the project (CZI import, or migrate / blank).
2. Confirm orientation (part of CZI import, or **Orient slices** if you are repairing it).
3. Optional: tissue edge cleanup or DAPI cleanup on `00_dapi` **before** alignment.
4. **Align Sections** on `00_dapi`. Finish in Napari so warped annotations are written.
5. **Viewer/Editor** if labels need paint or search fixes. Optional **Parcellation (bulk)** if you want a coarser atlas tier.
6. Optional signal prep: Sharpen, Top-hat, and/or BaSiC on the max dataset you will detect.
7. **Cell Detection** on that signal dataset.
8. **Count Brain** using predictions plus annotations.
9. **Collate Counts** when you have more than one brain, or use Batch collate.
10. **Isolate Regions** if you need ROI pickles. Turn on DAPI first if you will export dual-channel TIFs.
11. **Export dual-channel ROI TIFs**.

### What you can skip

- If CZI import already wrote signal max TIFFs, do not run **Max Projection** again unless you add new z-stacks.
- Sharpen, Top-hat, and BaSiC are optional. Detection can use the plain max dataset.
- Parcellation, tissue cleanup, DAPI cleanup, and dual-channel export are optional.
- Align Sections and Viewer/Editor cannot be skipped if you need region counts. Count Brain has nothing to assign cells to without annotation `.pkl` files.
- Batch never runs Align or Viewer/Editor. Do those yourself on each brain, then batch the rest.

## Batch

### What this tool does

Batch runs the same unattended steps on many `.masonjar` projects. It checks inputs before launch, shows a status matrix, and keeps each project's recorded runs in sync.

### Why it is in Mason Jar

A study is many brains. Batch is how you apply one detection or count setup to all of them without retyping paths.

### Expected inputs

- One or more `.masonjar` project bundles. Legacy-only folders cannot be batched.
- For each selected step, the upstream folders that step needs (see the table below). Preflight marks a cell when those files are missing.
- Align Sections and Viewer/Editor are **not** in the tool list. Finish them per brain first when a later step needs annotations.

### What it writes and what uses it next

Each step writes the same folders as the single-project tool. **Collate counts** runs **once** at the end, across every project that produced counts, not once per brain.

### Before you start

Open **Batch** from the start screen. You do not need a project loaded first. Know which signal dataset (plain max, sharpened, top-hat, or BaSiC) detection should use, and set that the same way on every project or the counts will not be comparable.

### Step-by-step

1. **Setup — Projects.** Click **Add project bundle…** and choose each `Name.masonjar` or its bundle folder. Or click **Scan folder for bundles** and point at the directory that holds many `*_masonjar` folders. **Clear** removes the list.
2. **Setup — Tools.** Check the steps to run. They execute in dependency order even if you check them in another order:
   1. Apply orientation (rotate/flip)
   2. Parcellation (CCF rollup)
   3. Max projection
   4. Sharpen
   5. Top-hat filter
   6. BaSiC shading correction
   7. Cell detection
   8. Detect QC scout
   9. Isolate regions
   10. Count brain
   11. Dual-channel ROI TIFs
   12. Collate counts (whole batch)
3. **Parameters.** Expand each checked step and set the same fields you would set in that tool (radius, model, regions, and so on). Defaults match the single-project tools (for example detection confidence `0.5`, tile `640`, Somata).
4. Optional: **Save as default for future batches**.
5. Read **Preflight**. Green means the inputs for that project and step were found. Fix red cells before you start, or leave the step unchecked.
6. Click **Start batch**. The button stays disabled until the plan is valid.
7. **Run.** Watch **Project**, **Step**, and **Elapsed**. The matrix updates per cell. Python output streams in the log pane. **Cancel batch** stops the queue.
8. **Summary.** Read per-project results and the active-run snapshot. **Open Application log** if you need the full log. **Run another batch** returns to setup. **Done** returns to the start screen.

### Outputs

The same files as the matching single-project tool, inside each bundle. The summary lists which project and step succeeded. Collate writes one combined report for the whole batch, not one file per brain.

### What each batch step reads and writes

| Step | Reads | Writes | Same as |
| --- | --- | --- | --- |
| Apply orientation | Saved per-slice rotate/flip from CZI import | `00_dapi`, `_previews`, `original_scans`, `03_max` | Confirm geometry / Orient |
| Parcellation | Annotation `.pkl` in `01_slices` | Those annotations, in place | Parcellation (bulk) |
| Max projection | `original_scans/` | `03_max/` | Max Projection |
| Sharpen | A max-family dataset | A new max-family dataset | Sharpen |
| Top-hat | A max-family dataset | A new max-family dataset | Top-hat filter |
| BaSiC | A max-family dataset, plus DAPI for display copies | Corrected signal leaves; `00_dapi_basic` for display | BaSiCPy Shading Correction |
| Cell detection | Selected signal dataset | `05_predictions/` including `Predictions_*.pkl` | Cell Detection |
| Detect QC scout | Selected signal dataset | `05_predictions/…/qc_scout/` only. **No** `Predictions_*.pkl` | The QC half of Cell Detection |
| Isolate regions | Signal dataset, annotations, optional DAPI | `07_pkls/` | Isolate Regions |
| Count brain | `Predictions_*.pkl` and annotations | `06_quantification/` | Count Brain |
| Dual-channel ROI TIFs | ROI `.pkl` that contain `dapi_roi` | `08_dual/` | Export dual-channel ROI TIFs |
| Collate counts | Each project's quantification CSV | One collated report | Collate Counts, once for the batch |

### If something goes wrong

If a step fails, Mason Jar **skips downstream steps for that project only**. Other projects continue. The dependency links are: max feeds sharpen, top-hat, BaSiC, detection, isolate, and count; detection feeds count and collate; isolate feeds dual-channel export; count feeds collate. A failed QC scout does not block count. Click a failed matrix cell to read the tail of the Python log, then fix the missing input and run another batch with only the failed steps checked.

## Import from Zeiss CZI

### What this tool does

Reads Zeiss `.czi` files, assigns channels to pipeline roles, extracts z-stacks and previews, max-projects signal channels, and lets you rotate or flip each section before the files are used.

### Why it is in Mason Jar

The rest of the pipeline wants flat TIFFs and DAPI PNGs with stable slice IDs. This wizard is the supported way to get from a microscope file to that layout without renaming by hand.

### Expected inputs

- A project name and a parent folder for all Mason Jar projects.
- One or more folders of `.czi` files. Multiple folders are allowed when the same filenames appear in more than one directory; order them with the up and down controls.
- You choose which number in each filename is the slice index if automatic sorting is wrong.

### What it writes and what uses it next

Z-stacks go to `original_scans/`. Counterstain PNGs go to `00_dapi/`. Signal max TIFFs go to `03_max/`. Previews go to `_previews`. Align Sections should use `00_dapi` next. You do not need Max Projection again unless you later add z-stacks that were not extracted here.

### Before you start

Know which channel is the counterstain (DAPI or equivalent) and which channel is the primary signal for detection. Other signal channels can still be kept.

### Step-by-step

1. Start screen → **New project** → **Import from Zeiss CZI (.czi)**.
2. **Location.** Enter **Project name**. **Choose folder** for the parent directory. Check **Project folder**. Click **Next**.
3. **Scan.** **Add folder** for each CZI directory. **Re-probe all** if you change folders. Set **Slice number follows** if the sort is wrong. Read mosaic and channel warnings. Click **Next** when the file table looks right (the button stays off until a probe succeeds).
4. **Channels / Renaming.** Choose **Keep scene names** or **Rename on import** (contiguous `Project_s###` IDs). For each channel index, set a role and click **Apply to all**. Uncheck **Keep** to skip a channel. Set **Primary signal** to the channel detection should default to. If an axon channel is kept, choose 8-bit or 16-bit. Click **Next**.
5. **Extract.** Wait. **Cancel extraction** stops the job. When it finishes, click **Continue to Orient**.
6. **Orient.** The grid shows preview PNGs. Set **Display channel**. Rotate or flip tiles. **Copy first tile geometry to all** when every section needs the same correction. Click **Confirm geometry**.
7. **Finish.** Geometry is written onto DAPI PNGs, previews, z-stacks, and max TIFFs. Then choose **Start atlas alignment**, **Preprocess tools**, **Open workspace**, or **Hub**.

### Outputs

A new bundle, extracted images, a max dataset for kept signal channels, and a geometry history entry for the rotations you confirmed.

### If something goes wrong

If the probe lists the wrong slice order, change **Slice number follows** and look at the renaming table before you extract. If orientation history is missing later, the orient step tells you to set rotation manually. **Repair previews** appears when preview files and full-resolution files disagree.

## Re-import sections from CZI

### What this tool does

Pulls selected sections and channels out of the original `.czi` files again and overwrites those products in the open project.

### Why it is in Mason Jar

A section is sometimes blank, truncated, or extracted with the wrong channel. Re-import fixes those slices without starting a new project.

### Expected inputs

- An open `.masonjar` project that was imported from CZI.
- The original `.czi` files still at the paths stored in the project.
- A selection of sections, then a selection of channels that were kept on the original import.

### What it writes and what uses it next

Overwrites the chosen outputs (previews, z-stacks, max, and DAPI when that channel is included). Alignment that used the old files should be run again for those sections. Channels you do not re-read are not modified.

### Before you start

Workspace → **Re-import sections from CZI…**, or Image preprocessing → **Re-import sections from CZI**.

### Step-by-step

1. Optionally check **Show blank DAPI only**. **Select all** or **Clear all**, then pick sections. Click **Next**.
2. Choose channels. Source paths must still exist. Click **Next**.
3. Read the confirm table (section, channel, source CZI, outputs). Check **Overwrite selected files on disk**. Click **Run re-import**.
4. Review orientation for the re-imported sections if the wizard offers it, then **Confirm geometry**.

### Outputs

Replaced files for the selected section/channel pairs only.

### If something goes wrong

The run button stays disabled until overwrite is checked. If a CZI path is gone, the channel step reports it; restore the file or pick a different channel.

## Max Projection

### What this tool does

Collapses a folder of single-channel z-stacks into one plane per section by keeping the brightest pixel at each location.

### Why it is in Mason Jar

Alignment and detection want a single in-focus plane. CZI import already does this for signal channels. Use this tool when you have z-stacks from outside that import, or when you add stacks later.

### Expected inputs

- **Input Path:** a directory of z-stacked TIFF or OME-TIFF files. In a bundle that is `data/original_scans/`.
- **Output Path:** where the flat TIFFs should go. In a bundle that is `data/counting/03_max/`.
- Optional run-mode controls when a project is open (which sections, which existing run to extend).

### What it writes and what uses it next

Max TIFFs. Sharpen, Top-hat, BaSiC, Cell Detection, and Isolate Regions can all use this dataset. Align does **not** read max images; it reads `00_dapi`.

### Before you start

Image preprocessing → **Max Projection**. If the workspace banner says CZI import already max-projected signal, skip this unless the input folder has new stacks.

### Step-by-step

1. Click **Input Path** and choose the z-stack folder (cancel the dialog if you need to type the path).
2. Click **Output Path** and choose the max folder.
3. Leave **legacy flat layout** off for a bundle.
4. Click **Run**. Watch the bar at the bottom of the window.

### Outputs

One max-projected TIFF per input stack in the output folder (or in a run subfolder).

### If something goes wrong

An immediate error dialog means the input folder was empty or not a directory of stacks. The log window has the Python message.

## Sharpen

### What this tool does

Applies an unsharp mask to a max-family dataset, with an optional histogram equalization, after you preview one section.

### Why it is in Mason Jar

Max projection and extended-focus images can look soft. A light sharpen can make somata easier for the detector. It is optional.

### Expected inputs

- An open `.masonjar` project (this wizard is unavailable in legacy mode).
- A max projection dataset already in the project (**Signal branch** and **Source dataset**).
- A **Preview slice** from that dataset.

### What it writes and what uses it next

A new dataset next to the source max images. Point Cell Detection or Isolate Regions at that dataset if you want them to use the sharpened images. The original max dataset remains.

### Before you start

Image preprocessing → **Sharpen**. Start from a small radius. The batch default is radius `1`, amount `1`, equalization off.

### Step-by-step

1. Choose **Signal branch** and **Source dataset**.
2. Choose **Preview slice**.
3. Set **Unsharp radius** and **Unsharp amount**. Optionally turn on **Equalize histogram**.
4. Set **Display min** and **Display max** (0–255) so the preview is visible. These are display settings.
5. Click **Preview filter**. Optionally turn on auto-refresh after pan.
6. Click **Next — Process**.
7. Click **Run sharpen**. **Cancel** stops the run. **Back** returns to the preview.
8. On the summary, optionally set this dataset as the active max, then continue to **Cell Detection** or **Isolate Regions**.

### Outputs

Sharpened TIFFs for the selected dataset's sections.

### If something goes wrong

If the preview is blank, widen the display range before you judge the radius. If the source dataset list is empty, run Max Projection or CZI import first, then rescan.

## Top-hat filter

### What this tool does

Subtracts a smooth background from a max-family dataset (white top-hat) and can apply a gamma. You preview one section before the batch of sections runs.

### Why it is in Mason Jar

Uneven glow around cells inflates detection. Top-hat is the optional background suppression step.

### Expected inputs

- An open `.masonjar` project.
- A max-family **Source dataset** and a **Preview slice**.
- **Filter radius (px)** and **Gamma**. Batch defaults are radius `10` and gamma `1.25`.

### What it writes and what uses it next

A new max-family dataset. Detection and Isolate Regions can select it. The source dataset is kept.

### Before you start

Image preprocessing → **Top-hat filter**.

### Step-by-step

1. Choose **Signal branch**, **Source dataset**, and **Preview slice**.
2. Set **Filter radius** and **Gamma**.
3. Set display min and max. Click **Preview filter**.
4. Click **Next — Process**, then **Run top-hat**.
5. Optionally mark the result as the active max, then open Cell Detection or Isolate Regions.

### Outputs

Filtered TIFFs in a new dataset folder under the max tree.

### If something goes wrong

A huge radius eats real signal. Preview a bright and a dim section before you process the whole brain.

## BaSiCPy shading correction

### What this tool does

Estimates a flat-field (and optional dark-field) with BaSiCPy and corrects a signal dataset. It also writes corrected DAPI **display** copies.

### Why it is in Mason Jar

Illumination falloff changes with the objective and the tile. Corrected signal images are fairer for detection and for region intensity.

### Expected inputs

- An open project with a max dataset.
- **Channel**, **Signal branch**, **Source dataset**, and a **Preview slice**.
- Fit settings: **Estimate darkfield**, **Flatfield smoothness**, **Darkfield smoothness**, **Working size**, and **Sort by intensity**.

### What it writes and what uses it next

Corrected signal images under the max tree. Corrected DAPI PNGs go to `00_dapi_basic` for viewing. **Align Sections still uses uncorrected `00_dapi`.** If you want detection on the corrected signal, select that dataset in Cell Detection.

### Before you start

Image preprocessing → **BaSiCPy Shading Correction**.

### Step-by-step

1. Read the attribution step and click **Proceed**.
2. Choose channel, signal branch, source dataset, and preview slice.
3. Set smoothness and working size. Click **Preview filter**.
4. Click **Next — Process**.
5. Leave **Force refit** off to reuse a profile. Turn on **Start fresh** only when you want to ignore resume progress.
6. Click **Run shading correction**.
7. Optionally set the corrected dataset active.

### Outputs

Shading-corrected signal TIFFs, a saved flat/dark profile for resume, and display DAPI copies.

### If something goes wrong

If the preview looks blotchy, raise flat-field smoothness and preview again before processing every section.

## Semi-manual tissue edge cleanup

### What this tool does

Lets you paint a keep/remove mask on counterstain previews so neighboring-section slivers do not enter alignment. Apply then writes black into those pixels across the bundle files for each edited section.

### Why it is in Mason Jar

Automatic tissue masks fail when two sections overlap on the slide. This is the guided fix.

### Expected inputs

- An open `.masonjar` project with DAPI previews (unavailable in legacy mode).
- Your judgment on each section: green is tissue to keep, red is tissue to remove.

### What it writes and what uses it next

Until you confirm, edits are a draft. **Apply to bundle** overwrites DAPI previews, orient previews, original-scan z-stacks, and max, sharpen, and top-hat TIFFs for edited sections. Originals are copied to `.masonjar/tissue_cleanup_backup/` first. If you already ran Align, run Align again afterward.

### Before you start

Image preprocessing → **Semi-manual tissue edge cleanup**. Do this **before** alignment when you can.

### Step-by-step

1. Move with **Previous** and **Next**. The image is a fixed view (no pan or zoom).
2. **Attempt Auto** builds a mask. **Trace edge then Auto** lets you click the boundary first, then **Done tracing**.
3. **Eraser (remove)** paints red. **Keep brush (add)** paints green. Set **Brush size** and **Edge shrink**. **Undo** and **Reset** apply to the current section.
4. Click **Review masks**.
5. Read the warning and the per-section table. Click **Apply to bundle**, or **Back** to keep editing.
6. Wait on **Apply**. The summary returns you to the workspace.

### Outputs

Black-filled pixels where you painted remove, plus a backup of the previous files.

### If something goes wrong

Apply is destructive. If a section looks wrong afterward, restore from `tissue_cleanup_backup` and run the wizard again. Do not start Align while apply is still running.

## Orient slices

### What this tool does

Shows low-resolution previews so you can rotate or flip each section, then writes that geometry onto DAPI PNGs, all previews, z-stacks, and max TIFFs.

### Why it is in Mason Jar

The atlas predictor assumes a conventional facing. This tool is how you repair facing after import. It lives under **Deprecated & Experimental** because the CZI wizard already includes the same step. Use it when you need to redo geometry, not as the normal first step.

### Expected inputs

- An open project with indexed DAPI previews or CZI import settings.
- Preview PNGs named like `{sliceId}_dapi.png`.

### What it writes and what uses it next

The same files Align and detection will read. One rotation is stored **per section**, not per channel. **Check Orientation Consistency** audits whether channels disagree.

### Before you start

Image preprocessing → **Orient slices**. If the page says to open a project with DAPI previews, load the bundle first.

### Step-by-step

1. Set **Display channel**.
2. Rotate or flip tiles. Use **Copy first tile geometry to all** when the series shares one error.
3. Click **Apply geometry** and wait for the log to finish.
4. If previews are missing, use **Repair previews** or **Re-import sections from CZI…**.
5. Use **Check Orientation Consistency** when you suspect one channel was rotated and another was not.
6. **Finalize only** appears when geometry was chosen but not yet baked into every file.

### Outputs

Updated `00_dapi`, `_previews`, z-stacks, and max TIFFs, plus a geometry history record.

### If something goes wrong

If there is no saved history, signal previews can look like the raw CZI orientation. Set the rotation yourself and apply. A red geometry banner means a previous apply was interrupted; use **Rebuild geometry** rather than aligning the half-rotated brain.

## Check Orientation Consistency

### What this tool does

Audits orientation across channels for the whole section series and, only when it finds mismatches, offers a repair.

### Why it is in Mason Jar

A counterstain and a signal channel that face different directions will not overlay in Viewer/Editor or in counts.

### Expected inputs

- The open project's previews and full-resolution images for every kept channel.

### What it writes and what uses it next

Nothing, until you confirm a repair. A repair rewrites the mismatched channel files so they match the chosen orientation. Align and detection then see a consistent series.

### Before you start

Open it from **Orient slices** → **Check Orientation Consistency**.

### Step-by-step

1. **Audit** runs as soon as the page opens. Wait for the progress bar.
2. **Results** lists sections that match and sections that do not.
3. **Review** shows thumbnail pairs.
4. **Confirm** only if you want the repair applied.
5. **Repair** writes files. Return to Orient or the workspace when it finishes.

### Outputs

An audit report on screen. Files change only after you confirm a repair.

### If something goes wrong

If the audit cannot read a channel, re-import that channel from CZI, then audit again. Do not confirm a repair you have not looked at in the thumbnail step.

## DAPI cleanup

### What this tool does

Converts counterstain previews to a cleaner grayscale PNG: optional tissue isolation, a uniform background, and a contrast stretch. Optional CLAHE.

### Why it is in Mason Jar

Align's predictor is easier to place on a clean counterstain. Prefer tissue edge cleanup when the problem is a neighboring sliver. This tool is under **Deprecated & Experimental** because it rewrites the PNGs Align reads; use it when the counterstain itself is the problem.

### Expected inputs

- **Input Path:** DAPI preview PNGs, normally `data/counting/00_dapi/`.
- Output mode: **In place** (recommended) or **Separate folder**.
- Options: **Isolate tissue** (on by default), **CLAHE**, **Re-backup originals**, **Saturation clip (%)** (default 5), and optional **Background level**.

### What it writes and what uses it next

PNG files. Align and Viewer/Editor expect PNG in `00_dapi`, not TIFF. In-place mode overwrites the input and keeps a copy in `00_dapi_backup`. Separate mode writes `00_dapi_clean`; you must point Align's input at that folder yourself.

### Before you start

Image preprocessing → **DAPI cleanup**. Do it before Align, or re-run Align after.

### Step-by-step

1. Choose the input folder.
2. Leave **In place** selected unless you want a side-by-side copy.
3. Set isolate, CLAHE, saturation, and background.
4. Click **Run**.

### Outputs

Cleaned PNGs in `00_dapi` or in the separate folder you chose.

### If something goes wrong

If tissue disappears, turn **Isolate tissue** off and run again from the backup in `00_dapi_backup`. Check **Re-backup originals** only when you intentionally want a new backup of the current files.

## Align Sections

### What this tool does

Predicts which Allen atlas plane matches each section, opens Napari so you can fine-tune those predictions, and then warps the sections onto the atlas.

### Why it is in Mason Jar

Region counts and ROI exports are atlas coordinates. This is the step that creates those coordinates. It is interactive, so Batch will not do it for you.

### Expected inputs

- **Input Path:** ordered counterstain slices. In a bundle, `data/counting/00_dapi/` (PNG). Not the signal max images.
- **Output Path:** where annotations and composites should go. In a bundle, `data/counting/01_slices/`.
- **Alignment Method:** **Automatic** (per section, whole-brain or left hemisphere), **Both hemispheres (all sections)**, or **Single hemisphere (all sections)**.
- Optional **Legacy Atlas** (2014 atlas) and **Spacing** in microns (10–200).
- Uncorrected DAPI. BaSiC's `00_dapi_basic` folder is not the Align input.

### What it writes and what uses it next

Annotation `.pkl` files (Allen region ids), reference atlas slices, and composite maps. Viewer/Editor, Parcellation, Count Brain, and Isolate Regions read the `.pkl` files. Warped images are what you inspect while tuning.

### Before you start

Atlas alignment → **Align Sections**. Finish tissue cleanup and orientation first. Close other heavy tools.

### Step-by-step

1. Confirm **Input Path** and **Output Path**. A loaded project fills these in.
2. Leave **Alignment Method** on **Automatic** unless every section is the same layout.
3. Set spacing if your series is regularly spaced and you know the micron step. Otherwise leave it blank.
4. Leave legacy flat layout off for a bundle.
5. Click **Run**. Mason Jar minimizes. Switch to the **Atlas Alignment** Napari window.
6. Tune the predicted section for each slice. The Napari window locks editing once warping starts; that is intentional.
7. Click **Finish** in Napari. Mason Jar returns and shows **Warping sections to the atlas**. Do not start another tool.
8. When the finish panel appears, go to **Cell Detection**, the alignment menu, or the **Workspace**.

If you return to a brain you already tuned, the page can show **Resuming saved alignment tuning** and restore the method from that session.

### Outputs

`Annotation_<project>_s###.pkl` (and related maps) under the slices output. The workspace records the align run.

### If something goes wrong

- **Index out of range** usually means the number of images changed after the run started. Do not add, delete, or rename files until warping finishes.
- If one section takes much longer than the others, check image size. Very large counterstain images slow the warp. The DAPI PNGs in `00_dapi` are the intended input, not full-resolution z-stacks.
- Napari looks frozen during warping. Check the Mason Jar warp panel and the application log before you force-quit. A Python process still running means it has not crashed.
- After tissue cleanup or a new orientation, the old annotations do not match. Run Align again.

## Viewer/Editor

### What this tool does

Opens your images beside or under the atlas annotation so you can inspect labels and paint corrections.

### Why it is in Mason Jar

The automatic warp is a starting point. Small shifts in cortex, hippocampus, or a damaged edge are fixed here before you count.

### Expected inputs

- **Images Path:** 2D images to display (counterstain or signal). Matching is by filename stem (`M528_s027`), not by sort order.
- **Annotations Path:** the `.pkl` files from Align (`01_slices`).

### What it writes and what uses it next

Edits overwrite the annotation `.pkl` in the annotations folder. Count Brain and Isolate Regions then use the edited labels. Make a copy of the `.pkl` folder first if you want a way back. Parcellation (bulk) will revert brush edits on sections it rewrites.

### Before you start

Atlas alignment → **Viewer/Editor**, after Align has finished.

### Step-by-step

1. Set **Images Path** and **Annotations Path**.
2. Click **Run**.
3. In the viewer, move between sections, search the atlas hierarchy, and paint. Warnings you previously dismissed can be restored under Settings → Dialogs.
4. Save from the viewer before you close it. Count will not see unsaved paint.

### Outputs

Updated annotation `.pkl` files in the annotations folder.

### If something goes wrong

If a section shows the wrong image, the stems do not match (for example `s027` vs `s27`). Rename or re-import so image and annotation share a stem. If paint seems missing later, you may have run Parcellation, which restores those sections from backup.

## Parcellation (bulk)

### What this tool does

Rolls annotation borders on selected sections up to a coarser Allen hierarchy tier, for the regions you include.

### Why it is in Mason Jar

You sometimes want counts at "visual areas" rather than every layer. Doing that by hand on every section is the job this wizard replaces.

### Expected inputs

- An open project with an align run (annotation `.pkl` files in `01_slices`).
- A section selection, a **Hierarchy** tier, and a list of included regions.

### What it writes and what uses it next

Rewrites the selected annotation files in place. Count Brain then uses the coarser labels. Manual Viewer/Editor brush edits on selected sections are reverted from backup. Unchecked sections stay as they are.

### Before you start

Atlas alignment → **Parcellation (bulk)**. Unavailable in legacy mode. If you still want your paint, skip this tool or leave those sections unchecked.

### Step-by-step

1. **Sections.** Uncheck sections that must stay hand-edited. Click **Next**.
2. **Target.** Choose **Hierarchy**. Search by acronym or name. Move regions with **Add**, **Remove**, **Add all**, and **Remove all**. **Advanced — show CCFv3 raw depths** only if you need a numeric depth instead of the named tiers. Click **Next**.
3. **Review.** Read the target, the section list, and the included regions. Click **Start**.
4. Wait. **Cancel** stops the run.
5. On the summary, open **Viewer/Editor** to inspect, or return to the workspace.

### Outputs

Updated `.pkl` annotations for the selected sections.

### If something goes wrong

If the section table is empty, Align has not written `01_slices` yet. If paint disappeared, that is the revert described above; restore from the annotation backup the tool keeps, or re-paint.

## Cell Detection

### What this tool does

Finds cell bodies (or nuclei) in a flat signal image with a tiled detector, then shows QC charts and a suggested intensity cutoff.

### Why it is in Mason Jar

Counts need coordinates. The bundled models were trained for fluorescent somata and for nuclei. You can also point at your own `.pt` weights.

### Expected inputs

- **Intensity dataset:** **Signal branch** and **Dataset** (plain max, sharpened, top-hat, or BaSiC). The **Input path** should be that folder of TIFFs.
- **Output path:** `data/counting/05_predictions/` in a bundle.
- **Detection model:** **Somata** or **Nuclei**.
- Advanced (collapsed by default): **Tile size** `640`, **Confidence** `0.5`, **Area cutoff** `200`, **Eccentricity** `0.2`, **Intensity cutoff** `0` (off), optional **Custom model** path, and **Multichannel** when the TIFF is multi-channel.
- Optional **Enable additional per-slice QC plots**.

### What it writes and what uses it next

`Predictions_*.pkl` plus a QC package. Count Brain reads the prediction pickles. The summary's suggested cutoff is not applied until you choose to re-run.

### Before you start

Cell detection → **Cell Detection**. In legacy mode you must type paths; there is no dataset menu. A GPU is expected for a full series.

### Step-by-step

1. Select the signal dataset. Confirm input and output paths.
2. Choose **Somata** or **Nuclei**.
3. Open **Advanced settings** only when you need to change tile, confidence, area, eccentricity, intensity, or a custom model.
4. Click **Next — Process**. **Cancel** aborts.
5. On **Summary**, read the QC gallery. **Use suggested intensity cutoff** returns you to the form with that cutoff filled in so you can process again.
6. Click **Count Brain** when the predictions look right, or **Back to workspace**.

### Outputs

Prediction `.pkl` files and QC figures under the predictions folder.

### If something goes wrong

- Too many dim spots: re-run with a higher intensity cutoff or confidence, or use the suggested cutoff from QC.
- **Index out of range** while counting later means the number of prediction files does not match the number of annotations. Detect every section you aligned, and do not mix two datasets in one predictions folder.
- An empty dataset menu means max images are not indexed. Rescan the project or run Max Projection.
- Detect QC in Batch is a different mode: it writes `qc_scout/` and does **not** write `Predictions_*.pkl`. Do not point Count at a scout folder.

## Count Brain

### What this tool does

Assigns each detection to an atlas region by overlaying prediction coordinates on the annotation images, then writes per-region counts.

### Why it is in Mason Jar

This is the numerical result of the experiment: cells per region per section.

### Expected inputs

- **Predictions Path:** a folder of prediction `.pkl` files only (`05_predictions`, or the run subfolder the menu offers).
- **Annotations Path:** annotation `.pkl` files from Align or Viewer/Editor (`01_slices`).
- **Output Path:** `data/counting/06_quantification/`.
- When a project is open, the **predictions (project)** and **slices (project)** menus pick which recorded run to use. The processing subset, if enabled, limits sections.

### What it writes and what uses it next

Count tables, including `count_results.csv`. Collate Counts and Batch collate read those tables. They do not read the images again.

### Before you start

Cell detection → **Count Brain**, after both Detect and Align (and any Viewer/Editor edits) are done.

### Step-by-step

1. Choose the prediction run and the annotation run if the menus are visible.
2. Confirm the three paths.
3. Leave legacy flat layout off for a bundle.
4. Click **Run**.

### Outputs

Region count tables in the quantification folder.

### If something goes wrong

A mismatch error means predictions and annotations do not cover the same sections. Compare filenames. If counts look shifted, the annotation was edited after you expected, or Align used a different DAPI than the one you inspected. Re-count after you fix the `.pkl` files; you do not have to re-detect unless the coordinates themselves are wrong.

## Collate Counts

### What this tool does

Turns one brain's count table into a readable report, and (in Batch) stacks those tables across brains.

### Why it is in Mason Jar

Count Brain writes a machine-friendly table. Collate is the step that makes a sheet you can open for the paper or for QUINT-style downstream files. The single-project page describes itself as the legacy QUINT-compatible report. Batch collate is how several animals become one file.

### Expected inputs

Single project:

- **Input File:** the count objects file from Count Brain (the field tooltip says "Path to all objects file").
- **Output Path:** a folder, normally `06_quantification/` or a place outside the bundle if you are collecting many animals by hand.
- **Region Output:** **Regions with Cells Only** or **All Regions**.

Batch:

- Every selected project must already have a count CSV. Collate then runs once.

### What it writes and what uses it next

A collated table in the output folder. Nothing else in Mason Jar is required after this unless you still want ROI images.

### Before you start

Cell detection → **Collate Counts**, or include **Collate counts** in a batch after **Count brain**.

### Step-by-step

1. Choose the input file and the output folder.
2. Choose **Regions with Cells Only** or **All Regions**.
3. Click **Run**.

For many brains, prefer Batch: check Count (if still needed) and Collate, then read the single collated report from the batch summary rather than running this page once per animal.

### Outputs

A human-readable count document in the output folder.

### If something goes wrong

If the region menu stays disabled, the input file was not recognized. Point at the Count Brain output, not at a predictions folder.

## Isolate Regions

### What this tool does

Cuts the signal image (and optionally DAPI) into per-region pieces using the Align annotation, and stores each piece in a `.pkl`.

### Why it is in Mason Jar

Counts say how many cells. Isolate Regions keeps the pixels for those regions so you can measure intensity or build dual-channel figures.

### Expected inputs

- **Intensity Images Path:** a max-family dataset whose filenames share a stem with the annotations (`M528_s061.ome.tiff` pairs with `Annotation_M528_s061.pkl`).
- **Annotations Path:** `01_slices`.
- **Output Path:** `data/counting/07_pkls/`.
- Optional **Include DAPI**. Then set **DAPI / counterstain PNG folder** to `00_dapi` (or another folder of grayscale images with the same stem, `.png`, `.tif`, `.jpg`, or `*_dapi.png`).
- **Whole Slice** or **Hemisphere Only**. Whole-brain mode keeps the left half of each slice when you choose hemisphere-style export.
- On the next page: a hierarchy tier and the CCF regions to export.

### What it writes and what uses it next

ROI `.pkl` files with intensity, vertices, and region info. If DAPI matched, each file also has `dapi_roi`. **Export dual-channel ROI TIFs** requires `dapi_roi`. A slice with no matching DAPI file is still written, without `dapi_roi`; the log lists those warnings.

### Before you start

Image and atlas exports → **Isolate Regions**, after Align. Turn DAPI on now if you know you will export TIFs. You cannot add DAPI to the pickles later without running this tool again.

### Step-by-step

1. Choose the intensity dataset (signal branch and dataset menus when a project is open).
2. Confirm intensity, annotation, and output paths.
3. Check **Include DAPI** and choose the DAPI folder if you need dual-channel export.
4. Choose **Whole Slice** or **Hemisphere Only**.
5. Click **Configure outputs**.
6. On **Regions**, choose **Hierarchy**, search, and click **Add** / **Remove**. **Load visual cortex preset** fills a common set. **Include cortical layers** writes a separate pickle per layer under the parents you selected. **Advanced — show CCFv3 raw depths** is optional.
7. Click **Process**. **Cancel** stops extraction.
8. Read the summary, then **Back to tools**.

### Outputs

One `.pkl` per region per section (and per layer if you asked for layers) in `07_pkls`.

### If something goes wrong

If a banner says labels could not be resolved, the annotation ids do not match the atlas file Mason Jar expects. Re-open Viewer/Editor or re-run Align before exporting. Empty region lists mean the annotation folder is wrong.

## Export dual-channel ROI TIFs

### What this tool does

Reads Isolate Regions pickles that contain `dapi_roi` and writes a two-channel TIFF per ROI: channel 1 is DAPI, channel 2 is signal.

### Why it is in Mason Jar

The pickles are convenient for Python. ImageJ and most figure tools want a TIFF. This is that conversion.

### Expected inputs

- **ROI PKL directory:** `data/counting/07_pkls/` (or the run folder) from Isolate Regions **with DAPI enabled**.
- **Output directory:** `data/counting/08_dual/`.

### What it writes and what uses it next

`*_dual.tif` files. Mason Jar does not read them back. Open them in ImageJ.

### Before you start

Image and atlas exports → **Export dual-channel ROI TIFs**.

### Step-by-step

1. Choose the ROI folder and the output folder.
2. Leave legacy flat layout off unless you want TIFs dropped directly in the output folder with no run subfolder.
3. Click **Run**.

### Outputs

Two-channel TIFFs in the output directory.

### If something goes wrong

If the run warns that pickles lack `dapi_roi`, Isolate Regions was run without the DAPI checkbox or the DAPI filenames did not match. Re-run Isolate Regions with DAPI, then export again.

## Settings

Settings is on the start screen. It does not process images. It changes how the app behaves on this computer.

### Network

**What it does.** Limits how hard Mason Jar hits a shared drive when several jobs run, and records which network locations this computer uses.

**Why it is here.** A lab NAS will stall every user if one max-projection reads at full speed. Fair-share is the throttle.

**Expected inputs.** None from a project. Optional: a manual link speed in Mbps, and one or more mounted shares.

**Step-by-step.**

1. Settings → **Network**.
2. Leave **Enable adaptive bandwidth fair-share** on unless you are on a private disk and want full speed.
3. **Link speed:** **Auto-detect**, or **Manual (Mbps)** plus a number, then **Save link speed**.
4. Under **Server network locations**, click **Select network drives…** and add the UNC or mounted paths everyone on this machine should see. The list is stored in a shared `config.json` on that machine.

**If something goes wrong.** If jobs feel capped on a local SSD, turn fair-share off. If a drive is missing from dialogs, add it here and reopen the file dialog.

### Dialogs

**What it does.** Lists Viewer/Editor warnings you chose not to show again, and lets you bring them back.

**Why it is here.** A hidden warning is useful until the wording changes or a new person uses the computer.

**Expected inputs.** None. The list is stored in the Mason Jar home folder and applies to every project. An app update clears these suppressions so new text is visible.

**Step-by-step.** Settings → **Dialogs**. Click **Show all warnings again**, or leave the list if it says nothing is suppressed.

### Updates

**What it does.** Compares the installed version with GitHub releases. On Windows it can download and install. On macOS it offers a download of the new build.

**Why it is here.** Models and wizards change between versions. The start screen can also show **Check for updates…**.

**Expected inputs.** A network path to GitHub. Optional: **Allow pre-release versions**, and **Keep version backups**.

**Step-by-step.**

1. Settings → **Updates**. Read **Installed** and **Latest**.
2. Click **Check again** if the first check failed.
3. On Windows, **Update Now** when it appears. On macOS, **Download for macOS** or **Open release page**, then install that build yourself.
4. Turn on **Allow pre-release versions** only when you mean to test a beta. A newer stable release is still preferred.

**If something goes wrong.** **Update Now** stays disabled when no newer build was found or the download failed. Read the status line, then **Check again**. A required update shows a banner and starts downloading.

### Application log

**What it does.** Shows the running log (`masonjar.log` under `~/.masonjar`).

**Why it is here.** Progress bars hide the Python traceback. The log is where you copy an error from.

**Step-by-step.** On the start screen or the workspace, click **Application log**. Leave it open during a long run if you are unsure the job is moving.

## Troubleshooting

**The app never reaches the start screen.** The first launch is still downloading the environment into `~/.masonjar`. Give it time and disk space. If you have Bell Jar, choose the copy option instead of a fresh download.

**macOS says the app cannot be opened.** The release is not notarized. Open it once from the Finder with **Open**, or follow Apple's unsigned-app instructions.

**A tool button is missing or grey.** You are in legacy mode, or no project is loaded. Read **View limitations** on the workspace. Migrate to a `.masonjar` bundle for Sharpen, Top-hat, tissue cleanup, Orient, Parcellation, CZI, and Batch.

**Align seems frozen.** Napari locks the window on purpose while warping. Use the Mason Jar progress panel and the application log. Do not change files in `00_dapi` or the output folder until it finishes.

**Counts or detection say the index is out of range.** The number of signal images, prediction files, and annotation files disagree. Detect and align the same sections, and do not mix runs in one folder.

**Region counts look empty.** Count ran on predictions that do not overlap the annotation, or the annotation folder is not `01_slices` from the align you just finished.

**Dual-channel export is empty.** Isolate Regions did not store `dapi_roi`. Run it again with **Include DAPI** and matching filenames.

**BaSiC did not change alignment.** That is expected. Alignment keeps using `00_dapi`. Corrected DAPI in `00_dapi_basic` is for display.

**Batch skipped the rest of a brain.** An upstream step failed. Other brains keep going. Open the red cell in the matrix, fix that project, and start a batch with the remaining steps.

**Where the environment lives.** Python, models, embeddings, and logs are in `~/.masonjar`. Your images stay in the project bundle you chose. Deleting a project folder does not uninstall the app. Deleting `~/.masonjar` forces a new environment download.

## Annotations in Python

Annotation `.pkl` files are pickle files of NumPy arrays of Allen Atlas region ids. The ontology is `csv/structure_graph.json` inside the app. Mason Jar uses the ontology `id` field, not `atlas_id`.

```python
import pickle

with open("Annotation_M528_s001.pkl", "rb") as file:
    annotation = pickle.load(file)
```

ROI `.pkl` files from Isolate Regions are a different object. They hold intensity, vertices, region metadata, and `dapi_roi` when you asked for DAPI. Do not pass those files to Count Brain.

## Credits

Mason Jar is a fork of Bell Jar (MIT). Open **Credits** on the start screen for attribution and a link back to this guide.
