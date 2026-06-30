# Preview filter evidence report (Phase 1 + Phase 2)

**Date:** 2026-06-30  
**Bundle:** `Z:\Matt Jacobs\masonjar_projects\test_masonjar`  
**Slice:** `test_s001` / somata  
**Phase 1 rule:** No product code changed during evidence collection.

---

## Key finding (Phase 1c)

**Preview sharpen PNG is pixel-identical to batch sharpen on the same ROI** (mean_abs_diff = 0.00). Craters (~30% zero pixels) exist in **batch too**. The wizard overlay made the ROI look like a solid black rectangle; filter-only view of batch/preview output shows soma-sized black holes from `white_tophat` after unsharp.

---

## Phase 1d — Bell Jar batch parity

User confirmed **Bell Jar sharpen output** at `Z:\Matt Jacobs\masonjar_projects\test_masonjar\data\counting\belljar_sharp` has the **same black soma disks** as Mason Jar batch/preview.

**H8 rejected:** Bell Jar batch TIFF is not visually different from Mason raw sharpen output. The earlier Bell Jar reference screenshot was not comparable raw batch output.

---

## Hypothesis summary

| ID | Verdict |
|----|---------|
| **H1** Overlay black-on-base | **Confirmed** — separate canvas overlay collapses ROI to black |
| **H2b** Naive percentile stretch | **Rejected** (salt-and-pepper static) |
| **H4** Preview filter math wrong | **Ruled out** — preview == batch |
| **H5** Dimension mismatch | **Ruled out** |
| **H7** white_tophat soma craters | **Confirmed in batch + preview + Bell Jar** |
| **H8** Bell Jar display != raw batch TIFF | **Rejected** (Phase 1d) |

---

## Phase 1c — batch vs preview numbers

ROI: x=6183, y=2760, w=2321, h=880

| Metric | Batch ROI | Preview PNG |
|--------|----------:|------------:|
| mean | 9.5 | 9.5 |
| p95 | 23.0 | 23.0 |
| zero fraction | 0.299 | 0.299 |

Decompose (equalize full → crop):

| Stage | mean | zero_frac |
|-------|-----:|----------:|
| Unsharp only | 31.4 | low |
| + white_tophat | 9.5 | 0.30 |

---

## Phase 2 implementation (shipped v5.0.0)

Final UX (after display iteration): **native-resolution filter-only view** after Preview filter — not composited onto low-res slice PNG (avoids blur and contrast loss). Display min/max applies to filter image; pan/zoom and re-preview refine sub-regions.

| Change | File |
|--------|------|
| Filter-native preview + refine-from-filter-view | `js/preprocess_wizard.js` |
| Raw preview PNG (no stretch branch) | `py/sharpen.py`, `py/top_hat.py` |
| Tests | `scripts/test-preprocess-wizard.js`, `python/tests/test_sharpen_preview_equalize.py` |

**Status:** Closed. Released 2026-06-30 as Mason Jar v5.0.0.

## Artifacts (`scripts/out/preview-evidence/`)

- `_sharpen_preview.png`, `_tophat_preview.png`
- `sim_overlay.png`, `sim_replace_stretched.png`
- `evidence_unsharp_only.png`, `evidence_unsharp_tophat.png`, `evidence_batch_roi.png`
- `batch_sharpen/test_s001.tif`
