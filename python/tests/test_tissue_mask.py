"""Tests for tissue_mask and tissue_cleanup."""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
import tifffile as tiff

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

from tissue_cleanup import (  # noqa: E402
    apply_keep_mask_to_array,
    auto_keep_mask,
    guided_keep_mask,
    mask_is_all_keep,
    resize_keep_mask_nearest,
)
from tissue_mask import isolate_tissue_mask, parse_stroke_points  # noqa: E402


def _synthetic_blob(size: int = 128) -> np.ndarray:
    gray = np.full((size, size), 220, dtype=np.uint8)
    cv2.circle(gray, (size // 2, size // 2), size // 3, 40, -1)
    return gray


def test_isolate_tissue_mask_finds_dark_blob() -> None:
    gray = _synthetic_blob()
    mask = isolate_tissue_mask(gray)
    assert mask.shape == gray.shape
    assert mask[gray < 100].mean() > 0.9
    assert mask[gray > 200].mean() < 0.1


def test_auto_keep_mask_uint8() -> None:
    gray = _synthetic_blob()
    keep = auto_keep_mask(gray)
    assert keep.dtype == np.uint8
    assert keep.max() == 255
    assert keep.min() == 0


def test_parse_stroke_points_dict_and_array() -> None:
    assert parse_stroke_points([{"x": 1, "y": 2}, {"x": 3, "y": 4}]) == [(1, 2), (3, 4)]
    assert parse_stroke_points([[5, 6], [7, 8]]) == [(5, 6), (7, 8)]
    assert parse_stroke_points({"points": [[0, 1]]}) == [(0, 1)]


def test_edge_shrink_reduces_mask_area() -> None:
    gray = _synthetic_blob(128)
    full = isolate_tissue_mask(gray, edge_shrink_px=0)
    shrunk = isolate_tissue_mask(gray, edge_shrink_px=3, opening_disk=4, min_object_size=64)
    assert shrunk.sum() <= full.sum()


def test_guided_keep_mask_with_stroke() -> None:
    gray = _synthetic_blob()
    stroke = [(40, 40), (80, 80), (90, 50)]
    keep = guided_keep_mask(gray, stroke)
    assert keep.shape == gray.shape
    assert not mask_is_all_keep(keep)


def test_apply_keep_mask_2d() -> None:
    arr = _synthetic_blob()
    keep = auto_keep_mask(arr)
    out = apply_keep_mask_to_array(arr, keep, bg=15.0)
    assert out.shape == arr.shape
    assert int(out[0, 0]) == 15


def test_apply_keep_mask_zstack() -> None:
    plane = _synthetic_blob(64)
    stack = np.stack([plane, plane + 5], axis=0)
    keep = auto_keep_mask(plane)
    out = apply_keep_mask_to_array(stack, keep, bg=12.0)
    assert out.shape == stack.shape
    assert int(out[0, 0, 0]) == 12


def test_resize_keep_mask_nearest() -> None:
    mask = np.zeros((10, 10), dtype=np.uint8)
    mask[2:8, 2:8] = 255
    big = resize_keep_mask_nearest(mask, (20, 30))
    assert big.shape == (20, 30)
    assert big[4, 6] == 255
    assert big[0, 0] == 0


def test_paths_for_slice_includes_sharpen_tophat(tmp_path: Path) -> None:
    from bundle_slice_paths import paths_for_slice

    bundle = tmp_path / "Brain_masonjar"
    slice_id = "M528_s001"
    sharpen = (
        bundle
        / "data/counting/03_max/somata/sharpen/M528_r3_a2"
        / f"{slice_id}.tif"
    )
    tophat = (
        bundle
        / "data/counting/03_max/somata/tophat/top10_from_max"
        / f"{slice_id}.tif"
    )
    for p in (sharpen, tophat):
        p.parent.mkdir(parents=True, exist_ok=True)
        tiff.imwrite(p, np.ones((4, 4), dtype=np.uint8))
    cfg = {"channels": [{"role": "signal_somata", "keep": True}]}
    paths = paths_for_slice(bundle, slice_id, cfg)
    rels = {str(p.relative_to(bundle)) for p in paths}
    assert "data/counting/03_max/somata/sharpen/M528_r3_a2/M528_s001.tif" in rels
    assert "data/counting/03_max/somata/tophat/top10_from_max/M528_s001.tif" in rels
