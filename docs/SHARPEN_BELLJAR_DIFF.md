# Sharpen: Bell Jar vs Mason Jar line-by-line audit

Authoritative Bell Jar reference: `belljar-main/py/sharpen.py` (`process_file`, lines 48–69).

Mason Jar (after v4.1.7 restore): `py/sharpen.py` (`sharpen_image_belljar`).

Secondary reference (modern package, not Electron): `belljar-main/python/src/belljar/pipeline/sharpen.py`.

## Step-by-step comparison

| # | Step | Bell Jar `process_file` | Mason Jar (pre-4.1.7) | Mason Jar (4.1.7+) |
|---|------|-------------------------|------------------------|---------------------|
| 1 | Load | `tiff.imread` → native dtype | `tiff.imread` then `to_uint8_grayscale` (/256 if uint16) | `tiff.imread` → native dtype |
| 2 | Equalize OFF | Skip to unsharp | Force uint8 first | Skip to unsharp (native dtype) |
| 3 | CLAHE | `clahe.apply(img)` on **native** dtype | CLAHE on uint8 after `/256` | Same as Bell Jar |
| 4 | Percentile contrast | `enhance_contrast(img)` — 5%/95% | Same math on uint8 | Same as Bell Jar |
| 5 | Tiled equalize bounds | N/A (full frame) | `_apply_equalize_with_bounds` per 4096 tile | **Removed** |
| 6 | Unsharp mask | `unsharp_mask(..., preserve_range=True)` | On uint8 only | Same as Bell Jar |
| 7 | White top-hat | `white_tophat(..., disk(15))` | Same | Same |
| 8 | Output dtype | `astype(original_dtype)` after equalize block | Always uint8 | Same as Bell Jar |
| 9 | Writer | `cv2.imwrite` | `tiff.imwrite` uint8 | `tiff.imwrite` (native dtype) |
| 10 | Preview | None | Native-res filter ROI PNG; raw uint8 (no stretch); wizard filter-only view | Wizard only (v5.0.0+) |
| 11 | Large images | `ProcessPoolExecutor(4), full RAM | Tiled uint8 + bounds hack | Tiled Bell Jar core per crop (4096 + 32 pad) |

## Identical filter parameters

- CLAHE: `clipLimit=4.0`, `tileGridSize=(8, 8)`
- `enhance_contrast`: `saturation_level=0.05` (5%/95%)
- Unsharp: user `radius`, `amount`, `preserve_range=True`
- Top-hat: `disk(15)`
- UI default: equalize checked

## Verdict

**Filter math is the same; Mason v4.1.5–4.1.6 data handling diverged.**

Regression sources:

1. Forced `/256` → uint8 before all filters (lost 16-bit dynamic range on equalize-off path).
2. Per-tile `_apply_equalize_with_bounds` (not in Bell Jar) caused patchy contrast on large slices.
3. Always uint8 output (Bell Jar restores `original_dtype`).

v4.1.7 restores `sharpen_image_belljar` matching Bell Jar Electron `process_file`, keeps Mason tiled processing, wizard preview, run manifest, and sequential batch.

If artifacts persist after parity restore, investigate preview PNG vs batch TIFF input paths and CZI import scaling.
