"""Viewer/Editor low-res channel discovery (DAPI + _previews)."""

from __future__ import annotations

import sys
from pathlib import Path

py_dir = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(py_dir))

from adjust_channels import (  # noqa: E402
    lowres_channels_for_slice,
    resolve_previews_dir,
)


def test_resolve_previews_dir_sibling_of_dapi(tmp_path: Path) -> None:
    counting = tmp_path / "data" / "counting"
    dapi = counting / "00_dapi"
    previews = counting / "_previews"
    dapi.mkdir(parents=True)
    previews.mkdir()
    assert resolve_previews_dir(dapi) == previews


def test_resolve_previews_dir_missing_returns_none(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    assert resolve_previews_dir(dapi) is None


def test_lowres_channels_dapi_only(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    dapi.mkdir()
    (dapi / "M528_s061.tif").write_bytes(b"dapi")
    channels = lowres_channels_for_slice(dapi, "M528_s061")
    assert len(channels) == 1
    assert channels[0][0] == "DAPI"
    assert channels[0][1].name == "M528_s061.tif"


def test_lowres_channels_dapi_and_previews_ordered(tmp_path: Path) -> None:
    counting = tmp_path / "counting"
    dapi = counting / "00_dapi"
    previews = counting / "_previews"
    dapi.mkdir(parents=True)
    previews.mkdir()
    (dapi / "M528_s061.tiff").write_bytes(b"dapi")
    (previews / "M528_s061_somata.tif").write_bytes(b"p1")
    (previews / "M528_s061_rabies_red.tif").write_bytes(b"p2")
    (previews / "M528_s061_axons.tif").write_bytes(b"p3")
    (previews / "other_slice_somata.tif").write_bytes(b"skip")

    channels = lowres_channels_for_slice(dapi, "M528_s061")
    names = [name for name, _ in channels]
    assert names == ["DAPI", "Axons", "Rabies Red", "Somata"]


def test_lowres_channels_explicit_previews_dir(tmp_path: Path) -> None:
    dapi = tmp_path / "00_dapi"
    custom = tmp_path / "custom_previews"
    dapi.mkdir()
    custom.mkdir()
    (dapi / "M528_s027.tif").write_bytes(b"dapi")
    (custom / "M528_s027_nuclei.tif").write_bytes(b"p")

    channels = lowres_channels_for_slice(dapi, "M528_s027", previews_dir=custom)
    assert [n for n, _ in channels] == ["DAPI", "Nuclei"]
