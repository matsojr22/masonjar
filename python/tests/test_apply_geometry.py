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


def test_paths_for_slice_includes_dapi_png_not_tif(tmp_path: Path) -> None:
    from apply_geometry import paths_for_slice

    bundle = tmp_path / "Brain_masonjar"
    slice_id = "M528_s001"
    dapi_png = bundle / "data/counting/00_dapi" / f"{slice_id}.png"
    dapi_tif = bundle / "data/counting/00_dapi" / f"{slice_id}.tif"
    prev_png = bundle / "data/counting/_previews" / f"{slice_id}_somata.png"
    prev_tif = bundle / "data/counting/_previews" / f"{slice_id}_somata.tif"
    for p in (dapi_png, dapi_tif, prev_png, prev_tif):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
    cfg = {"channels": [{"role": "signal_somata", "keep": True}]}
    paths = paths_for_slice(bundle, slice_id, cfg)
    names = {p.name for p in paths}
    assert f"{slice_id}.png" in names
    assert f"{slice_id}.tif" not in names
    assert f"{slice_id}_somata.png" in names
    assert f"{slice_id}_somata.tif" not in names


def test_collect_geometry_jobs_skips_identity(tmp_path: Path) -> None:
    from apply_geometry import collect_geometry_jobs

    bundle = tmp_path / "Brain_masonjar"
    cfg = {"channels": []}
    geometry = {
        "A": {"rotate": 0, "flipX": False, "flipY": False},
        "B": {"rotate": 90, "flipX": False, "flipY": False},
    }
    jobs = collect_geometry_jobs(bundle, geometry, cfg)
    assert [job[0] for job in jobs] == []


def test_transform_file_roundtrip(tmp_path: Path) -> None:
    from apply_geometry import transform_file

    src = np.ones((4, 6), dtype=np.uint8) * 7
    path = tmp_path / "tile.tif"
    tiff.imwrite(path, src)
    transform_file(path, compose_ops(180, False, False))
    loaded = tiff.imread(path)
    assert loaded.shape == src.shape


def test_transform_zstack_rot90_per_plane(tmp_path: Path) -> None:
    from apply_geometry import transform_file

    z, h, w = 3, 4, 6
    stack = np.arange(z * h * w, dtype=np.uint8).reshape(z, h, w)
    path = tmp_path / "stack.tif"
    tiff.imwrite(path, stack, photometric="minisblack")
    transform_file(path, compose_ops(90, False, False))
    loaded = tiff.imread(path)
    assert loaded.shape == (z, w, h)
    for zi in range(z):
        expected = np.rot90(stack[zi], k=1)
        assert np.array_equal(loaded[zi], expected)


def test_transform_zstack_flip_x(tmp_path: Path) -> None:
    from apply_geometry import transform_file

    stack = np.arange(24, dtype=np.uint8).reshape(2, 3, 4)
    path = tmp_path / "flip.tif"
    tiff.imwrite(path, stack, photometric="minisblack")
    transform_file(path, compose_ops(0, True, False))
    loaded = tiff.imread(path)
    assert loaded.shape == stack.shape
    for zi in range(2):
        assert np.array_equal(loaded[zi], np.fliplr(stack[zi]))


def test_double_apply_rot90_changes_pixels_twice(tmp_path: Path) -> None:
    """Applying the same rotation twice stacks transforms — geometry must reset after apply."""
    import cv2

    from apply_geometry import transform_file

    arr = np.arange(12, dtype=np.uint8).reshape(3, 4)
    path = tmp_path / "slice.png"
    cv2.imwrite(str(path), arr)
    once = arr.copy()
    transform_file(path, compose_ops(90, False, False))
    after_once = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    assert not np.array_equal(after_once, once)
    transform_file(path, compose_ops(90, False, False))
    after_twice = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    assert not np.array_equal(after_twice, after_once)
    expected_twice = np.rot90(np.rot90(once, k=1), k=1)
    assert np.array_equal(after_twice, expected_twice)
