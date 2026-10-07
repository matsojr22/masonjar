"""Tests for post-hoc detection PKL adjustment."""

from __future__ import annotations

import json
import sys
from argparse import Namespace
from pathlib import Path

import numpy as np
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

import detect_adjust
from find_neurons import DetectionResult


def _result():
    return DetectionResult([[1, 1, 10, 8], [2, 2, 6, 6]], [0.9, 0.4], (24, 24))


def test_filter_requested_keeps_source_box_and_score():
    channels = detect_adjust.filter_requested(
        [_result()],
        [{"channel": 0, "xyxy": [1, 1, 10, 8]}],
    )
    assert channels == [([[1.0, 1.0, 10.0, 8.0]], [0.9], (24, 24))]


def test_filter_requested_rejects_invented_box():
    with pytest.raises(ValueError):
        detect_adjust.filter_requested(
            [_result()],
            [{"channel": 0, "xyxy": [9, 9, 12, 12]}],
        )


def test_apply_round_trip_and_single_backup(tmp_path: Path):
    import cv2

    image = tmp_path / "section.png"
    assert cv2.imwrite(str(image), np.zeros((24, 24), dtype=np.uint8))
    pkl = tmp_path / "Predictions_M1_s001.pkl"
    detect_adjust.save_pickle(pkl, [_result()])
    bboxes = tmp_path / "BBoxes_M1_s001.png"
    assert cv2.imwrite(str(bboxes), np.zeros((24, 24), dtype=np.uint8))
    request = {
        "image": str(image),
        "pkl": str(pkl),
        "sliceId": "M1_s001",
        "source": "pkl",
        "requested": [{"channel": 0, "xyxy": [1, 1, 10, 8]}],
        "bboxes": str(bboxes),
        "backupDir": str(tmp_path / "adjust_backup"),
        "adjustParams": str(tmp_path / "adjust_params.json"),
        "sliceParams": str(tmp_path / "detect_slice_params.json"),
        "params": {
            "confidence": 0.5,
            "area": 300,
            "eccentricity": 0.2,
            "intensity_min": 10,
        },
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    detect_adjust.run_apply(Namespace(request=str(request_path)))
    loaded = detect_adjust.load_pickle(pkl)
    assert loaded[0].boxes == [[1.0, 1.0, 10.0, 8.0]]
    assert loaded[0].scores == [0.9]
    assert loaded[0].image_dimensions == (24, 24)
    backup = tmp_path / "adjust_backup" / "Predictions_M1_s001.pkl"
    assert backup.is_file()
    original = detect_adjust.load_pickle(backup)
    assert len(original[0].boxes) == 2

    request["requested"] = [{"channel": 0, "xyxy": [9, 9, 12, 12]}]
    request_path.write_text(json.dumps(request), encoding="utf-8")
    with pytest.raises(ValueError):
        detect_adjust.run_apply(Namespace(request=str(request_path)))
    still = detect_adjust.load_pickle(pkl)
    assert still[0].boxes == [[1.0, 1.0, 10.0, 8.0]]
    assert len(detect_adjust.load_pickle(backup)[0].boxes) == 2


def test_cutoff_from_intensities_skips_thin_samples():
    thin = detect_adjust.cutoff_from_intensities([40.0] * 10)
    assert thin["loadedIntensityMin"] is None
    assert thin["loadedIntensityReason"] == "too_few_detections"
    assert thin["loadedIntensityCount"] == 10


def test_cutoff_from_intensities_finds_bimodal_split():
    rng = np.random.default_rng(3)
    values = np.clip(
        np.concatenate([rng.normal(35, 4, 80), rng.normal(120, 8, 80)]),
        0,
        255,
    ).tolist()
    found = detect_adjust.cutoff_from_intensities(values)
    assert found["loadedIntensityMin"] is not None
    assert found["loadedIntensityCount"] == 160


def test_load_pickle_reads_main_detection_result(tmp_path: Path):
    import pickle

    pkl = tmp_path / "Predictions_M1_s001.pkl"
    raw = pickle.dumps([_result()], protocol=0)
    marker = b"cfind_neurons\nDetectionResult\n"
    assert marker in raw
    pkl.write_bytes(raw.replace(marker, b"c__main__\nDetectionResult\n"))
    loaded = detect_adjust.load_pickle(pkl)
    assert list(loaded[0].boxes[0]) == [1, 1, 10, 8]
    assert list(loaded[0].scores) == [0.9, 0.4]
    assert tuple(loaded[0].image_dimensions) == (24, 24)
