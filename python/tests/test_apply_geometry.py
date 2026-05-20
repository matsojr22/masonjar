"""Tests for apply_geometry OpenCV transforms."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import tifffile as tiff

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

from apply_geometry import apply_ops_to_array, compose_ops  # noqa: E402


def test_compose_rotate_flip() -> None:
    ops = compose_ops(90, True, False)
    assert ("rotate", 90) in ops
    assert ("flip_x", True) in ops


def test_apply_ops_rot90() -> None:
    arr = np.arange(12, dtype=np.uint8).reshape(3, 4)
    out = apply_ops_to_array(arr, compose_ops(90, False, False))
    assert out.shape == (4, 3)


def test_transform_file_roundtrip(tmp_path: Path) -> None:
    from apply_geometry import transform_file

    src = np.ones((4, 6), dtype=np.uint8) * 7
    path = tmp_path / "tile.tif"
    tiff.imwrite(path, src)
    transform_file(path, compose_ops(180, False, False))
    loaded = tiff.imread(path)
    assert loaded.shape == src.shape
