"""Tests for geometry_orientation_match."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

from geometry_orientation_match import (  # noqa: E402
    best_orientation_structural,
    mask_iou,
    ops_list_to_variant,
    tissue_mask,
    variant_to_extra_ops,
)


def test_mask_iou_identical() -> None:
    m = np.zeros((20, 30), dtype=bool)
    m[5:15, 8:22] = True
    assert mask_iou(m, m) == pytest.approx(1.0)


def test_ops_list_roundtrip() -> None:
    assert ops_list_to_variant(["rot90", "flipX"]) == "rot90_flipX"
    assert variant_to_extra_ops("rot90") == ["rot90"]


def test_cross_channel_structural_same_shape_different_intensity() -> None:
    """Shared tissue mask; intensity differs (DAPI-like vs somata-like)."""
    h, w = 40, 50
    yy, xx = np.ogrid[:h, :w]
    mask_shape = ((yy - 20) ** 2 + (xx - 25) ** 2) < 180
    dapi = np.where(mask_shape, 220, 10).astype(np.uint8)
    somata = np.where(mask_shape, 80, 5).astype(np.uint8)
    ref_mask = tissue_mask(dapi)
    variant, score, margin = best_orientation_structural(somata, ref_mask)
    assert variant == "identity"
    assert score > 0.5
    assert margin >= 0.0
