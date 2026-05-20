"""Tests for CZI import helpers (py/czi_common.py)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

from czi_common import (  # noqa: E402
    ROLE_DAPI,
    ROLE_OTHER,
    ROLE_SIGNAL_SOMATA,
    branch_for_channel,
    branch_for_role,
    branch_for_role_key,
    default_slice_id,
    load_import_config,
    max_output_run_dir,
    natural_sort_czi_paths,
    natural_sort_key,
    natural_sort_slice_ids,
    original_scans_path,
    parse_section_suffix,
    role_key_for_channel,
    sanitize_other_name,
    suggest_role_from_label,
)


def test_default_slice_id_single_scene() -> None:
    assert default_slice_id("M528_block1.czi", 0, 1) == "M528_block1"


def test_default_slice_id_multi_scene() -> None:
    assert default_slice_id("M528_block1.czi", 2, 3) == "M528_block1_s002"


def test_suggest_role_from_label() -> None:
    assert suggest_role_from_label("DAPI") == ROLE_DAPI
    assert suggest_role_from_label("Rabies soma") == ROLE_SIGNAL_SOMATA


def test_sanitize_other_name() -> None:
    assert sanitize_other_name(" rabies red ") == "rabies_red"
    assert sanitize_other_name("bad/name") == "badname"
    assert sanitize_other_name("") is None
    assert sanitize_other_name("!!!") is None


def test_branch_for_channel_other() -> None:
    ch = {"role": ROLE_OTHER, "other_name": "rabies_red"}
    assert branch_for_channel(ch) == "rabies_red"
    assert role_key_for_channel(ch) == "other:rabies_red"
    assert branch_for_role_key("other:rabies_red") == "rabies_red"


def test_load_import_config_strips_path(tmp_path: Path) -> None:
    cfg_file = tmp_path / "czi_import_config.json"
    cfg_file.write_text('{"czi_import": {"version": 1, "source_dir": "/x"}}', encoding="utf-8")
    loaded = load_import_config(" " + str(cfg_file) + " ")
    assert loaded.get("version") == 1


def test_branch_paths(tmp_path: Path) -> None:
    bundle = tmp_path / "Brain_masonjar"
    assert branch_for_role(ROLE_SIGNAL_SOMATA) == "somata"
    out = original_scans_path(
        bundle,
        {"role": ROLE_SIGNAL_SOMATA},
        "M528_s001",
    )
    assert out == bundle / "data/original_scans/somata/M528_s001.tif"
    other_out = original_scans_path(
        bundle,
        {"role": ROLE_OTHER, "other_name": "rabies_red"},
        "M528_s001",
    )
    assert other_out == bundle / "data/original_scans/rabies_red/M528_s001.tif"
    max_dir = max_output_run_dir(bundle, ROLE_SIGNAL_SOMATA, "run-slug")
    assert max_dir == bundle / "data/counting/03_max/somata/max/run-slug"
    other_max = max_output_run_dir(bundle, "other:rabies_red", "run-slug")
    assert other_max == bundle / "data/counting/03_max/rabies_red/max/run-slug"


def test_parse_section_suffix() -> None:
    assert parse_section_suffix("M528_s112") == 112
    assert parse_section_suffix("M528_s9") == 9
    assert parse_section_suffix("M528_s10") == 10
    assert parse_section_suffix("block210") == 210


def test_natural_sort_slice_ids() -> None:
    ids = ["M528_s100", "M528_s20", "M528_s9", "M528_s112"]
    assert natural_sort_slice_ids(ids) == ["M528_s9", "M528_s20", "M528_s100", "M528_s112"]


def test_natural_sort_czi_paths(tmp_path: Path) -> None:
    names = ["M528_s10.czi", "M528_s2.czi", "M528_s112.czi"]
    for name in names:
        (tmp_path / name).write_bytes(b"")
    sorted_paths = natural_sort_czi_paths(list(tmp_path.glob("*.czi")))
    assert [p.name for p in sorted_paths] == ["M528_s2.czi", "M528_s10.czi", "M528_s112.czi"]


def test_natural_sort_key_orders_scene_index() -> None:
    a = natural_sort_key(slice_id="block_s001", basename="a.czi", scene_index=1)
    b = natural_sort_key(slice_id="block_s001", basename="a.czi", scene_index=0)
    assert a > b
