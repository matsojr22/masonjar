"""Tests for py/top_hat.py preview and filter."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

from top_hat import apply_tophat, load_grayscale_uint8, process_roi  # noqa: E402


def test_apply_tophat_uint8(tmp_path: Path):
    rng = np.random.default_rng(0)
    img = rng.integers(30, 80, (64, 64), dtype=np.uint8)
    img[20:30, 20:30] = 220
    out = apply_tophat(img, radius=5, gamma=1.25)
    assert out.dtype == np.uint8
    assert out.shape == img.shape
    assert int(out.max()) > 0


def test_process_roi_matches_full_crop(tmp_path: Path):
    img = np.random.randint(0, 255, (80, 80), dtype=np.uint8)
    roi = process_roi(img, 10, 12, 40, 40, radius=7, gamma=1.0)
    full = apply_tophat(img[12:52, 10:50], radius=7, gamma=1.0)
    assert roi.shape == full.shape


def test_load_grayscale_from_tiff(tmp_path: Path):
    import tifffile as tf

    p = tmp_path / "slice.tif"
    tf.imwrite(str(p), np.ones((32, 32), dtype=np.uint8) * 128)
    arr = load_grayscale_uint8(p)
    assert arr.shape == (32, 32)
    assert arr.dtype == np.uint8
