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
    assess_mosaic_import,
    bbox_width_height,
    branch_for_channel,
    branch_for_role,
    branch_for_role_key,
    collapse_to_plane_2d,
    collapse_z_stack_to_2d,
    default_slice_id,
    load_import_config,
    max_output_run_dir,
    m_tile_count_from_czi,
    natural_sort_czi_paths,
    natural_sort_key,
    natural_sort_slice_ids,
    original_scans_path,
    parse_section_suffix,
    read_czi_plane,
    role_key_for_channel,
    sanitize_other_name,
    select_largest_plane,
    suggest_role_from_label,
    unpack_read_image,
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


def test_unpack_read_image_tuple() -> None:
    import numpy as np

    arr = np.zeros((1, 10, 20), dtype=np.uint16)
    data, dims = unpack_read_image((arr, [("Z", 1), ("Y", 10), ("X", 20)]))
    assert data is arr
    assert dims == [("Z", 1), ("Y", 10), ("X", 20)]


def test_unpack_read_image_never_asarray_tuple() -> None:
    import numpy as np

    arr = np.zeros((10, 20), dtype=np.uint16)
    result = (arr, [("Y", 10), ("X", 20)])
    with pytest.raises(ValueError):
        np.asarray(result)
    data, dims = unpack_read_image(result)
    assert data.shape == (10, 20)
    assert dims == [("Y", 10), ("X", 20)]


def test_collapse_to_plane_2d_fixed_dims() -> None:
    import numpy as np

    arr = np.arange(200, dtype=np.uint16).reshape(1, 10, 20)
    plane = collapse_to_plane_2d(arr, [("Z", 1), ("Y", 10), ("X", 20)], fixed={"Z", "S", "C"})
    assert plane.shape == (10, 20)


def test_select_largest_plane_pyramid_stack() -> None:
    import numpy as np

    small = np.zeros((50, 50), dtype=np.uint16)
    large = np.zeros((100, 100), dtype=np.uint16)
    stack = np.array([small, large], dtype=object)
    plane, picked = select_largest_plane(stack)
    assert plane.shape == (100, 100)
    assert picked is True


def test_read_czi_plane_non_mosaic() -> None:
    import numpy as np

    class FakeCzi:
        def is_mosaic(self):
            return False

        def read_image(self, **kwargs):
            arr = np.ones((1, 8, 16), dtype=np.uint16)
            return arr, [("Z", 1), ("Y", 8), ("X", 16)]

    plane = read_czi_plane(FakeCzi(), scene=0, z=0, channel=0)
    assert plane.shape == (8, 16)
    assert plane.dtype == np.uint16


def test_bbox_width_height_object() -> None:
    class BBox:
        w = 1200
        h = 800

    assert bbox_width_height(BBox()) == (1200, 800)
    assert bbox_width_height((0, 0, 640, 480)) == (640, 480)


def test_m_tile_count_from_czi() -> None:
    class FakeCzi:
        def get_dims_shape(self):
            return [{"M": (0, 4), "Z": (0, 1), "C": (0, 2)}]

    assert m_tile_count_from_czi(FakeCzi()) == 4


def test_collapse_z_stack_to_2d_single_plane() -> None:
    import numpy as np

    stack = np.arange(12, dtype=np.uint16).reshape(1, 3, 4)
    plane = collapse_z_stack_to_2d(stack)
    assert plane.shape == (3, 4)
    assert np.array_equal(plane, stack[0])

    already_2d = np.zeros((5, 6), dtype=np.uint8)
    assert collapse_z_stack_to_2d(already_2d) is already_2d


def test_assess_mosaic_import_m_tiles_informational_only() -> None:
    class FakeCzi:
        def is_mosaic(self):
            return True

        def get_dims_shape(self):
            return [{"M": (0, 3), "Z": (0, 1), "C": (0, 1), "S": (0, 1)}]

    info = assess_mosaic_import(FakeCzi(), sample_read=False)
    assert info["likely_unstitched"] is False
    assert info["m_tile_count"] == 3
    assert info["mosaic_stitch_status"] == "unknown"
    assert any("tile index" in w.lower() for w in info["mosaic_warnings"])
    assert not any("stitch in ZEN" in w for w in info["mosaic_warnings"])


def test_assess_mosaic_import_bbox_mismatch() -> None:
    import numpy as np

    class BBox:
        w = 2000
        h = 1500

    class FakeCzi:
        def is_mosaic(self):
            return True

        def get_dims_shape(self):
            return [{"M": (0, 2), "Z": (0, 1), "C": (0, 1), "S": (0, 1)}]

        def read_mosaic(self, **kwargs):
            plane = np.zeros((500, 600), dtype=np.uint16)
            return plane, [("Y", 500), ("X", 600)]

        def get_mosaic_scene_bounding_box(self, index=0):
            return BBox()

        def get_all_mosaic_tile_bounding_boxes(self, **kwargs):
            class TileBBox:
                pass

            t0, t1 = TileBBox(), TileBBox()
            t0.w, t0.h = 600, 500
            t1.w, t1.h = 600, 500
            return {0: t0, 1: t1}

    info = assess_mosaic_import(FakeCzi(), sample_read=True)
    assert info["likely_unstitched"] is True
    assert info["mosaic_stitch_status"] == "suspect"
    assert any("bounding box" in w.lower() or "tile" in w.lower() for w in info["mosaic_warnings"])


def test_assess_mosaic_import_non_mosaic_clean() -> None:
    class FakeCzi:
        def is_mosaic(self):
            return False

        def get_dims_shape(self):
            return [{"Z": (0, 5), "C": (0, 1)}]

    info = assess_mosaic_import(FakeCzi(), sample_read=False)
    assert info["likely_unstitched"] is False
    assert info["mosaic_warnings"] == []


def test_assess_mosaic_import_zen_stitched_full_coverage() -> None:
    """ZEN-stitched mosaics keep M>1 but read_mosaic returns full scene bbox."""
    import numpy as np

    class BBox:
        x = 0
        y = 0
        w = 2000
        h = 1500

    class FakeCzi:
        def is_mosaic(self):
            return True

        def get_dims_shape(self):
            return [{"M": (0, 30), "Z": (0, 1), "C": (0, 1), "S": (0, 1)}]

        def read_mosaic(self, **kwargs):
            assert "S" not in kwargs
            plane = np.zeros((1500, 2000), dtype=np.uint16)
            return plane, [("Y", 1500), ("X", 2000)]

        def get_mosaic_scene_bounding_box(self, index=0):
            return BBox()

    info = assess_mosaic_import(FakeCzi(), sample_read=True)
    assert info["likely_unstitched"] is False
    assert info["mosaic_stitch_status"] == "ok"
    assert info["m_tile_count"] == 30
    assert not any("stitch in ZEN" in w for w in info["mosaic_warnings"])


def test_read_czi_plane_mosaic_uses_read_mosaic() -> None:
    import numpy as np

    class FakeCzi:
        def __init__(self):
            self.calls = []

        def is_mosaic(self):
            return True

        def get_dims_shape(self):
            return [{"M": (0, 4), "Z": (0, 2), "C": (0, 4), "S": (0, 3)}]

        def get_mosaic_scene_bounding_box(self, index=0):
            class BBox:
                x = 100
                y = 200
                w = 800
                h = 600

            return BBox()

        def read_mosaic(self, **kwargs):
            self.calls.append(kwargs)
            if "S" in kwargs:
                raise ValueError("Do not set S when reading mosaic files!")
            arr = np.ones((1, 12, 24), dtype=np.uint8)
            return arr, [("Y", 12), ("X", 24)]

        def read_image(self, **kwargs):
            raise AssertionError("read_image should not be called for mosaic files")

    czi = FakeCzi()
    plane = read_czi_plane(czi, scene=2, z=1, channel=3)
    assert plane.shape == (12, 24)
    assert czi.calls == [
        {
            "scale_factor": 1.0,
            "Z": 1,
            "C": 3,
            "region": (100, 200, 800, 600),
        }
    ]


def test_read_czi_plane_mosaic_single_scene_no_region() -> None:
    import numpy as np

    class FakeCzi:
        def __init__(self):
            self.calls = []

        def is_mosaic(self):
            return True

        def get_dims_shape(self):
            return [{"M": (0, 30), "Z": (0, 1), "C": (0, 1), "S": (0, 1)}]

        def read_mosaic(self, **kwargs):
            self.calls.append(kwargs)
            assert "S" not in kwargs
            assert "region" not in kwargs
            arr = np.ones((12, 24), dtype=np.uint8)
            return arr, [("Y", 12), ("X", 24)]

    czi = FakeCzi()
    plane = read_czi_plane(czi, scene=0, z=0, channel=0)
    assert plane.shape == (12, 24)
    assert czi.calls == [{"scale_factor": 1.0, "Z": 0, "C": 0}]
