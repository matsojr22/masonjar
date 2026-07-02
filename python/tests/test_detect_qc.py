"""Tests for detection QC histogram helpers."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

from detect_qc import (
    DetectQcCollector,
    bbox_area,
    bbox_long_axis,
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
    assert bbox_long_axis([0, 0, 10, 4]) == 10.0
    assert bbox_long_axis([0, 0, 4, 10]) == 10.0


def test_collector_aggregates_run_and_slice():
    collector = DetectQcCollector()
    raw = [_Obj([0, 0, 12, 8], 0.42), _Obj([1, 1, 6, 6], 0.88)]
    final = [_Obj([0, 0, 12, 8], 0.42)]
    collector.add_slice_pass("M528_s001", raw, None, final, [0.31, 0.72])
    assert len(collector.raw_run.confidence) == 2
    assert len(collector.run.confidence) == 1
    assert collector.pre_ecc_run.eccentricity == [0.31, 0.72]
    assert "M528_s001" in collector.slices


def test_cleanup_detect_qc_artifacts(tmp_path: Path):
    (tmp_path / "detect_qc_confidence.png").write_bytes(b"png")
    (tmp_path / "detect_qc_summary.json").write_text("{}", encoding="utf-8")
    slice_dir = tmp_path / "detect_qc_slices" / "M528_s001"
    slice_dir.mkdir(parents=True)
    (slice_dir / "confidence.png").write_bytes(b"png")
    removed = cleanup_detect_qc_artifacts(tmp_path)
    assert "detect_qc_confidence.png" in removed
    assert "detect_qc_summary.json" in removed
    assert not (tmp_path / "detect_qc_slices").exists()


def test_write_run_histograms_smoke(tmp_path: Path):
    collector = DetectQcCollector()
    collector.add_slice_pass(
        "M528_s001",
        [_Obj([0, 0, 20, 10], 0.55), _Obj([2, 2, 8, 8], 0.91)],
        None,
        [_Obj([0, 0, 20, 10], 0.55)],
        [0.4, 0.85],
    )
    result = write_run_histograms(
        collector,
        tmp_path,
        {"confidence": 0.5, "area_px2": 200, "eccentricity": 0.5},
        per_slice_enabled=True,
    )
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
