"""Tests for detection QC histogram helpers."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

from detect_qc import (
    DetectQcCollector,
    LEGACY_RUN_QC_FILES,
    RUN_QC_FILES,
    bbox_area,
    bbox_intensity_p90,
    bbox_intensity_peak,
    build_summary_payload,
    cleanup_detect_qc_artifacts,
    write_run_histograms,
)


class _Score:
    def __init__(self, value: float):
        self.value = value


class _BBox:
    def __init__(self, xyxy):
        self._xyxy = xyxy

    def to_xyxy(self):
        return self._xyxy


class _Obj:
    def __init__(self, xyxy, score: float):
        self.bbox = _BBox(xyxy)
        self.score = _Score(score)


def test_bbox_metrics():
    assert bbox_area([0, 0, 10, 4]) == 40.0


def test_bbox_intensity_on_synthetic_patch():
    gray = np.zeros((100, 100), dtype=np.uint8)
    gray[20:40, 20:40] = 200
    assert bbox_intensity_p90([20, 20, 40, 40], gray) == 200.0
    assert bbox_intensity_peak([20, 20, 40, 40], gray) == 200.0
    assert bbox_intensity_p90([0, 0, 0, 0], gray) is None


def test_collector_aggregates_run_and_slice():
    gray = np.full((64, 64), 128, dtype=np.uint8)
    gray[10:30, 10:30] = 220
    collector = DetectQcCollector()
    raw = [_Obj([0, 0, 12, 8], 0.42), _Obj([10, 10, 30, 30], 0.88)]
    final = [_Obj([10, 10, 30, 30], 0.88)]
    collector.add_slice_pass(
        "M528_s001",
        raw,
        final,
        [0.31, 0.72],
        [(0.31, 180.0), (0.72, 210.0)],
        gray,
    )
    assert len(collector.raw_run.confidence) == 2
    assert len(collector.run.confidence) == 1
    assert collector.pre_ecc_run.eccentricity == [0.31, 0.72]
    assert collector.pre_ecc_records == [(0.31, 180.0), (0.72, 210.0)]
    assert collector.raw_run.intensity[1] == 220.0
    assert "M528_s001" in collector.slices


def test_cleanup_detect_qc_artifacts(tmp_path: Path):
    (tmp_path / "detect_qc_confidence.png").write_bytes(b"png")
    (tmp_path / LEGACY_RUN_QC_FILES[0]).write_bytes(b"png")
    (tmp_path / "detect_qc_summary.json").write_text("{}", encoding="utf-8")
    slice_dir = tmp_path / "detect_qc_slices" / "M528_s001"
    slice_dir.mkdir(parents=True)
    (slice_dir / "confidence.png").write_bytes(b"png")
    removed = cleanup_detect_qc_artifacts(tmp_path)
    assert "detect_qc_confidence.png" in removed
    assert LEGACY_RUN_QC_FILES[0] in removed
    assert "detect_qc_summary.json" in removed
    assert not (tmp_path / "detect_qc_slices").exists()


def test_write_run_histograms_smoke(tmp_path: Path):
    gray = np.full((80, 80), 100, dtype=np.uint8)
    gray[0:20, 0:20] = 240
    gray[2:8, 2:8] = 50
    collector = DetectQcCollector()
    collector.add_slice_pass(
        "M528_s001",
        [_Obj([0, 0, 20, 10], 0.55), _Obj([2, 2, 8, 8], 0.91)],
        [_Obj([0, 0, 20, 10], 0.55)],
        [0.4, 0.85],
        [(0.4, 200.0), (0.85, 80.0)],
        gray,
    )
    result = write_run_histograms(
        collector,
        tmp_path,
        {"confidence": 0.5, "area_px2": 200, "eccentricity": 0.5},
        per_slice_enabled=True,
    )
    assert RUN_QC_FILES[1] == "detect_qc_area_px2.png"
    for rel in result["run_files"]:
        path = tmp_path / rel
        assert path.is_file()
        assert path.stat().st_size > 0
    assert (tmp_path / "detect_qc_summary.json").is_file()
    assert "M528_s001" in result["slice_files"]
    summary = build_summary_payload(
        collector,
        {"confidence": 0.5, "area_px2": 200, "eccentricity": 0.5},
        per_slice_enabled=True,
        run_files=result["run_files"],
        slice_files=result["slice_files"],
    )
    assert summary["run"]["final"]["confidence"]["count"] == 1
    assert summary["run"]["raw"]["intensity_p90"]["count"] == 2
    assert summary["run"]["final"]["intensity_peak"]["count"] == 1
