"""Tests for py/sharpen.py batch run (sequential, no ProcessPoolExecutor)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import tifffile

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

pytest.importorskip("cv2")

import sharpen  # noqa: E402


def _batch_args(input_dir: Path, output_dir: Path, **overrides) -> argparse.Namespace:
    defaults = {
        "config": "",
        "input": str(input_dir),
        "output": str(output_dir),
        "radius": "3",
        "amount": "2",
        "equalize": False,
        "slice_list": "",
        "preview": False,
        "image": "",
        "x": "0",
        "y": "0",
        "w": "512",
        "h": "512",
        "preview_dir": "",
    }
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def _write_uint8_tiff(path: Path, shape: tuple[int, int] = (32, 32)) -> None:
    img = np.random.randint(20, 200, shape, dtype=np.uint8)
    tifffile.imwrite(str(path), img)


def test_sharpen_image_uses_tiled_for_large_arrays(monkeypatch) -> None:
    monkeypatch.setattr(sharpen, "TILED_SHARPEN_PIXEL_THRESHOLD", 1000)
    monkeypatch.setattr(sharpen, "TILED_SHARPEN_TILE", 64)
    monkeypatch.setattr(sharpen, "TILED_SHARPEN_PAD", 8)
    img = np.random.randint(10, 200, (48, 48), dtype=np.uint8)
    out = sharpen.sharpen_image(img, radius=2.0, amount=1.5, equalize=False)
    assert out.shape == img.shape
    assert out.dtype == img.dtype


def test_batch_writes_two_files(tmp_path: Path) -> None:
    in_dir = tmp_path / "in"
    out_dir = tmp_path / "out"
    in_dir.mkdir()
    _write_uint8_tiff(in_dir / "s001.tif")
    _write_uint8_tiff(in_dir / "s002.tif")

    rc = sharpen.run_batch(_batch_args(in_dir, out_dir))
    assert rc == 0
    assert (out_dir / "s001.tif").is_file()
    assert (out_dir / "s002.tif").is_file()
    manifest = json.loads((out_dir / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["step"] == "sharpen"
    assert set(manifest["input_files"]) == {"s001.tif", "s002.tif"}


def test_batch_empty_input_dir_exits_one(tmp_path: Path) -> None:
    in_dir = tmp_path / "in"
    out_dir = tmp_path / "out"
    in_dir.mkdir()

    rc = sharpen.run_batch(_batch_args(in_dir, out_dir))
    assert rc == 1
    assert not (out_dir / "run_manifest.json").exists()


def test_batch_partial_success_when_one_file_unreadable(tmp_path: Path, capsys) -> None:
    in_dir = tmp_path / "in"
    out_dir = tmp_path / "out"
    in_dir.mkdir()
    _write_uint8_tiff(in_dir / "good.tif")
    (in_dir / "bad.tif").write_bytes(b"not a tiff")

    rc = sharpen.run_batch(_batch_args(in_dir, out_dir))
    assert rc == 0
    assert (out_dir / "good.tif").is_file()
    assert not (out_dir / "bad.tif").exists()
    captured = capsys.readouterr()
    assert "LOG: Failed bad.tif" in captured.out
    manifest = json.loads((out_dir / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["input_files"] == ["good.tif"]


def test_batch_all_fail_exits_one(tmp_path: Path, capsys) -> None:
    in_dir = tmp_path / "in"
    out_dir = tmp_path / "out"
    in_dir.mkdir()
    (in_dir / "bad1.tif").write_bytes(b"x")
    (in_dir / "bad2.tif").write_bytes(b"y")

    rc = sharpen.run_batch(_batch_args(in_dir, out_dir))
    assert rc == 1
    assert not (out_dir / "run_manifest.json").exists()
    captured = capsys.readouterr()
    assert "SHARPEN_NO_OUTPUT: 0 of 2 files written." in captured.out
