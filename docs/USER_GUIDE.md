# Mason Jar User Guide

Mason Jar analyzes mouse brain neurohistology: import sections, preprocess, align to the Allen atlas, detect cells, and export counts or region images.

## First launch

- App data lives under `~/.masonjar` (Windows: `%USERPROFILE%\.masonjar`): embedded Python, models, embeddings, and logs.
- If you already use Bell Jar (`~/.belljar`), Mason Jar can **copy** that environment on first launch so you do not re-download ~20 GB.
- Download a release from [GitHub Releases](https://github.com/matsojr22/masonjar/releases), or build from source with `yarn install`, `yarn compile`, `yarn start`.

## Projects

Prefer a **`.masonjar` project bundle** (New project). Mason Jar creates a folder such as `Name_masonjar/` with a project file and a `data/` tree.

You can still open legacy Bell Jar folders and `.belljar` projects. Legacy mode shows a warning: some tools are limited or unavailable. Use **Migrate to a .masonjar project** when you need the full pipeline.

**Load project file** opens an existing bundle. **Continue to tools** goes to the workspace pipeline hub. **Batch** runs selected steps across multiple projects.

Optional **processing subset**: on the workspace hub, limit later steps to selected sections.

## Typical workflow

1. **New project** — import from CZI (or point at existing section images).
2. **Image preprocessing** — Max Projection, then optional Sharpen / Top-hat / BaSiC shading / tissue cleanup.
3. **Atlas alignment** — Align Sections (Napari), then Viewer/Editor to fix labels.
4. **Cell detection** — Detection → Count → Collate.
5. **Exports** — Isolate Regions and/or dual-channel ROI TIFs as needed.

Completed tasks and alignment issues appear on the workspace hub after you load a project.

## Image preprocessing

| Tool | Role |
|------|------|
| **Max Projection** | Build per-channel max projections from Z-stacks (usually first after CZI import). |
| **Sharpen** | Wizard to sharpen signal channels with preview and resume. |
| **Top-hat filter** | Background suppression wizard. |
| **BaSiCPy Shading Correction** | Correct uneven illumination per channel. Writes corrected leaves under max datasets; Align warping still uses uncorrected DAPI. |
| **Re-import sections from CZI** | Re-extract slices into the open project without starting over. |
| **Semi-manual tissue edge cleanup** | Guided mask edits for tissue boundaries. |
| **Orient / DAPI cleanup** | Deprecated / experimental; prefer the main wizards above. |

## Atlas alignment

| Tool | Role |
|------|------|
| **Align Sections** | Napari-based section-to-atlas alignment and warping. Finish confirms before writing warped outputs. |
| **Viewer/Editor** | Inspect and edit atlas annotations (hierarchy, paint, search). |
| **Parcellation (bulk)** | Bulk parcellation helpers for many sections. |

## Cell detection

| Tool | Role |
|------|------|
| **Cell Detection** | Run detection models with QC / scout options in the wizard. |
| **Count Brain** | Quantify detections by region. |
| **Collate Counts** | Combine count outputs across sections or animals. |

## Image and atlas exports

| Tool | Role |
|------|------|
| **Isolate Regions** | Export region intensity / ROI pickles (enable DAPI when you need dual-channel export next). |
| **Export dual-channel ROI TIFs** | ImageJ-friendly TIFs (channel 1 DAPI, channel 2 signal) from Isolate Regions ROI `.pkl` files that include `dapi_roi`. |

## Settings and updates

**Settings** covers network, dialogs, and update preferences. **Check for updates** (when shown) uses the app update flow. **Application log** opens the log window for troubleshooting.

## Requirements (summary)

- Large free disk space for models and projects (~20 GB+ for the environment).
- 32 GB RAM minimum (64 GB recommended).
- GPU with adequate VRAM for detection (CUDA where supported).

## Annotations in Python

Annotation `.pkl` files are pickle + numpy arrays of Allen Atlas region ids. Metadata is in `csv/structure_graph.json`. Mason Jar uses the ontology `id` field (not `atlas_id`).

```python
import pickle
import numpy as np

with open("Annotation_MyBrain_s001.pkl", "rb") as file:
    annotation = pickle.load(file)
```

## Help and credits

Open this guide from the home screen (**Guide**) or **Credits**. Mason Jar is a fork of Bell Jar (MIT); see Credits for attribution.
