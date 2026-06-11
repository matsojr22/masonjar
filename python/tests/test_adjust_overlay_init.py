"""Regression: paint-region combo must not repaint before annotation overlay exists."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pickle
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from qtpy.QtWidgets import QApplication

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))


@pytest.fixture(scope="module")
def viewer_class():
    structure_catalog = MagicMock(
        list_levels=MagicMock(return_value=[]),
        list_regions_at_level=MagicMock(return_value=[]),
        list_tiers=MagicMock(return_value=[]),
        list_ccf_levels=MagicMock(return_value=[]),
        format_ccf_level_label=MagicMock(return_value=""),
        get_region=MagicMock(return_value=None),
        load_catalog=MagicMock(),
        CCF_ADVANCED_HELP="",
    )
    with patch.dict(
        sys.modules,
        {
            "slice_atlas": MagicMock(add_outlines=lambda a, b: b),
            "adjust_channels": MagicMock(
                lowres_channels_for_slice=MagicMock(return_value=[]),
                resolve_previews_dir=MagicMock(return_value=Path("/tmp")),
            ),
            "slice_index": MagicMock(build_adjust_pairs=MagicMock()),
            "structure_catalog": structure_catalog,
        },
    ):
        import adjust

        viewer_cls = adjust.AnnotationViewer
    sys.modules["adjust"] = adjust
    return viewer_cls


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


def _init_ui_source():
    src = (_PY_DIR / "adjust.py").read_text(encoding="utf-8")
    marker = "def initUI(self):\n        self.section_info_label"
    idx = src.find(marker)
    assert idx != -1
    return src[idx:].split("\n    def ")[0]


def test_rebuild_channel_combo_after_widgets_in_initui():
    """Background channel combo must exist before rebuild_channel_combo runs."""
    init_ui = _init_ui_source()
    combo_pos = init_ui.find("self.channel_combo = QComboBox")
    status_pos = init_ui.find("self.setStatusBar(self.status_bar)")
    rebuild_pos = init_ui.find("self.rebuild_channel_combo()")
    assert combo_pos != -1 and status_pos != -1 and rebuild_pos != -1
    assert combo_pos < rebuild_pos
    assert status_pos < rebuild_pos
    assert "self.rebuild_channel_combo()" not in init_ui[:combo_pos]


def test_rebuild_channel_combo_has_channel_combo_guard():
    src = (_PY_DIR / "adjust.py").read_text(encoding="utf-8")
    assert 'self.__dict__.get("channel_combo")' in src
    assert "getattr(self, \"status_bar\", None)" in src


def test_rebuild_channel_combo_guard_without_widgets(viewer_class):
    viewer = viewer_class.__new__(viewer_class)
    viewer.pairs = [("/tmp/img.png", "/tmp/anno.pkl", "slice_a")]
    viewer.current_index = 0
    assert viewer.rebuild_channel_combo() is False


@pytest.fixture
def qapp():
    app = QApplication.instance()
    if app is None:
        app = QApplication([])
    yield app


def test_initui_completes_with_empty_channels(tmp_path, viewer_class, qapp):
    """initUI must not crash when no preview channels exist for the slice."""
    label = np.zeros((8, 8), dtype=np.uint32)
    anno_path = tmp_path / "Annotation_test.pkl"
    with open(anno_path, "wb") as f:
        pickle.dump(label, f)
    img_path = tmp_path / "test.png"
    pairs = [(str(img_path), str(anno_path), "test_slice")]

    with patch.object(sys.modules["adjust"], "ensure_full_backup"):
        viewer = viewer_class(pairs, structure_map={}, catalog=None)

    assert hasattr(viewer, "channel_combo")
    assert hasattr(viewer, "status_bar")
    assert hasattr(viewer, "paint_dock")
    assert hasattr(viewer, "paint_dock_button")
    assert viewer.channel_sources == []
    assert viewer.channel_combo.isEnabled() is False


def test_paint_controls_use_dock_not_top_toolbars():
    """Paint UI lives in QDockWidget, not stacked top toolbars."""
    src = (_PY_DIR / "adjust.py").read_text(encoding="utf-8")
    assert 'QDockWidget("Paint"' in src
    assert "def _init_paint_controls(self, ui_layout):" in src
    assert 'QToolBar("Paint"' not in src
    assert 'QToolBar("Target"' not in src
    assert 'QToolBar("Controls"' not in src
