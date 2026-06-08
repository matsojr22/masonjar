"""Regression: paint-region combo must not repaint before annotation overlay exists."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))


@pytest.fixture
def viewer_class():
    with patch.dict(
        sys.modules,
        {
            "slice_atlas": MagicMock(add_outlines=lambda a, b: b),
            "adjust_channels": MagicMock(
                lowres_channels_for_slice=MagicMock(return_value=[]),
                resolve_previews_dir=MagicMock(return_value=Path("/tmp")),
            ),
            "slice_index": MagicMock(build_adjust_pairs=MagicMock()),
            "structure_catalog": MagicMock(
                list_levels=MagicMock(return_value=[]),
                list_regions_at_level=MagicMock(return_value=[]),
                get_region=MagicMock(return_value=None),
                load_catalog=MagicMock(),
            ),
        },
    ):
        import importlib

        if "adjust" in sys.modules:
            del sys.modules["adjust"]
        import adjust

        return adjust.AnnotationViewer


def test_repaint_selected_only_noops_before_overlay_ready(viewer_class):
    viewer = viewer_class.__new__(viewer_class)
    viewer._overlay_ready = False
    viewer.anno_pixmap = None
    viewer.selected_region_id = np.uint32(315)
    viewer.current_label = np.zeros((4, 4), dtype=np.uint32)
    viewer.anno_scene = MagicMock()
    viewer.anno_scene.items.return_value = []
    viewer.img_scene = MagicMock()
    viewer.overlay_visible = False
    # Should not raise when anno_pixmap is missing
    viewer.repaint_selected_only()


def test_adjust_defers_repaint_until_overlay_flag():
    """Source guard: set_paint_region must not repaint before show_image_with_overlay."""
    src = (_PY_DIR / "adjust.py").read_text(encoding="utf-8")
    assert "self._overlay_ready = False" in src
    assert "if self._overlay_ready:" in src
    assert "self._overlay_ready = True" in src
    assert "from qt_image_utils import numpy_array_to_qimage" in src
    assert (_PY_DIR / "structure_catalog.py").is_file()


def test_init_paint_region_controls_after_paint_swatch():
    """Paint-target widgets must exist before hierarchy/area combo population."""
    src = (_PY_DIR / "adjust.py").read_text(encoding="utf-8")
    marker = "def initUI(self):\n        self.section_info_label"
    idx = src.find(marker)
    assert idx != -1
    init_ui = src[idx:].split("\n    def ")[0]
    swatch_pos = init_ui.find("self.paint_swatch")
    init_paint_pos = init_ui.find("self._init_paint_region_controls()")
    assert swatch_pos != -1 and init_paint_pos != -1
    assert swatch_pos < init_paint_pos
    assert 'if not hasattr(self, "paint_swatch"):' in src
