"""Tests for align session persistence (DAPI directory backup/resume)."""

from __future__ import annotations

import json
import pickle
import shutil
import sys
from pathlib import Path

import numpy as np

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

from align_session import (  # noqa: E402
    SESSION_JSON_NAME,
    apply_slice_tuning_from_controls,
    compute_fingerprint,
    compute_tuning_fingerprint,
    diagnose_load_failure,
    load_session,
    mark_session_completed,
    persist_session,
    session_paths,
)


class _FakeSlice:
    """Minimal stand-in for AtlasSlice in map.py."""

    eraser_window = None
    image = np.zeros((4, 4), dtype=np.uint8)
    label = np.zeros((4, 4), dtype=np.uint32)

    def __init__(
        self,
        section_name: str,
        ap: int = 100,
        x: float = 0.0,
        y: float = 0.0,
    ) -> None:
        self.section_name = section_name
        self.ap_position = ap
        self.x_angle = x
        self.y_angle = y
        self.region = "A"
        self.hemisphere = "W"
        self.linked = True
        self.layout_confidence = 0.9
        self.layout_low_confidence = False
        self.layout_overridden = False
        self.damage_mask = None
        self.mask = None
        self.use_tissue_cleanup_mask = False
        self.tissue_mask_warp_mode = "hybrid"
        self.keep_mask_source = None

    def slice_id(self) -> str:
        return Path(self.section_name).stem


def _tuning_fp(
    files: list[str],
    layout: str = "auto",
    legacy: bool = False,
    slice_filter: set[str] | None = None,
) -> str:
    return compute_tuning_fingerprint(files, layout, legacy, slice_filter)


def test_persist_and_load_round_trip(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    out = tmp_path / "01_slices" / "align" / "run1"
    files = ["M458_s001.png", "M458_s002.png"]
    fp = _tuning_fp(files)
    slices = {
        files[0]: _FakeSlice(files[0], ap=120, x=1.5),
        files[1]: _FakeSlice(files[1], ap=130, x=-0.5),
    }
    slices[files[0]].damage_mask = np.zeros((4, 4), dtype=np.uint8)

    persist_session(
        dapi,
        slices,
        tuning_fingerprint=fp,
        output_path=out,
        current_section=1,
        visited=1,
        parcellation={"ccf_advanced": False, "st_level": None, "tier_id": "full"},
        reason="next_section",
    )

    paths = session_paths(dapi)
    assert paths["pkl"].is_file()
    assert paths["json"].is_file()

    loaded = load_session(dapi, fp)
    assert loaded is not None
    assert loaded.source == "pkl"
    assert loaded.restore_navigation is True
    assert loaded.session is not None
    assert loaded.session["current_section"] == 1
    assert loaded.session["visited"] == 1
    assert loaded.session["tuning_fingerprint"] == fp
    assert loaded.session["output_path"] == str(out.resolve())
    assert files[0] in loaded.atlas_slices
    assert loaded.atlas_slices[files[0]].ap_position == 120
    assert loaded.atlas_slices[files[0]].damage_mask is not None

    persist_session(
        dapi,
        slices,
        tuning_fingerprint=fp,
        output_path=out,
        current_section=1,
        visited=1,
        parcellation={"ccf_advanced": False, "st_level": None, "tier_id": "full"},
        reason="next_section",
    )
    assert paths["bak"].is_file()


def test_different_output_path_still_loads(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    out_a = tmp_path / "01_slices" / "align" / "run_a"
    out_b = tmp_path / "01_slices" / "align" / "run_b"
    files = ["A.png"]
    tuning = _tuning_fp(files)

    persist_session(
        dapi,
        {files[0]: _FakeSlice(files[0], ap=42)},
        tuning_fingerprint=tuning,
        output_path=out_a,
        current_section=0,
        visited=0,
        parcellation={},
        reason="test",
    )

    loaded = load_session(dapi, tuning)
    assert loaded is not None
    assert loaded.atlas_slices[files[0]].ap_position == 42

    old_full_fp = compute_fingerprint(files, out_b, "auto", False, None)
    assert old_full_fp != compute_fingerprint(files, out_a, "auto", False, None)
    assert load_session(dapi, tuning) is not None


def test_tuning_fingerprint_mismatch_returns_none(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    out = tmp_path / "out"
    files_a = ["A.png"]
    files_b = ["A.png", "B.png"]
    fp_a = _tuning_fp(files_a)

    persist_session(
        dapi,
        {files_a[0]: _FakeSlice(files_a[0])},
        tuning_fingerprint=fp_a,
        output_path=out,
        current_section=0,
        visited=0,
        parcellation={},
        reason="test",
    )

    fp_b = _tuning_fp(files_b)
    assert load_session(dapi, fp_b) is None
    detail = diagnose_load_failure(dapi, fp_b)
    assert detail.startswith("fingerprint_mismatch")


def test_corrupt_pkl_falls_back_to_bak(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    out = tmp_path / "out"
    files = ["A.png"]
    fp = _tuning_fp(files)
    slices = {files[0]: _FakeSlice(files[0], ap=55)}

    persist_session(
        dapi,
        slices,
        tuning_fingerprint=fp,
        output_path=out,
        current_section=0,
        visited=0,
        parcellation={},
        reason="first",
    )
    paths = session_paths(dapi)
    shutil.copy2(paths["pkl"], paths["bak"])
    paths["pkl"].write_bytes(b"not-a-pickle")

    loaded = load_session(dapi, fp)
    assert loaded is not None
    assert loaded.source == "bak"
    assert loaded.atlas_slices[files[0]].ap_position == 55


def test_completed_session_skips_navigation_restore(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    out = tmp_path / "out"
    files = ["A.png"]
    fp = _tuning_fp(files)

    persist_session(
        dapi,
        {files[0]: _FakeSlice(files[0])},
        tuning_fingerprint=fp,
        output_path=out,
        current_section=3,
        visited=3,
        parcellation={},
        reason="finish",
    )
    mark_session_completed(dapi, fp)

    loaded = load_session(dapi, fp)
    assert loaded is not None
    assert loaded.restore_navigation is False


def test_legacy_pkl_without_session_json(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    files = ["A.png"]
    fp = _tuning_fp(files)
    payload = {files[0]: _FakeSlice(files[0], ap=77)}
    with open(dapi / "alignment.pkl", "wb") as handle:
        pickle.dump(payload, handle)

    loaded = load_session(dapi, fp)
    assert loaded is not None
    assert loaded.session is None
    assert loaded.restore_navigation is False
    assert loaded.atlas_slices[files[0]].ap_position == 77


def test_legacy_fingerprint_only_json_still_loads(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    files = ["A.png"]
    tuning = _tuning_fp(files)
    payload = {files[0]: _FakeSlice(files[0], ap=88)}
    with open(dapi / "alignment.pkl", "wb") as handle:
        pickle.dump(payload, handle)

    session_doc = {
        "version": 1,
        "fingerprint": tuning,
        "current_section": 0,
        "visited": 0,
        "status": "in_progress",
    }
    with open(dapi / SESSION_JSON_NAME, "w", encoding="utf-8") as handle:
        json.dump(session_doc, handle)

    loaded = load_session(dapi, tuning)
    assert loaded is not None
    assert loaded.restore_navigation is True
    assert loaded.atlas_slices[files[0]].ap_position == 88


def test_edit_flush_updates_session_without_navigation(tmp_path: Path) -> None:
    """Simulate immediate edit save (no Next click)."""
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    out = tmp_path / "out"
    files = ["A.png"]
    fp = _tuning_fp(files)
    slices = {files[0]: _FakeSlice(files[0], ap=100)}

    persist_session(
        dapi,
        slices,
        tuning_fingerprint=fp,
        output_path=out,
        current_section=0,
        visited=0,
        parcellation={},
        reason="predict_complete",
    )

    slices[files[0]].ap_position = 250
    persist_session(
        dapi,
        slices,
        tuning_fingerprint=fp,
        output_path=out,
        current_section=0,
        visited=0,
        parcellation={},
        reason="edit",
    )

    paths = session_paths(dapi)
    with open(paths["json"], encoding="utf-8") as handle:
        session = json.load(handle)
    assert session["reason"] == "edit"
    assert session["current_section"] == 0

    loaded = load_session(dapi, fp)
    assert loaded is not None
    assert loaded.atlas_slices[files[0]].ap_position == 250


def test_apply_slice_tuning_from_controls() -> None:
    """Spinbox values can be committed without waiting for debounce timers."""
    sl = _FakeSlice("A.png", ap=100, x=0.0, y=0.0)
    apply_slice_tuning_from_controls(
        sl,
        x_angle=2.5,
        y_angle=-1.25,
        ap_position=180,
        region="P",
        hemisphere="L",
        linked=False,
        use_tissue_cleanup_mask=True,
        tissue_mask_warp_mode="hybrid",
    )
    assert sl.x_angle == 2.5
    assert sl.y_angle == -1.25
    assert sl.ap_position == 180
    assert sl.region == "P"
    assert sl.hemisphere == "L"
    assert sl.linked is False
    assert sl.use_tissue_cleanup_mask is True
    assert sl.tissue_mask_warp_mode == "hybrid"


def test_session_json_name_constant() -> None:
    assert SESSION_JSON_NAME == "alignment_session.json"
