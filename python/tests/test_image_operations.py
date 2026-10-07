"""Image-operation ledger: classify, append, replace, and deprecated geometry."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

import image_operations


def _bundle(tmp_path: Path) -> Path:
    root = tmp_path / "M581_masonjar"
    (root / "data" / "counting" / "00_dapi").mkdir(parents=True)
    (root / "data" / "counting" / "_previews").mkdir(parents=True)
    (root / "data" / "counting" / "03_max" / "somata" / "max" / "M581-01(1)-M581-01(114)").mkdir(
        parents=True
    )
    (root / "data" / "original_scans" / "somata").mkdir(parents=True)
    return root


def test_classify_skips_original_scans_and_names_max_leaf(tmp_path: Path):
    root = _bundle(tmp_path)
    dapi = root / "data" / "counting" / "00_dapi" / "M581_s001.png"
    preview = root / "data" / "counting" / "_previews" / "M581_s001_dapi.png"
    max_tif = (
        root
        / "data"
        / "counting"
        / "03_max"
        / "somata"
        / "max"
        / "M581-01(1)-M581-01(114)"
        / "M581_s001.tif"
    )
    scan = root / "data" / "original_scans" / "somata" / "M581_s001.tif"
    assert image_operations.classify_bundle_path(root, dapi) == "dapi"
    assert image_operations.classify_bundle_path(root, preview) == "previews"
    assert (
        image_operations.classify_bundle_path(root, max_tif)
        == "max:somata/max/M581-01(1)-M581-01(114)"
    )
    assert image_operations.classify_bundle_path(root, scan) is None
    assert image_operations.slice_id_for_path(preview, "previews") == "M581_s001"
    assert image_operations.classify_bundle_path(root, Path(r"data\counting\00_dapi\M581_s001.png")) == "dapi"


def test_append_then_replace_clears_only_replaced_targets(tmp_path: Path):
    root = _bundle(tmp_path)
    dapi = root / "data" / "counting" / "00_dapi" / "M581_s001.png"
    other = root / "data" / "counting" / "00_dapi" / "M581_s002.png"
    preview = root / "data" / "counting" / "_previews" / "M581_s001_somata.png"
    image_operations.record_append(root, [dapi, other], "tissue_cleanup", deprecated=False)
    image_operations.record_append(root, [preview], "orient", deprecated=False)
    image_operations.record_replace(root, keys=["dapi"])
    ledger = json.loads((root / ".masonjar" / "image_operations.json").read_text(encoding="utf-8"))
    assert ledger["targets"]["dapi"]["ops"] == []
    assert ledger["targets"]["previews"]["ops"][0]["op"] == "orient"
    assert ledger["targets"]["previews"]["ops"][0]["deprecated"] is False


def test_tissue_cleanup_apply_writes_non_deprecated_keys(tmp_path: Path):
    root = _bundle(tmp_path)
    result = {
        "ok": True,
        "slices": {
            "M581_s001": {
                "files_touched": [
                    "data/counting/00_dapi/M581_s001.png",
                    "data/counting/03_max/somata/max/M581-01(1)-M581-01(114)/M581_s001.tif",
                    "data/original_scans/somata/M581_s001.tif",
                ]
            }
        },
    }
    image_operations.record_tissue_cleanup(root, result)
    ledger = json.loads((root / ".masonjar" / "image_operations.json").read_text(encoding="utf-8"))
    dapi = ledger["targets"]["dapi"]["ops"][0]
    assert dapi["op"] == "tissue_cleanup"
    assert dapi["deprecated"] is False
    assert dapi["slices"] == 1
    max_key = "max:somata/max/M581-01(1)-M581-01(114)"
    assert ledger["targets"][max_key]["ops"][0]["deprecated"] is False
    assert all("original_scans" not in key for key in ledger["targets"])


def test_dapi_inplace_is_deprecated_and_separate_output_is_not(tmp_path: Path):
    root = _bundle(tmp_path)
    dapi_dir = root / "data" / "counting" / "00_dapi"
    png = dapi_dir / "M581_s001.png"
    image_operations.record_dapi_inplace(dapi_dir, [png])
    ledger = json.loads((root / ".masonjar" / "image_operations.json").read_text(encoding="utf-8"))
    op = ledger["targets"]["dapi"]["ops"][0]
    assert op["op"] == "dapi_cleanup"
    assert op["deprecated"] is True
    separate = tmp_path / "elsewhere"
    separate.mkdir()
    before = (root / ".masonjar" / "image_operations.json").read_text(encoding="utf-8")
    image_operations.record_dapi_inplace(separate, [separate / "x.png"])
    assert (root / ".masonjar" / "image_operations.json").read_text(encoding="utf-8") == before


def test_geometry_source_orient_is_deprecated_and_wizard_or_repair_is_not(tmp_path: Path):
    root = _bundle(tmp_path)
    dapi = root / "data" / "counting" / "00_dapi" / "M581_s001.png"
    assert image_operations.geometry_is_deprecated("orient") is True
    assert image_operations.geometry_is_deprecated("czi_wizard") is False
    assert image_operations.geometry_is_deprecated("repair") is False
    assert image_operations.geometry_is_deprecated("batch") is False
    image_operations.record_geometry(root, [dapi], "czi_wizard")
    image_operations.record_geometry(root, [dapi], "orient")
    ops = json.loads((root / ".masonjar" / "image_operations.json").read_text(encoding="utf-8"))[
        "targets"
    ]["dapi"]["ops"]
    assert ops[0]["deprecated"] is False
    assert ops[1]["deprecated"] is True
    assert ops[0]["op"] == "orient"


def test_reextract_replace_keys_cover_dapi_previews_and_refreshed_max():
    keys = image_operations.reextract_replace_keys(
        {"dapi": ["M581_s001"], "signal_somata": ["M581_s001"]},
        ["somata/max/M581-01(1)-M581-01(114)"],
    )
    assert keys == [
        "dapi",
        "previews",
        "max:somata/max/M581-01(1)-M581-01(114)",
    ]
    signal_only = image_operations.reextract_replace_keys(
        {"signal_somata": ["M581_s001"]},
        ["somata/max/run"],
    )
    assert "dapi" not in signal_only
    assert "previews" in signal_only
