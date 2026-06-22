"""Tests for tissue cleanup apply (streaming TIFF I/O)."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest import mock

import numpy as np
import pytest
import tifffile as tiff

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

from tissue_cleanup import apply_masks_batch  # noqa: E402
from tiff_bundle_io import page_count, read_tiff_2d  # noqa: E402


def _write_mask(path: Path, keep_fraction: float = 0.5) -> None:
    h, w = 32, 48
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[:, : int(w * keep_fraction)] = 255
    path.parent.mkdir(parents=True, exist_ok=True)
    import cv2

    cv2.imwrite(str(path), mask)


def _build_bundle(tmp_path: Path, slice_id: str, z_planes: int = 5) -> Path:
    bundle = tmp_path / "M528_masonjar"
    dapi = bundle / "data/counting/00_dapi" / f"{slice_id}.png"
    prev = bundle / "data/counting/_previews" / f"{slice_id}_somata.png"
    zstack = bundle / "data/original_scans/somata" / f"{slice_id}.tif"
    max_tif = bundle / "data/counting/03_max/somata/max/run1" / f"{slice_id}.tif"
    mask = bundle / ".masonjar/tissue_cleanup_draft/masks" / f"{slice_id}.png"

    for p in (dapi, prev, zstack, max_tif, mask):
        p.parent.mkdir(parents=True, exist_ok=True)

    import cv2

    plane = np.linspace(40, 200, 32 * 48, dtype=np.uint8).reshape(32, 48)
    cv2.imwrite(str(dapi), plane)
    cv2.imwrite(str(prev), plane)
    _write_mask(mask)

    if z_planes == 1:
        tiff.imwrite(str(zstack), plane, photometric="minisblack")
    else:
        stack = np.stack([plane + z for z in range(z_planes)], axis=0)
        tiff.imwrite(str(zstack), stack, photometric="minisblack")

    tiff.imwrite(str(max_tif), plane + 10, photometric="minisblack")
    return bundle


def test_apply_masks_batch_zstack_plane_wise(tmp_path: Path) -> None:
    slice_id = "M528_s001"
    bundle = _build_bundle(tmp_path, slice_id, z_planes=5)
    mask_path = bundle / ".masonjar/tissue_cleanup_draft/masks" / f"{slice_id}.png"

    config = {
        "slices": {
            slice_id: {
                "mask_path": str(mask_path),
                "method": "auto",
            },
        },
        "channels": [{"role": "signal_somata", "keep": True}],
        "resume_apply": False,
    }

    imread_calls: list[str] = []

    def track_imread(path, *args, **kwargs):
        imread_calls.append(str(path))
        return tiff.TiffFile(str(path)).pages[0].asarray()

    with mock.patch.object(tiff, "imread", side_effect=track_imread):
        result = apply_masks_batch(bundle, config)

    assert result["ok"] is True
    assert result["applied_files"] == 4
    assert page_count(bundle / "data/original_scans/somata" / f"{slice_id}.tif") == 5

    zstack_path = bundle / "data/original_scans/somata" / f"{slice_id}.tif"
    with tiff.TiffFile(str(zstack_path)) as tf:
        zstack = np.asarray(tf.pages[0].asarray())
    assert zstack.shape == (32, 48)
    assert np.std(zstack[:, 24:]) < 1.0
    assert np.std(zstack[:, :24]) > 1.0
    assert zstack[0, 0] == 40

    tiff_targets = [
        p
        for p in imread_calls
        if str(p).endswith(".tif") or str(p).endswith(".tiff")
    ]
    assert tiff_targets == [], f"tiff.imread should not be used for apply targets: {tiff_targets}"


def test_apply_masks_batch_2d_max_and_png(tmp_path: Path) -> None:
    slice_id = "M528_s002"
    bundle = _build_bundle(tmp_path, slice_id, z_planes=1)
    mask_path = bundle / ".masonjar/tissue_cleanup_draft/masks" / f"{slice_id}.png"

    config = {
        "slices": {
            slice_id: {
                "mask_path": str(mask_path),
                "method": "trace_auto",
            },
        },
        "channels": [{"role": "signal_somata", "keep": True}],
        "resume_apply": False,
    }

    result = apply_masks_batch(bundle, config)
    assert result["ok"] is True
    assert result["applied_files"] == 4

    max_arr = read_tiff_2d(bundle / "data/counting/03_max/somata/max/run1" / f"{slice_id}.tif")
    assert max_arr.shape == (32, 48)


def test_apply_resume_skips_completed(tmp_path: Path) -> None:
    slice_id = "M528_s003"
    bundle = _build_bundle(tmp_path, slice_id, z_planes=3)
    mask_path = bundle / ".masonjar/tissue_cleanup_draft/masks" / f"{slice_id}.png"
    config = {
        "slices": {slice_id: {"mask_path": str(mask_path), "method": "auto"}},
        "channels": [{"role": "signal_somata", "keep": True}],
        "resume_apply": False,
    }
    first = apply_masks_batch(bundle, config)
    assert first["ok"] is True

    config["resume_apply"] = True
    second = apply_masks_batch(bundle, config)
    assert second["ok"] is True
    assert second["applied_files"] == first["applied_files"]
