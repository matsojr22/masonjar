"""Tests for detection parameterization filters and slice-parameter maps."""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

from detect_param_raw import (
    display_image_path,
    filter_records,
    min_confidence_in_spec,
    params_for_slice,
    record_passes,
)


def _box(**overrides):
    row = {
        "confidence": 0.8,
        "area_px2": 400,
        "eccentricity": 0.6,
        "intensity_p90": 120,
    }
    row.update(overrides)
    return row


def test_record_passes_matches_wizard_rules():
    defaults = (0.5, 200, 0.2, 0)
    assert record_passes(_box(), *defaults)
    assert not record_passes(_box(area_px2=200), *defaults)
    assert not record_passes(_box(eccentricity=0.2), *defaults)
    assert record_passes(_box(eccentricity=None), *defaults)
    assert record_passes(_box(intensity_p90=1), 0.5, 200, 0.2, 0)
    assert not record_passes(_box(intensity_p90=10), 0.5, 200, 0.2, 40)
    assert record_passes(_box(intensity_p90=None), 0.5, 200, 0.2, 40)
    assert record_passes(_box(confidence=0.5), *defaults)
    kept = filter_records(
        [_box(area_px2=200), _box(area_px2=201)],
        0.5,
        200,
        0.2,
        0,
    )
    assert len(kept) == 1
    assert kept[0]["area_px2"] == 201


def test_slice_param_map():
    spec = {
        "default": {
            "confidence": 0.5,
            "area": 200,
            "eccentricity": 0.2,
            "intensity_min": 0,
        },
        "slices": {
            "M528_s001": {
                "confidence": 0.2,
                "area": 100,
                "eccentricity": 0.1,
                "intensity_min": 15,
            }
        },
    }
    fallback = {
        "confidence": 0.9,
        "area": 1,
        "eccentricity": 0.9,
        "intensity_min": 1,
    }
    assert min_confidence_in_spec(spec, 0.9) == 0.2
    saved = params_for_slice(spec, "M528_s001", fallback)
    assert saved["area"] == 100
    missing = params_for_slice(spec, "M528_s999", fallback)
    assert missing["confidence"] == 0.5
    assert missing["area"] == 200


def test_display_image_path_sits_beside_cache():
    path = display_image_path(r"C:\bundle\.masonjar\detect_param_raw\somata_t640\M528_s061.json")
    assert path.name == "M528_s061_display.png"
    assert path.parent.name == "somata_t640"
