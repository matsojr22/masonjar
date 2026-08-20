import numpy as np
import argparse
import os, sys
import pickle
from pathlib import Path
from qtpy.QtWidgets import (
    QApplication,
    QMainWindow,
    QGraphicsView,
    QGraphicsScene,
    QGraphicsEllipseItem,
    QVBoxLayout,
    QPushButton,
    QHBoxLayout,
    QWidget,
    QLabel,
    QSlider,
    QStatusBar,
    QCheckBox,
    QMessageBox,
    QLineEdit,
    QListWidget,
    QComboBox,
    QCompleter,
    QGroupBox,
    QListWidgetItem,
    QFrame,
    QToolBar,
    QDockWidget,
    QSizePolicy,
    QShortcut,
)
from qtpy.QtGui import QImage, QPixmap, QPainter, QColor, QPen, QBrush, QKeySequence, QTransform
from qtpy.QtCore import Qt, QPoint, QPointF, QEvent, QTimer, QRectF
from dialog_preferences import (
    KEY_CONFIRM_SAVE_OVERWRITE,
    KEY_ISOLATE_LABEL_AUDIT,
    KEY_MIXED_RESOLUTION_TIER,
    is_suppressed,
    set_suppressed,
)
from slice_atlas import add_outlines
from adjust_channels import (
    lowres_channels_for_slice,
    resolve_previews_dir,
)
from slice_index import build_adjust_pairs
from structure_catalog import (
    CCF_ADVANCED_HELP,
    FULL_DETAIL_TIER,
    _structure_map_entry,
    format_ccf_level_label,
    get_region,
    list_ccf_levels,
    list_regions_at_level,
    list_regions_for_tier,
    list_tiers,
    load_catalog,
    resolve_label_color,
)
from annotation_exclusion import expand_excluded_ids, apply_exclusion
from apply_parcellation import (
    apply_parcellation_to_slice,
    restore_slice_from_backup,
)
from annotation_relabel import (
    clear_slice_parcellation,
    ensure_full_backup,
    format_applied_parcellation,
    get_slice_parcellation,
    has_full_backup,
    load_full_backup,
    parcellation_target_label,
    relabel_to_target,
    set_slice_parcellation,
)
from qt_image_utils import numpy_array_to_qimage
from qt_window_utils import raise_and_activate


_viewer_exit_reason = "done"


def set_viewer_exit_reason(reason: str) -> None:
    global _viewer_exit_reason
    _viewer_exit_reason = reason


def get_viewer_exit_reason() -> str:
    return _viewer_exit_reason


def qimage_to_numpy_array(qimage):
    """Convert a QImage to a numpy array."""
    # Convert QImage to format RGB32
    qimage = qimage.convertToFormat(QImage.Format.Format_RGB32)

    width = qimage.width()
    height = qimage.height()

    # Get pointer to the data
    ptr = qimage.bits()

    # Interpret the data as a 32-bit integer array
    ptr.setsize(height * width * 4)  # 4 bytes per pixel
    arr = np.array(ptr).reshape((height, width, 4))  # Channels are RGBA

    return arr


class FileSelector(QMainWindow):
    """
    A list of the loaded files with a search bar and buttons to select files
    """

    def __init__(self, files):
        super().__init__()
        self.files = files
        self.selected_file = None
        self.selected_file_index = None
        self.initUI()

    def initUI(self):
        self.setWindowTitle("Select a file")
        self.selected_file = None
        self.selected_file_index = None
        self.search_bar = QLineEdit(self)
        self.search_bar.textChanged.connect(self.search)
        self.file_list = QListWidget(self)
        self.file_list.addItems(self.files)
        self.file_list.itemClicked.connect(self.file_selected)
        self.file_list.itemDoubleClicked.connect(self.file_selected)
        self.file_list.setSortingEnabled(True)

        self.setCentralWidget(self.file_list)

    def search(self):
        search_text = self.search_bar.text()
        if search_text == "":
            self.file_list.clear()
            self.file_list.addItems(self.files)
        else:
            self.file_list.clear()
            self.file_list.addItems([f for f in self.files if search_text in f])

    def file_selected(self, item):
        self.selected_file = item.text()
        self.selected_file_index = self.file_list.index(item)
        self.close()


class AnnotationViewer(QMainWindow):
    def __init__(
        self,
        pairs,
        structure_map,
        images_dir=None,
        previews_dir=None,
        catalog=None,
    ):
        super().__init__()

        self.pairs = pairs
        self.structure_map = structure_map
        self.catalog = catalog
        self._area_combo_updating = False
        self.ccf_advanced = False
        self.current_tier_id = "areas"
        self.images_dir = (
            Path(images_dir) if images_dir else Path(pairs[0][0]).parent
        )
        self.previews_dir = (
            Path(previews_dir)
            if previews_dir
            else resolve_previews_dir(self.images_dir)
        )
        self.active_channel_name = "DAPI"
        self.active_channel_path = None
        self.channel_sources: list[tuple[str, Path]] = []
        self.current_index = 0
        self.current_delta = 0
        self.deltas = []
        self.originals = []
        self.was_changed = False
        self.brush_size = 5
        self.overlay_visible = False
        self.opacity = 100
        self.zoom_level = 100
        self.selected_region_id = None
        self.selected_region_name = "None"
        self._overlay_ready = False
        self._img_pixmap_item = None
        self._anno_pixmap_item = None
        self._syncing_scroll = False
        self._is_panning = False
        self._pan_last_pos = None
        self._space_pan_active = False
        self._space_down = False
        self._save_exit_flag = self.images_dir / ".adjust_save_exit"
        self._save_exit_timer = QTimer(self)
        self._save_exit_timer.timeout.connect(self._poll_save_exit)
        try:
            if self._save_exit_flag.is_file():
                self._save_exit_flag.unlink()
        except OSError:
            pass
        self._save_exit_timer.start(200)

        self.annotation_dir = Path(pairs[0][1]).parent
        self.parcel_ccf_advanced = False
        self.parcel_tier_id = "areas"
        self.parcel_preview = False
        self.parcel_preview_array = None
        self.parcel_excluded_ids: list[int] = []

        self.current_label = None
        with open(self.pairs[self.current_index][1], "rb") as f:
            self.current_label = pickle.load(f)

        _, _, _slice_id = self.pairs[self.current_index]
        ensure_full_backup(self.annotation_dir, _slice_id, self.current_label)

        # GUI Components
        self.initUI()

    def initUI(self):
        self.section_info_label = QLabel("", self)
        self.section_info_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # --- Paint region controls (wired into paint dock below) ---
        self.area_search_box = QLineEdit(self)
        self.area_search_box.setPlaceholderText("Acronym or region name")
        self.area_search_box.setToolTip("Search atlas regions by acronym or name")
        search_completer = QCompleter(self)
        search_completer.setCompletionMode(QCompleter.CompletionMode.PopupCompletion)
        search_completer.setFilterMode(Qt.MatchFlag.MatchContains)
        search_completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self.area_search_box.setCompleter(search_completer)
        self.area_search_box.textEdited.connect(self._on_area_search_box_edited)
        self.area_search_box.returnPressed.connect(
            lambda: self._commit_search_text(self.area_search_box.text())
        )
        search_completer.activated.connect(self._on_area_search_completer_activated)

        self.tier_combo = QComboBox(self)
        self.tier_combo.setToolTip("Semantic hierarchy tier for region picker")
        self.tier_combo.currentIndexChanged.connect(self._on_tier_changed)
        self.level_combo = QComboBox(self)
        self.level_combo.setToolTip("CCFv3 structure level (advanced mode)")
        self.level_combo.currentIndexChanged.connect(self._on_level_changed)
        self.level_combo.setVisible(False)
        self.area_combo = QComboBox(self)
        self.area_combo.setEditable(True)
        self.area_combo.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self.area_combo.setMinimumWidth(220)
        self.area_combo.setToolTip("Atlas region to paint with the brush")
        area_completer = self.area_combo.completer()
        area_completer.setCompletionMode(QCompleter.CompletionMode.PopupCompletion)
        area_completer.setFilterMode(Qt.MatchFlag.MatchContains)
        area_completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self.area_combo.lineEdit().textChanged.connect(self._on_area_search_changed)
        self.area_combo.activated.connect(self._on_area_activated)
        self.ccf_advanced_toggle = QCheckBox("CCFv3 depths", self)
        self.ccf_advanced_toggle.setChecked(False)
        self.ccf_advanced_toggle.setToolTip(CCF_ADVANCED_HELP)
        self.ccf_advanced_toggle.toggled.connect(self._on_ccf_advanced_toggled)
        self._tier_change_notice_shown = False

        # --- Paint target strip (must exist before _init_paint_region_controls) ---
        self.paint_swatch = QLabel(self)
        self.paint_swatch.setFixedSize(18, 18)
        self.paint_swatch.setFrameShape(QFrame.Shape.Box)
        self.paint_target_name = QLabel("None", self)
        self.paint_tier_context = QLabel("", self)
        self.paint_adjust_badge = QLabel("OFF", self)
        self.paint_brush_size_label = QLabel(f"Brush {self.brush_size}px", self)

        self.opacity_slider = QSlider(Qt.Orientation.Horizontal)
        self.opacity_slider.setRange(0, 255)
        self.opacity_slider.setValue(self.opacity)
        self.opacity_slider.valueChanged.connect(self.update_opacity)
        self.opacity_label = QLabel("Opacity", self)

        self.zoom_label = QLabel(f"Zoom {self.zoom_level}%", self)
        self.zoom_slider = QSlider(Qt.Orientation.Horizontal)
        self.zoom_slider.setRange(50, 1000)
        self.zoom_slider.setValue(self.zoom_level)
        self.zoom_slider.valueChanged.connect(self.update_zoom)

        self.brush_label = QLabel(f"Brush {self.brush_size}", self)
        self.brush_slider = QSlider(Qt.Orientation.Horizontal)
        self.brush_slider.setRange(1, 50)
        self.brush_slider.setValue(self.brush_size)
        self.brush_slider.valueChanged.connect(self.update_brush)

        self.refresh_button = QPushButton("Refresh drawings", self)
        self.refresh_button.setToolTip(
            "Redraw annotation overlay from current edits "
            "(does not change region IDs)."
        )
        self.refresh_button.clicked.connect(self.refresh_drawings)
        self.undo_button = QPushButton("Undo", self)
        self.undo_button.clicked.connect(self.undo_last_delta)
        self.save_button = QPushButton("Save", self)
        self.save_button.clicked.connect(self.save_changes)

        # --- Image views (central widget) ---
        self.img_view = QGraphicsView(self)
        self.anno_view = QGraphicsView(self)
        self.anno_scene = QGraphicsScene(self)
        self.anno_view.setScene(self.anno_scene)
        self.img_scene = QGraphicsScene(self)
        self.img_pixmap = QPixmap()
        self.img_view.setScene(self.img_scene)
        self._configure_dual_views()

        self._brush_cursor_img = QGraphicsEllipseItem()
        self._brush_cursor_img.setZValue(1000)
        self._brush_cursor_img.setVisible(False)
        self.img_scene.addItem(self._brush_cursor_img)
        self._brush_cursor_anno = QGraphicsEllipseItem()
        self._brush_cursor_anno.setZValue(1000)
        self._brush_cursor_anno.setVisible(False)
        self.anno_scene.addItem(self._brush_cursor_anno)

        image_layout = QHBoxLayout()
        image_layout.setContentsMargins(0, 0, 0, 0)
        image_layout.addWidget(self.img_view)
        image_layout.addWidget(self.anno_view)
        self.image_panel = QWidget(self)
        self.image_panel.setLayout(image_layout)
        self.setCentralWidget(self.image_panel)

        self.is_drawing = False
        self.last_draw_point = None
        self.img_view.viewport().setAttribute(
            Qt.WidgetAttribute.WA_AcceptTouchEvents, False
        )
        self.anno_view.viewport().setAttribute(
            Qt.WidgetAttribute.WA_AcceptTouchEvents, False
        )
        self.img_view.viewport().setContextMenuPolicy(
            Qt.ContextMenuPolicy.NoContextMenu
        )
        self.anno_view.viewport().setContextMenuPolicy(
            Qt.ContextMenuPolicy.NoContextMenu
        )

        # --- Paint dock ---
        self.paint_dock = QDockWidget("Paint", self)
        self.paint_dock.setObjectName("PaintDock")
        self.paint_dock.setFeatures(
            QDockWidget.DockWidgetFeature.DockWidgetMovable
            | QDockWidget.DockWidgetFeature.DockWidgetFloatable
            | QDockWidget.DockWidgetFeature.DockWidgetClosable
        )
        paint_inner = QWidget(self)
        paint_layout = QVBoxLayout()
        paint_layout.setContentsMargins(4, 4, 4, 4)
        self._init_paint_controls(paint_layout)
        paint_inner.setLayout(paint_layout)
        self.paint_dock.setWidget(paint_inner)
        self.addDockWidget(Qt.DockWidgetArea.LeftDockWidgetArea, self.paint_dock)

        # --- Parcellation dock ---
        self.parcel_dock = QDockWidget("Parcellation", self)
        self.parcel_dock.setObjectName("ParcellationDock")
        self.parcel_dock.setFeatures(
            QDockWidget.DockWidgetFeature.DockWidgetMovable
            | QDockWidget.DockWidgetFeature.DockWidgetFloatable
            | QDockWidget.DockWidgetFeature.DockWidgetClosable
        )
        parcel_inner = QWidget(self)
        parcel_layout = QVBoxLayout()
        parcel_layout.setContentsMargins(4, 4, 4, 4)
        self._init_parcellation_controls(parcel_layout)
        parcel_inner.setLayout(parcel_layout)
        self.parcel_dock.setWidget(parcel_inner)
        self.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, self.parcel_dock)

        # --- Header toolbar (navigation + view essentials only) ---
        header_toolbar = QToolBar("Header", self)
        header_toolbar.setMovable(False)
        self.addToolBar(Qt.ToolBarArea.TopToolBarArea, header_toolbar)
        header_toolbar.addWidget(self.section_info_label)
        header_toolbar.addSeparator()

        self.channel_combo = QComboBox(self)
        self.channel_combo.setMinimumWidth(180)
        self.channel_combo.currentIndexChanged.connect(self._on_channel_combo_changed)
        header_toolbar.addWidget(QLabel("Channel:", self))
        header_toolbar.addWidget(self.channel_combo)
        self.basic_channel_toggle = QCheckBox("BaSiC corrected", self)
        self.basic_channel_toggle.setToolTip(
            "Show BaSiC-corrected low-res preview when available "
            "(_previews/*_basic.png or 00_dapi_basic). Display only."
        )
        self.basic_channel_toggle.setEnabled(False)
        self.basic_channel_toggle.toggled.connect(self._on_basic_channel_toggled)
        header_toolbar.addWidget(self.basic_channel_toggle)

        self.prev_button = QPushButton("Previous", self)
        self.prev_button.clicked.connect(self.prev_image)
        self.next_button = QPushButton("Next", self)
        self.next_button.clicked.connect(self.next_image)
        header_toolbar.addWidget(self.prev_button)
        header_toolbar.addWidget(self.next_button)
        header_toolbar.addSeparator()

        self.overlay_toggle = QPushButton("Toggle Overlay", self)
        self.overlay_toggle.clicked.connect(self.toggle_overlay)
        header_toolbar.addWidget(self.overlay_toggle)

        self.allow_adjustment = QCheckBox("Allow Adjustment", self)
        self.allow_adjustment.setChecked(False)
        self.allow_adjustment.stateChanged.connect(
            lambda _state: self._update_paint_target_strip()
        )
        header_toolbar.addWidget(self.allow_adjustment)
        header_toolbar.addSeparator()

        self.paint_dock_button = QPushButton("Paint", self)
        self.paint_dock_button.setCheckable(True)
        self.paint_dock_button.setChecked(True)
        self.paint_dock_button.clicked.connect(self._toggle_paint_dock)
        header_toolbar.addWidget(self.paint_dock_button)
        self.paint_dock.visibilityChanged.connect(self._on_paint_dock_visibility)

        self.parcel_dock_button = QPushButton("Parcellation", self)
        self.parcel_dock_button.setCheckable(True)
        self.parcel_dock_button.setChecked(True)
        self.parcel_dock_button.clicked.connect(self._toggle_parcel_dock)
        header_toolbar.addWidget(self.parcel_dock_button)
        self.parcel_dock.visibilityChanged.connect(self._on_parcel_dock_visibility)

        # Status bar
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)

        self.anno_view.setMouseTracking(True)
        self.anno_view.viewport().installEventFilter(self)
        self.img_view.setMouseTracking(True)
        self.img_view.viewport().installEventFilter(self)
        self.img_view.installEventFilter(self)
        self.anno_view.installEventFilter(self)
        self._install_view_shortcuts()

        self._update_section_labels()
        channel_loaded = self.rebuild_channel_combo()
        self._init_paint_region_controls()
        self._update_paint_target_strip()
        if not channel_loaded:
            self.show_image_with_overlay()

    def _toggle_paint_dock(self):
        self.paint_dock.setVisible(self.paint_dock_button.isChecked())

    def _on_paint_dock_visibility(self, visible: bool):
        self.paint_dock_button.blockSignals(True)
        self.paint_dock_button.setChecked(visible)
        self.paint_dock_button.blockSignals(False)

    def _toggle_parcel_dock(self):
        self.parcel_dock.setVisible(self.parcel_dock_button.isChecked())

    def _on_parcel_dock_visibility(self, visible: bool):
        self.parcel_dock_button.blockSignals(True)
        self.parcel_dock_button.setChecked(visible)
        self.parcel_dock_button.blockSignals(False)

    def _update_section_labels(self):
        """Primary slice id, section ordinal, and file basenames."""
        if not self.pairs:
            self.section_info_label.setText("")
            self.setWindowTitle("Adjustment Viewer")
            return
        _, anno_path, slice_id = self.pairs[self.current_index]
        n = self.current_index + 1
        m = len(self.pairs)
        anno_base = Path(anno_path).name
        bg = self.active_channel_name or "DAPI"
        bg_file = (
            self.active_channel_path.name
            if self.active_channel_path
            else ""
        )
        self.section_info_label.setText(
            f"{slice_id}\nSection {n} of {m}\n"
            f"Background: {bg}"
            + (f" ({bg_file})" if bg_file else "")
            + f"\n{anno_base}"
        )
        self.setWindowTitle(f"Adjustment Viewer — {slice_id}")

    def rebuild_channel_combo(self) -> bool:
        """Rebuild background channel combo for the current slice.

        Returns True when a channel image was loaded (switch_channel ran).
        """
        channel_combo = self.__dict__.get("channel_combo")
        if channel_combo is None:
            return False

        self.channel_combo.blockSignals(True)
        self.channel_combo.clear()

        _, _, slice_id = self.pairs[self.current_index]
        self.channel_sources = lowres_channels_for_slice(
            self.images_dir, slice_id, self.previews_dir
        )

        if not self.channel_sources:
            self.channel_combo.addItem("No preview channels found", None)
            self.channel_combo.setEnabled(False)
            self.channel_combo.blockSignals(False)
            status_bar = getattr(self, "status_bar", None)
            if status_bar is not None:
                status_bar.showMessage(
                    "No preview channels — add _previews PNGs or 00_dapi PNG for this slice."
                )
            return False

        default_index = 0
        self.channel_combo.setEnabled(True)
        for i, (name, path) in enumerate(self.channel_sources):
            self.channel_combo.addItem(name, str(path))
            if name in ("DAPI", "DAPI (pipeline)", "Dapi"):
                default_index = i

        self.channel_combo.setCurrentIndex(default_index)
        self.channel_combo.blockSignals(False)
        name, path = self.channel_sources[default_index]
        self.switch_channel(path, name)
        self._refresh_basic_toggle_state()
        return True

    def _basic_sibling_path(self, path: Path) -> Path | None:
        """Return BaSiC-corrected sibling preview/DAPI path if it exists."""
        path = Path(path)
        stem = path.stem
        parent = path.parent
        # _previews/{sliceId}_{suffix}.png → {sliceId}_{suffix}_basic.png
        if parent.name == "_previews" or parent.name.lower() == "_previews":
            candidate = parent / f"{stem}_basic.png"
            if candidate.is_file():
                return candidate
            return None
        # 00_dapi/{sliceId}.png → 00_dapi_basic/{sliceId}.png
        if "00_dapi" in parent.name and "basic" not in parent.name.lower():
            sibling_dir = parent.parent / "00_dapi_basic"
            candidate = sibling_dir / path.name
            if candidate.is_file():
                return candidate
        return None

    def _refresh_basic_toggle_state(self):
        toggle = self.__dict__.get("basic_channel_toggle")
        if toggle is None:
            return
        path = getattr(self, "active_channel_path", None)
        if path is None and self.channel_sources:
            path = self.channel_sources[self.channel_combo.currentIndex()][1]
        sibling = self._basic_sibling_path(Path(path)) if path else None
        toggle.blockSignals(True)
        if sibling is None:
            toggle.setChecked(False)
            toggle.setEnabled(False)
        else:
            toggle.setEnabled(True)
            # Keep checked state if still valid
            if toggle.isChecked():
                pass
            toggle.setEnabled(True)
        toggle.blockSignals(False)

    def _on_basic_channel_toggled(self, checked: bool):
        if self.channel_combo.currentIndex() < 0:
            return
        name, path = self.channel_sources[self.channel_combo.currentIndex()]
        if checked:
            sibling = self._basic_sibling_path(Path(path))
            if sibling is not None:
                self.switch_channel(sibling, f"{name} (BaSiC)")
                return
        self.switch_channel(path, name)

    def _on_channel_combo_changed(self, index: int):
        if index < 0 or index >= len(self.channel_sources):
            return
        name, path = self.channel_sources[index]
        self._refresh_basic_toggle_state()
        if getattr(self, "basic_channel_toggle", None) and self.basic_channel_toggle.isChecked():
            sibling = self._basic_sibling_path(Path(path))
            if sibling is not None:
                self.switch_channel(sibling, f"{name} (BaSiC)")
                return
            self.basic_channel_toggle.blockSignals(True)
            self.basic_channel_toggle.setChecked(False)
            self.basic_channel_toggle.blockSignals(False)
        self.switch_channel(path, name)


    def _update_paint_target_strip(self):
        """Refresh paint-target summary row (swatch, name, tier, adjustment, brush)."""
        if not hasattr(self, "paint_swatch"):
            return
        if self.selected_region_id is None:
            self.paint_swatch.setStyleSheet("background-color: #cccccc;")
            self.paint_target_name.setText("None")
        else:
            rid = int(self.selected_region_id)
            r, g, b = resolve_label_color(rid, self.structure_map, self.catalog)
            self.paint_swatch.setStyleSheet(
                f"background-color: rgb({r}, {g}, {b});"
            )
            self.paint_target_name.setText(self.selected_region_name)

        if self.ccf_advanced and self.level_combo.count() > 0:
            tier_ctx = self.level_combo.currentText()
        elif self.tier_combo.count() > 0:
            tier_ctx = self.tier_combo.currentText()
        else:
            tier_ctx = ""
        self.paint_tier_context.setText(tier_ctx)

        if self.allow_adjustment.isChecked():
            self.paint_adjust_badge.setText("ON")
            self.paint_adjust_badge.setStyleSheet("color: green; font-weight: bold;")
        else:
            self.paint_adjust_badge.setText("OFF")
            self.paint_adjust_badge.setStyleSheet("color: gray;")

        self.paint_brush_size_label.setText(f"Brush {self.brush_size}px")
        self.brush_label.setText(f"Brush {self.brush_size}")

    def _update_brush_cursor(self, view, scene_point):
        """Show brush-size ring at cursor when adjustment is enabled."""
        hide_both = (
            not self.allow_adjustment.isChecked()
            or self.selected_region_id is None
        )
        if hide_both:
            self._brush_cursor_img.setVisible(False)
            self._brush_cursor_anno.setVisible(False)
            return

        r = self.brush_size
        rect_x = scene_point.x() - r
        rect_y = scene_point.y() - r
        diameter = 2 * r

        rgb = resolve_label_color(
            int(self.selected_region_id), self.structure_map, self.catalog
        )
        color = QColor(*rgb)
        color.setAlpha(128)
        pen = QPen(color, 1.5)
        pen.setCosmetic(True)
        brush = QBrush(Qt.BrushStyle.NoBrush)

        for item, active_view in (
            (self._brush_cursor_img, self.img_view),
            (self._brush_cursor_anno, self.anno_view),
        ):
            item.setRect(rect_x, rect_y, diameter, diameter)
            item.setPen(pen)
            item.setBrush(brush)
            item.setVisible(view is active_view)

    def _configure_dual_views(self):
        """Center alignment, viewport-center zoom anchors, linked scrollbars."""
        for view in (self.img_view, self.anno_view):
            view.setAlignment(Qt.AlignmentFlag.AlignCenter)
            view.setTransformationAnchor(
                QGraphicsView.ViewportAnchor.AnchorViewCenter
            )
            view.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
            view.setDragMode(QGraphicsView.DragMode.NoDrag)
            view.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
            view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
            view.setHorizontalScrollBarPolicy(
                Qt.ScrollBarPolicy.ScrollBarAsNeeded
            )
            view.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        for view in (self.img_view, self.anno_view):
            view.horizontalScrollBar().valueChanged.connect(
                lambda _v, src=view: self._sync_scroll_from(src)
            )
            view.verticalScrollBar().valueChanged.connect(
                lambda _v, src=view: self._sync_scroll_from(src)
            )

    def _lock_scene_rect_to_pixmap(self, scene: QGraphicsScene, pixmap: QPixmap):
        if pixmap is None or pixmap.isNull():
            return
        scene.setSceneRect(QRectF(pixmap.rect()))

    def _viewport_center_scene_pos(self, view: QGraphicsView) -> QPointF:
        vp = view.viewport()
        return view.mapToScene(vp.rect().center())

    def _apply_zoom(self, zoom_percent: int, *, center_scene_pos: QPointF | None = None):
        """Scale both panes, keeping the scene point under the viewport center."""
        zoom_percent = max(50, min(1000, int(zoom_percent)))
        if center_scene_pos is None:
            center_scene_pos = self._viewport_center_scene_pos(self.img_view)
        scale = zoom_percent / 100.0
        transform = QTransform()
        transform.scale(scale, scale)
        self._syncing_scroll = True
        try:
            for view in (self.img_view, self.anno_view):
                view.setTransform(transform)
                view.centerOn(center_scene_pos)
        finally:
            self._syncing_scroll = False
        self.zoom_level = zoom_percent
        self.zoom_label.setText(f"Zoom {self.zoom_level}%")
        if self.zoom_slider.value() != zoom_percent:
            self.zoom_slider.blockSignals(True)
            self.zoom_slider.setValue(zoom_percent)
            self.zoom_slider.blockSignals(False)

    def _sync_scroll_from(self, source: QGraphicsView):
        if self._syncing_scroll:
            return
        other = self.anno_view if source is self.img_view else self.img_view
        self._syncing_scroll = True
        try:
            other.horizontalScrollBar().setValue(source.horizontalScrollBar().value())
            other.verticalScrollBar().setValue(source.verticalScrollBar().value())
        finally:
            self._syncing_scroll = False

    def _set_img_pixmap(self, pixmap: QPixmap):
        if self._img_pixmap_item is not None:
            self.img_scene.removeItem(self._img_pixmap_item)
        self._img_pixmap_item = self.img_scene.addPixmap(pixmap)
        self._img_pixmap_item.setZValue(0)
        self._lock_scene_rect_to_pixmap(self.img_scene, pixmap)

    def _set_anno_pixmap(self, pixmap: QPixmap):
        if self._anno_pixmap_item is not None:
            self.anno_scene.removeItem(self._anno_pixmap_item)
        self._anno_pixmap_item = self.anno_scene.addPixmap(pixmap)
        self._anno_pixmap_item.setZValue(0)
        self._lock_scene_rect_to_pixmap(self.anno_scene, pixmap)

    def _anno_pixmap(self) -> QPixmap | None:
        if self._anno_pixmap_item is None:
            return None
        return self._anno_pixmap_item.pixmap()

    def _flatten_catalog_regions(self, query: str = "") -> list[dict]:
        if not self.catalog:
            return []
        q = query.strip().lower()
        out: list[dict] = []
        for node in self.catalog.get("by_id", {}).values():
            if not node:
                continue
            hay = f"{node.get('acronym', '')} {node.get('name', '')}".lower()
            if not q or q in hay:
                out.append(node)
        out.sort(key=lambda n: str(n.get("acronym", "")))
        return out

    def _refresh_search_completer(self, query: str = ""):
        completer = self.area_search_box.completer()
        if completer is None:
            return
        regions = self._flatten_catalog_regions(query)
        q = (query or "").strip().lower()

        def sort_key(n):
            ac = str(n.get("acronym") or "").lower()
            if q and ac == q:
                return (0, ac)
            if q and ac.startswith(q):
                return (1, ac)
            return (2, ac)

        regions = sorted(regions, key=sort_key)
        strings = [self._region_display_text(n) for n in regions[:500]]
        from qtpy.QtCore import QStringListModel

        completer.setModel(QStringListModel(strings))

    def _on_area_search_box_edited(self, text: str):
        self._refresh_search_completer(text)

    def _commit_search_text(self, text: str):
        """Select paint target from Search text (full catalog, not tier-scoped)."""
        text = (text or "").strip()
        if not text or not self.catalog:
            return
        regions = self._flatten_catalog_regions("")
        q = text.lower()
        exact_display = None
        exact_acronym = None
        contains = None
        for node in regions:
            disp = self._region_display_text(node)
            ac = str(node.get("acronym") or "").lower()
            if disp.lower() == q:
                exact_display = node
                break
            if ac == q and exact_acronym is None:
                exact_acronym = node
            hay = f"{node.get('acronym', '')} {node.get('name', '')}".lower()
            if contains is None and (q in hay or q in disp.lower()):
                contains = node
        node = exact_display or exact_acronym or contains
        if not node:
            return
        self.set_paint_region(node["id"])
        self._sync_area_combo_to_region(node["id"])
        disp = self._region_display_text(node)
        self.area_search_box.blockSignals(True)
        self.area_search_box.setText(disp)
        self.area_search_box.blockSignals(False)

    def _on_area_search_completer_activated(self, text: str):
        self._commit_search_text(text)

    def _section_has_annotation_labels(self) -> bool:
        if self.current_label is None:
            return False
        return bool(np.any(self.current_label != 0))

    def _maybe_warn_tier_change_mixed_map(self):
        if not self._section_has_annotation_labels():
            return
        msg = (
            "Changing the content tier and painting more regions can create a "
            "mixed-resolution annotation map. Downstream tools (especially Isolate "
            "Regions) may behave unexpectedly unless Include cortical layers and "
            "parcellation match your labels. Count Brain will roll up totals, but "
            "intensity PKLs may need a re-run."
        )
        self.status_bar.showMessage(msg, 20000)
        if is_suppressed(KEY_MIXED_RESOLUTION_TIER):
            return
        if not self._tier_change_notice_shown:
            self._tier_change_notice_shown = True
            dialog = QMessageBox(self)
            dialog.setIcon(QMessageBox.Icon.Information)
            dialog.setWindowTitle("Mixed-resolution labels")
            dialog.setText("Content tier changed after painting")
            dialog.setInformativeText(msg)
            dialog.setStandardButtons(QMessageBox.StandardButton.Ok)
            dont_show = QCheckBox("Don't show this warning again")
            dialog.setCheckBox(dont_show)
            dialog.exec()
            if dont_show.isChecked():
                set_suppressed(KEY_MIXED_RESOLUTION_TIER, True)

    def _update_paint_resolution_warning(self):
        if not hasattr(self, "paint_resolution_warning"):
            return
        if self.current_label is None or not self.catalog:
            self.paint_resolution_warning.clear()
            self.paint_resolution_warning.setVisible(False)
            return
        from annotation_label_audit import audit_label_array
        from annotation_relabel import get_slice_parcellation

        entry = get_slice_parcellation(self.annotation_dir, self._current_slice_id())
        result = audit_label_array(
            self.current_label, self.catalog, self.structure_map, entry
        )
        messages = {
            "mixed_st_levels": (
                "Labels on this section mix multiple CCF levels — Isolate Regions "
                "may need Include cortical layers and a re-run."
            ),
            "layer_on_coarse_parcellation": (
                "Layer-level labels with coarse parcellation — enable Include "
                "cortical layers or re-parcellate at layers tier."
            ),
            "parcellation_metadata_mismatch": (
                "Painted labels do not match declared parcellation tier — re-run "
                "Parcellation or paint at one tier."
            ),
        }
        parts = [messages[c] for c in result.get("issues", []) if c in messages]
        if parts:
            self.paint_resolution_warning.setText(" ".join(parts))
            self.paint_resolution_warning.setVisible(True)
        else:
            self.paint_resolution_warning.clear()
            self.paint_resolution_warning.setVisible(False)

    def _init_paint_region_controls(self):
        """Populate hierarchy/area combos from the CCF catalog."""
        if not self.catalog:
            self.tier_combo.setEnabled(False)
            self.level_combo.setEnabled(False)
            self.area_combo.setEnabled(False)
            self.ccf_advanced_toggle.setEnabled(False)
            return

        self.tier_combo.blockSignals(True)
        self.tier_combo.clear()
        tiers = list_tiers(self.catalog)
        default_tier_index = 0
        for i, tier in enumerate(tiers):
            label = tier["label"]
            self.tier_combo.addItem(label, tier["id"])
            self.tier_combo.setItemData(
                i, tier.get("description", ""), Qt.ItemDataRole.ToolTipRole
            )
            if tier["id"] == self.current_tier_id:
                default_tier_index = i
        self.tier_combo.setCurrentIndex(default_tier_index)
        self.tier_combo.blockSignals(False)
        self.current_tier_id = self.tier_combo.currentData() or "areas"

        self.level_combo.blockSignals(True)
        self.level_combo.clear()
        levels = list_ccf_levels(self.catalog)
        default_level_index = 0
        for i, info in enumerate(levels):
            label = format_ccf_level_label(info)
            self.level_combo.addItem(label, info["level"])
            if info["level"] == 6:
                default_level_index = i
        self.level_combo.setCurrentIndex(default_level_index)
        self.level_combo.blockSignals(False)
        self._rebuild_area_combo()

    def _current_catalog_level(self) -> int | None:
        if self.level_combo.count() == 0:
            return None
        level = self.level_combo.currentData()
        return int(level) if level is not None else None

    def _current_tier_id(self) -> str | None:
        if self.tier_combo.count() == 0:
            return None
        data = self.tier_combo.currentData()
        return str(data) if data is not None else None

    def _region_display_text(self, node: dict) -> str:
        return f"{node['acronym']} — {node['name']}"

    def _region_tooltip(self, region_id: int) -> str:
        info = self.structure_map.get(np.uint32(region_id), {})
        color = info.get("color")
        if color:
            return f"RGB{color}"
        return ""

    def _current_regions(self, search_query: str = "") -> list[dict]:
        """Resolve current region list from either advanced level or semantic tier."""
        if not self.catalog:
            return []
        if self.ccf_advanced:
            level = self._current_catalog_level()
            if level is None:
                return []
            return list_regions_at_level(level, search_query, self.catalog)
        tier_id = self._current_tier_id()
        if not tier_id:
            return []
        return list_regions_for_tier(tier_id, self.catalog, search_query)

    def _rebuild_area_combo(self, search_query: str = "", select_id: int | None = None):
        if not self.catalog:
            return

        # Preserve previously selected paint region across tier/mode swaps.
        if select_id is None and self.selected_region_id is not None:
            select_id = int(self.selected_region_id)

        regions = self._current_regions(search_query)
        self._area_combo_updating = True
        self.area_combo.blockSignals(True)
        line_edit = self.area_combo.lineEdit()
        if line_edit is not None:
            line_edit.blockSignals(True)

        self.area_combo.clear()
        select_index = -1
        for i, node in enumerate(regions):
            display = self._region_display_text(node)
            self.area_combo.addItem(display, node["id"])
            self.area_combo.setItemData(
                i,
                self._region_tooltip(node["id"]),
                Qt.ItemDataRole.ToolTipRole,
            )
            if select_id is not None and node["id"] == select_id:
                select_index = i

        if select_index >= 0:
            self.area_combo.setCurrentIndex(select_index)
            if line_edit is not None:
                line_edit.setText(self.area_combo.currentText())
        elif select_id is not None:
            # Keep paint target when id is outside the current tier/level list
            # (right-click pick, tier swap). Do not clobber to regions[0].
            self.area_combo.setCurrentIndex(-1)
            if line_edit is not None:
                node = get_region(int(select_id), self.catalog)
                if node:
                    line_edit.setText(self._region_display_text(node))
                else:
                    line_edit.clear()
        elif regions and not search_query.strip():
            # Init only: no prior selection → default first region in list.
            self.area_combo.setCurrentIndex(0)
            if line_edit is not None:
                line_edit.setText(self.area_combo.currentText())
            self.set_paint_region(regions[0]["id"])

        if line_edit is not None:
            line_edit.blockSignals(False)
        self.area_combo.blockSignals(False)
        self._area_combo_updating = False

    def _on_level_changed(self, _index: int):
        self._maybe_warn_tier_change_mixed_map()
        if self.ccf_advanced:
            self._rebuild_area_combo()
        self._refresh_search_completer(self.area_search_box.text())
        self._update_paint_target_strip()
        self._update_paint_resolution_warning()

    def _on_tier_changed(self, _index: int):
        self._maybe_warn_tier_change_mixed_map()
        tier_id = self._current_tier_id()
        if tier_id:
            self.current_tier_id = tier_id
        if not self.ccf_advanced:
            self._rebuild_area_combo()
        self._refresh_search_completer(self.area_search_box.text())
        self._update_paint_target_strip()
        self._update_paint_resolution_warning()

    def _on_ccf_advanced_toggled(self, checked: bool):
        self._maybe_warn_tier_change_mixed_map()
        self.ccf_advanced = bool(checked)
        self.tier_combo.setVisible(not self.ccf_advanced)
        self.level_combo.setVisible(self.ccf_advanced)
        self._rebuild_area_combo()
        self._refresh_search_completer(self.area_search_box.text())
        self._update_paint_target_strip()
        self._update_paint_resolution_warning()

    def _on_area_search_changed(self, text: str):
        if self._area_combo_updating or not self.catalog:
            return
        self._rebuild_area_combo(text)

    def _on_area_activated(self, index: int):
        if index < 0 or not self.catalog:
            return
        region_id = self.area_combo.itemData(index)
        if region_id is None:
            return
        self.set_paint_region(int(region_id))

    def set_paint_region(self, region_id, acronym=None, name=None):
        """Set the brush target region from catalog id."""
        region_id = int(region_id)
        self.selected_region_id = np.uint32(region_id)
        if acronym and name:
            self.selected_region_name = f"{acronym} — {name}"
        else:
            node = get_region(region_id, self.catalog) if self.catalog else None
            if node:
                self.selected_region_name = self._region_display_text(node)
            else:
                if self.catalog:
                    self.status_bar.showMessage(
                        f"Catalog node missing for id {region_id}"
                    )
                info = self.structure_map.get(self.selected_region_id, {})
                self.selected_region_name = info.get("name", "Unknown region")
        if not _structure_map_entry(self.structure_map, region_id):
            self.status_bar.showMessage(
                f"No structure_map entry for id {region_id}"
            )
        if self._overlay_ready:
            self.repaint_selected_only()
        self._update_paint_target_strip()

    def _tier_id_containing_region(self, region_id: int) -> str | None:
        """Finest semantic tier whose picker list contains region_id, or None."""
        if not self.catalog:
            return None
        rid = int(region_id)
        # Finest-first so laminar picks land on Cortical layers when possible.
        preference = ("layers", "parts", "subareas", "areas", "regions", "major")
        by_id = {t["id"]: t for t in list_tiers(self.catalog)}
        for tier_id in preference:
            tier = by_id.get(tier_id)
            if tier and rid in tier.get("region_ids", []):
                return tier_id
        return None

    def _sync_area_combo_to_region(self, region_id):
        """Align Hierarchy/Level and Area combo with a picked atlas id.

        Programmatic tier/level switches use blockSignals so the mixed-resolution
        warning only fires on user-driven combo changes.
        """
        if not self.catalog:
            return
        node = get_region(int(region_id), self.catalog)
        if not node:
            return
        rid = int(node["id"])
        if self.ccf_advanced:
            level = node["st_level"]
            for i in range(self.level_combo.count()):
                if self.level_combo.itemData(i) == level:
                    self.level_combo.blockSignals(True)
                    self.level_combo.setCurrentIndex(i)
                    self.level_combo.blockSignals(False)
                    break
        else:
            current = self._current_tier_id()
            tiers = list_tiers(self.catalog)
            current_ids: set[int] = set()
            for tier in tiers:
                if tier["id"] == current:
                    current_ids = set(tier.get("region_ids") or [])
                    break
            if rid not in current_ids:
                target = self._tier_id_containing_region(rid)
                if target and target != current:
                    for i in range(self.tier_combo.count()):
                        if self.tier_combo.itemData(i) == target:
                            self.tier_combo.blockSignals(True)
                            self.tier_combo.setCurrentIndex(i)
                            self.tier_combo.blockSignals(False)
                            self.current_tier_id = target
                            break
        self._rebuild_area_combo(select_id=node["id"])

    def _current_slice_id(self) -> str:
        return self.pairs[self.current_index][2]

    def _init_paint_controls(self, ui_layout):
        """Region picker, paint target, view sliders, and brush/edit controls."""
        region_group = QGroupBox("Region picker", self)
        region_layout = QVBoxLayout()

        search_row = QHBoxLayout()
        search_row.addWidget(QLabel("Search:", self))
        self.area_search_box.setMinimumWidth(160)
        search_row.addWidget(self.area_search_box, 1)
        region_layout.addLayout(search_row)

        tier_row = QHBoxLayout()
        tier_row.addWidget(QLabel("Tier:", self))
        tier_row.addWidget(self.tier_combo, 1)
        region_layout.addLayout(tier_row)

        level_row = QHBoxLayout()
        level_row.addWidget(QLabel("Level:", self))
        level_row.addWidget(self.level_combo, 1)
        region_layout.addLayout(level_row)

        area_row = QHBoxLayout()
        area_row.addWidget(QLabel("Area:", self))
        area_row.addWidget(self.area_combo, 1)
        region_layout.addLayout(area_row)

        region_layout.addWidget(self.ccf_advanced_toggle)
        self.paint_resolution_warning = QLabel("", self)
        self.paint_resolution_warning.setWordWrap(True)
        self.paint_resolution_warning.setStyleSheet("color: #856404;")
        self.paint_resolution_warning.setVisible(False)
        region_layout.addWidget(self.paint_resolution_warning)
        region_group.setLayout(region_layout)
        ui_layout.addWidget(region_group)

        target_group = QGroupBox("Paint target", self)
        target_layout = QVBoxLayout()
        target_top = QHBoxLayout()
        target_top.addWidget(self.paint_swatch)
        target_top.addWidget(self.paint_target_name, 1)
        target_layout.addLayout(target_top)
        target_layout.addWidget(self.paint_tier_context)
        target_meta = QHBoxLayout()
        target_meta.addWidget(self.paint_adjust_badge)
        target_meta.addWidget(self.paint_brush_size_label)
        target_meta.addStretch()
        target_layout.addLayout(target_meta)
        target_group.setLayout(target_layout)
        ui_layout.addWidget(target_group)

        view_group = QGroupBox("View", self)
        view_layout = QVBoxLayout()
        opacity_row = QHBoxLayout()
        opacity_row.addWidget(self.opacity_label)
        opacity_row.addWidget(self.opacity_slider, 1)
        view_layout.addLayout(opacity_row)
        zoom_row = QHBoxLayout()
        zoom_row.addWidget(self.zoom_label)
        zoom_row.addWidget(self.zoom_slider, 1)
        view_layout.addLayout(zoom_row)
        view_group.setLayout(view_layout)
        ui_layout.addWidget(view_group)

        brush_group = QGroupBox("Brush & edits", self)
        brush_layout = QVBoxLayout()
        brush_row = QHBoxLayout()
        brush_row.addWidget(self.brush_label)
        brush_row.addWidget(self.brush_slider, 1)
        brush_layout.addLayout(brush_row)
        btn_row = QHBoxLayout()
        btn_row.addWidget(self.refresh_button)
        btn_row.addWidget(self.undo_button)
        btn_row.addWidget(self.save_button)
        btn_row.addStretch()
        brush_layout.addLayout(btn_row)
        brush_group.setLayout(brush_layout)
        ui_layout.addWidget(brush_group)

        ui_layout.addStretch()
        self._paint_controls_group = region_group

    def _init_parcellation_controls(self, ui_layout):
        """Parcellation level controls (separate from paint-brush hierarchy)."""
        group = QGroupBox("Parcellation (this section)", self)
        layout = QVBoxLayout()

        self.parcel_status_label = QLabel("", self)
        self.parcel_status_label.setWordWrap(True)
        layout.addWidget(self.parcel_status_label)

        target_row = QHBoxLayout()
        target_row.addWidget(QLabel("Roll up to:", self))
        self.parcel_tier_combo = QComboBox(self)
        self.parcel_tier_combo.currentIndexChanged.connect(self._on_parcel_tier_changed)
        target_row.addWidget(self.parcel_tier_combo)
        self.parcel_level_combo = QComboBox(self)
        self.parcel_level_combo.currentIndexChanged.connect(
            self._on_parcel_level_changed
        )
        self.parcel_level_combo.setVisible(False)
        target_row.addWidget(self.parcel_level_combo)
        target_row.addStretch()
        layout.addLayout(target_row)

        parcel_toggle_row = QHBoxLayout()
        self.parcel_ccf_advanced_toggle = QCheckBox(
            "Advanced — show CCFv3 raw depths", self
        )
        self.parcel_ccf_advanced_toggle.toggled.connect(
            self._on_parcel_ccf_advanced_toggled
        )
        parcel_toggle_row.addWidget(self.parcel_ccf_advanced_toggle)
        parcel_toggle_row.addStretch()
        layout.addLayout(parcel_toggle_row)

        self.parcel_applied_label = QLabel("", self)
        self.parcel_applied_label.setWordWrap(True)
        layout.addWidget(self.parcel_applied_label)

        self.parcel_backup_label = QLabel("", self)
        layout.addWidget(self.parcel_backup_label)

        btn_row = QHBoxLayout()
        self.parcel_preview_toggle = QCheckBox("Preview borders", self)
        self.parcel_preview_toggle.toggled.connect(self._on_parcel_preview_toggled)
        btn_row.addWidget(self.parcel_preview_toggle)
        self.parcel_apply_button = QPushButton("Apply parcellation…", self)
        self.parcel_apply_button.clicked.connect(self.apply_parcellation)
        btn_row.addWidget(self.parcel_apply_button)
        self.parcel_restore_button = QPushButton("Restore fine…", self)
        self.parcel_restore_button.clicked.connect(self.restore_fine_parcellation)
        btn_row.addWidget(self.parcel_restore_button)
        btn_row.addStretch()
        layout.addLayout(btn_row)

        self.parcel_quick_areas_button = QPushButton("Layers → functional areas", self)
        self.parcel_quick_areas_button.setToolTip(
            "Roll cortical layers up to functional areas on this section only."
        )
        self.parcel_quick_areas_button.clicked.connect(self.convert_to_parents)
        layout.addWidget(self.parcel_quick_areas_button)

        exclude_row = QHBoxLayout()
        self.parcel_exclude_button = QPushButton("Exclude selected area", self)
        self.parcel_exclude_button.setToolTip(
            "Add the paint-brush Area selection to the exclude list for parcellation."
        )
        self.parcel_exclude_button.clicked.connect(self._add_parcel_exclude_area)
        exclude_row.addWidget(self.parcel_exclude_button)
        self.parcel_clear_exclude_button = QPushButton("Clear excludes", self)
        self.parcel_clear_exclude_button.clicked.connect(self._clear_parcel_excludes)
        exclude_row.addWidget(self.parcel_clear_exclude_button)
        exclude_row.addStretch()
        layout.addLayout(exclude_row)

        self.parcel_exclude_list = QListWidget(self)
        self.parcel_exclude_list.setMaximumHeight(80)
        layout.addWidget(self.parcel_exclude_list)

        group.setLayout(layout)
        ui_layout.addWidget(group)
        self._parcellation_group = group

        if not self.catalog:
            self.parcel_tier_combo.setEnabled(False)
            self.parcel_level_combo.setEnabled(False)
            self.parcel_ccf_advanced_toggle.setEnabled(False)
            self.parcel_preview_toggle.setEnabled(False)
            self.parcel_apply_button.setEnabled(False)
            self.parcel_restore_button.setEnabled(False)
            self._update_parcellation_labels()
            return

        self.parcel_tier_combo.blockSignals(True)
        self.parcel_tier_combo.clear()
        self.parcel_tier_combo.addItem("Full detail", FULL_DETAIL_TIER)
        self.parcel_tier_combo.setItemData(
            0,
            "Keep annotation IDs as drawn (no rollup).",
            Qt.ItemDataRole.ToolTipRole,
        )
        tiers = list_tiers(self.catalog)
        default_tier_index = 0
        for i, tier in enumerate(tiers):
            self.parcel_tier_combo.addItem(tier["label"], tier["id"])
            tip = tier.get("description") or ""
            if tier["id"] == "layers":
                tip = tip or "Laminar resolution for paint / rollup."
            self.parcel_tier_combo.setItemData(
                i + 1, tip, Qt.ItemDataRole.ToolTipRole
            )
            if tier["id"] == self.parcel_tier_id:
                default_tier_index = i + 1
        self.parcel_tier_combo.setCurrentIndex(default_tier_index)
        self.parcel_tier_combo.blockSignals(False)
        self.parcel_tier_id = self.parcel_tier_combo.currentData() or "areas"

        self.parcel_level_combo.blockSignals(True)
        self.parcel_level_combo.clear()
        levels = list_ccf_levels(self.catalog)
        default_level_index = 0
        for i, info in enumerate(levels):
            label = format_ccf_level_label(info)
            self.parcel_level_combo.addItem(label, info["level"])
            if info["level"] == 6:
                default_level_index = i
        self.parcel_level_combo.setCurrentIndex(default_level_index)
        self.parcel_level_combo.blockSignals(False)

        self._sync_parcellation_ui_from_metadata()

    def _parcel_excluded_region_ids(self) -> list[int]:
        return list(self.parcel_excluded_ids)

    def _add_parcel_exclude_area(self):
        if self.selected_region_id is None:
            return
        rid = int(self.selected_region_id)
        if rid not in self.parcel_excluded_ids:
            self.parcel_excluded_ids.append(rid)
            node = get_region(rid, self.catalog) if self.catalog else None
            label = self._region_display_text(node) if node else str(rid)
            self.parcel_exclude_list.addItem(label)

    def _reload_parcel_excludes_from_metadata(self, entry: dict | None = None):
        """Reload exclude list for the current slice from parcellation metadata."""
        self.parcel_excluded_ids = []
        self.parcel_exclude_list.clear()
        if entry is None:
            entry = get_slice_parcellation(
                self.annotation_dir, self._current_slice_id()
            )
        excluded = entry.get("excluded_region_ids") if entry else None
        if not excluded:
            return
        for rid in excluded:
            rid_int = int(rid)
            self.parcel_excluded_ids.append(rid_int)
            node = get_region(rid_int, self.catalog) if self.catalog else None
            label = self._region_display_text(node) if node else str(rid_int)
            self.parcel_exclude_list.addItem(label)

    def _clear_parcel_excludes(self):
        """Clear exclude list for the current slice (does not persist until apply)."""
        self.parcel_excluded_ids = []
        self.parcel_exclude_list.clear()

    def _parcel_target(self) -> tuple[str | None, int | None]:
        if not self.catalog:
            return None, None
        if self.parcel_ccf_advanced:
            level = self.parcel_level_combo.currentData()
            return None, int(level) if level is not None else None
        tier_id = self.parcel_tier_combo.currentData()
        if tier_id == FULL_DETAIL_TIER:
            return FULL_DETAIL_TIER, None
        return str(tier_id) if tier_id else None, None

    def _parcellation_baseline(self) -> np.ndarray | None:
        slice_id = self._current_slice_id()
        backup = load_full_backup(self.annotation_dir, slice_id)
        if backup is not None:
            return backup
        return np.asarray(self.current_label, dtype=np.uint32)

    def _update_parcellation_labels(self):
        slice_id = self._current_slice_id()
        n = self.current_index + 1
        m = len(self.pairs)
        unsaved_hint = (
            " — Unsaved brush edits on disk" if self.was_changed else ""
        )
        self.parcel_status_label.setText(
            f"Section: {slice_id} ({n} / {m}){unsaved_hint}"
        )

        if self.catalog:
            tier_id, st_level = self._parcel_target()
            target = parcellation_target_label(
                self.catalog,
                tier_id=tier_id,
                st_level=st_level,
                ccf_advanced=self.parcel_ccf_advanced,
            )
            entry = get_slice_parcellation(self.annotation_dir, slice_id)
            applied = format_applied_parcellation(entry, self.catalog)
            self.parcel_applied_label.setText(f"Current level: {applied}")
            self.parcel_apply_button.setToolTip(
                f"Apply {target} parcellation to this section only."
            )
        else:
            self.parcel_applied_label.setText("Current level: (catalog unavailable)")

        if has_full_backup(self.annotation_dir, slice_id):
            self.parcel_backup_label.setText("Fine backup: saved")
            self.parcel_restore_button.setEnabled(True)
        else:
            self.parcel_backup_label.setText("Fine backup: not saved")
            self.parcel_restore_button.setEnabled(False)

    def _sync_parcellation_ui_from_metadata(self):
        if not self.catalog:
            self._update_parcellation_labels()
            return

        entry = get_slice_parcellation(self.annotation_dir, self._current_slice_id())
        self.parcel_tier_combo.blockSignals(True)
        self.parcel_ccf_advanced_toggle.blockSignals(True)

        if entry and entry.get("st_level") is not None and entry.get("tier_id") is None:
            self.parcel_ccf_advanced = True
            self.parcel_ccf_advanced_toggle.setChecked(True)
            self.parcel_tier_combo.setVisible(False)
            self.parcel_level_combo.setVisible(True)
            level = int(entry["st_level"])
            for i in range(self.parcel_level_combo.count()):
                if self.parcel_level_combo.itemData(i) == level:
                    self.parcel_level_combo.setCurrentIndex(i)
                    break
        elif entry and entry.get("tier_id"):
            self.parcel_ccf_advanced = False
            self.parcel_ccf_advanced_toggle.setChecked(False)
            self.parcel_tier_combo.setVisible(True)
            self.parcel_level_combo.setVisible(False)
            tier_id = entry["tier_id"]
            for i in range(self.parcel_tier_combo.count()):
                if self.parcel_tier_combo.itemData(i) == tier_id:
                    self.parcel_tier_combo.setCurrentIndex(i)
                    break
            self.parcel_tier_id = tier_id
        else:
            self.parcel_ccf_advanced = False
            self.parcel_ccf_advanced_toggle.setChecked(False)
            self.parcel_tier_combo.setVisible(True)
            self.parcel_level_combo.setVisible(False)
            self.parcel_tier_combo.setCurrentIndex(0)

        self.parcel_tier_combo.blockSignals(False)
        self.parcel_ccf_advanced_toggle.blockSignals(False)
        self.parcel_preview = False
        self.parcel_preview_toggle.blockSignals(True)
        self.parcel_preview_toggle.setChecked(False)
        self.parcel_preview_toggle.blockSignals(False)
        self.parcel_preview_array = None
        self._reload_parcel_excludes_from_metadata(entry)
        self._update_parcellation_labels()

    def _on_parcel_tier_changed(self, _index: int):
        tier_id = self.parcel_tier_combo.currentData()
        if tier_id:
            self.parcel_tier_id = tier_id
        self._refresh_parcel_preview()

    def _on_parcel_level_changed(self, _index: int):
        self._refresh_parcel_preview()

    def _on_parcel_ccf_advanced_toggled(self, checked: bool):
        self.parcel_ccf_advanced = bool(checked)
        self.parcel_tier_combo.setVisible(not self.parcel_ccf_advanced)
        self.parcel_level_combo.setVisible(self.parcel_ccf_advanced)
        self._refresh_parcel_preview()

    def _refresh_parcel_preview(self):
        self._update_parcellation_labels()
        if self.parcel_preview:
            self._rebuild_parcel_preview()
            self.show_image_with_overlay()

    def _rebuild_parcel_preview(self):
        if not self.catalog:
            self.parcel_preview_array = None
            return
        baseline = self._parcellation_baseline()
        if baseline is None:
            self.parcel_preview_array = None
            return
        tier_id, st_level = self._parcel_target()
        result = relabel_to_target(
            baseline,
            self.catalog,
            tier_id=tier_id,
            st_level=st_level,
            structure_map=self.structure_map,
        )
        label = result.label_array
        if self.parcel_excluded_ids:
            ex_set = expand_excluded_ids(
                self.structure_map, self.parcel_excluded_ids
            )
            label, _excluded = apply_exclusion(label, ex_set)
        self.parcel_preview_array = label

    def _on_parcel_preview_toggled(self, checked: bool):
        self.parcel_preview = bool(checked)
        if self.parcel_preview:
            self._rebuild_parcel_preview()
        else:
            self.parcel_preview_array = None
        self.show_image_with_overlay()

    def _label_for_display(self):
        if self.parcel_preview and self.parcel_preview_array is not None:
            return self.parcel_preview_array
        return self.current_label

    def _confirm_parcellation_apply(self, slice_id: str, target_label: str) -> bool:
        dialog = QMessageBox(self)
        dialog.setIcon(QMessageBox.Icon.Warning)
        dialog.setWindowTitle("Apply parcellation")
        dialog.setText(f"Apply parcellation to {slice_id}?")
        unsaved = (
            "\n\nYou have unsaved brush strokes on this section."
            if self.was_changed
            else ""
        )
        dialog.setInformativeText(
            f"This will replace the annotation borders on this section only at "
            f"{target_label}. Any manual brush adjustments on this section will be "
            f"reverted (unsaved strokes are lost; saved strokes are overwritten when "
            f"you Save).{unsaved}\n\nOther sections are not changed."
        )
        dialog.setStandardButtons(
            QMessageBox.StandardButton.Apply | QMessageBox.StandardButton.Cancel
        )
        dialog.setDefaultButton(QMessageBox.StandardButton.Cancel)
        return dialog.exec() == QMessageBox.StandardButton.Apply

    def _push_relabel_undo(self, before_array: np.ndarray, after_array: np.ndarray):
        changed = before_array != after_array
        if not np.any(changed):
            return
        ys, xs = np.where(changed)
        if len(self.deltas) <= self.current_delta:
            self.deltas.append(set())
            self.originals.append({})
        points: set[tuple[int, int]] = set()
        originals: dict[tuple[int, int], int] = {}
        for y, x in zip(ys, xs):
            p = (int(x), int(y))
            points.add(p)
            originals[p] = int(before_array[y, x])
        self.deltas[self.current_delta] = points
        self.originals[self.current_delta] = originals
        self.current_delta += 1

    def _apply_parcellation_from_baseline(
        self,
        *,
        tier_id: str | None,
        st_level: int | None,
        update_metadata: bool,
        slice_id: str | None = None,
        confirm: bool = True,
        write_disk: bool = False,
    ) -> bool:
        if not self.catalog:
            return False
        sid = slice_id or self._current_slice_id()
        target_label = parcellation_target_label(
            self.catalog,
            tier_id=tier_id,
            st_level=st_level,
            ccf_advanced=self.parcel_ccf_advanced,
        )
        if confirm and not self._confirm_parcellation_apply(sid, target_label):
            return False

        before = np.asarray(self.current_label, dtype=np.uint32) if sid == self._current_slice_id() else None
        if before is None and write_disk:
            pkl_path = self.annotation_dir / f"Annotation_{sid}.pkl"
            if pkl_path.is_file():
                with pkl_path.open("rb") as f:
                    before = np.asarray(pickle.load(f), dtype=np.uint32)

        result = apply_parcellation_to_slice(
            self.annotation_dir,
            sid,
            tier_id=tier_id,
            st_level=st_level,
            excluded_region_ids=self._parcel_excluded_region_ids() or None,
            structure_map=self.structure_map,
            catalog=self.catalog,
            write_disk=write_disk,
        )
        if not result.ok:
            self.status_bar.showMessage(f"{sid}: failed — {result.error}")
            return False

        if sid == self._current_slice_id() and result.label_array is not None:
            if before is not None:
                self._push_relabel_undo(before, result.label_array)
            self.selected_region_id = None
            self.selected_region_name = "None"
            self.current_label = result.label_array
            self.parcel_preview = False
            self.parcel_preview_toggle.blockSignals(True)
            self.parcel_preview_toggle.setChecked(False)
            self.parcel_preview_toggle.blockSignals(False)
            self.parcel_preview_array = None
            self.was_changed = True
            self.show_image_with_overlay()

        if update_metadata and write_disk:
            pass  # metadata written by apply_parcellation_to_slice

        summary = (
            f"{sid}: relabeled {result.pixels_changed:,} px; "
            f"excluded {result.excluded_pixels:,} px; "
            f"{len(result.unknown_ids)} unmapped ids"
        )
        self.status_bar.showMessage(summary)
        self._update_parcellation_labels()
        return True

    def apply_parcellation(self):
        tier_id, st_level = self._parcel_target()
        if tier_id == FULL_DETAIL_TIER and not self._parcel_excluded_region_ids():
            QMessageBox.information(
                self,
                "Full detail",
                "Choose a coarser parcellation target, add excludes, or use Restore fine.",
            )
            return
        self._apply_parcellation_from_baseline(
            tier_id=tier_id,
            st_level=st_level,
            update_metadata=True,
            write_disk=False,
        )

    def restore_fine_parcellation(self):
        slice_id = self._current_slice_id()
        backup = load_full_backup(self.annotation_dir, slice_id)
        if backup is None:
            QMessageBox.warning(
                self,
                "No backup",
                f"No full-detail backup exists for {slice_id}.",
            )
            return

        dialog = QMessageBox(self)
        dialog.setIcon(QMessageBox.Icon.Warning)
        dialog.setText(f"Restore full detail for {slice_id}?")
        dialog.setInformativeText(
            "This replaces the current annotation on this section only with the "
            "saved full-detail backup. Manual brush adjustments on this section "
            "will be reverted. Other sections are not changed."
        )
        dialog.setStandardButtons(
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel
        )
        dialog.setDefaultButton(QMessageBox.StandardButton.Cancel)
        yes_btn = dialog.button(QMessageBox.StandardButton.Yes)
        if yes_btn is not None:
            yes_btn.setText("Restore")
        if dialog.exec() != QMessageBox.StandardButton.Yes:
            return

        before = np.asarray(self.current_label, dtype=np.uint32)
        result = restore_slice_from_backup(
            self.annotation_dir, slice_id, write_disk=True
        )
        if not result.ok:
            return
        backup_arr = load_full_backup(self.annotation_dir, slice_id)
        if backup_arr is None:
            return
        self._push_relabel_undo(before, backup_arr)
        self.current_label = np.asarray(backup_arr, dtype=np.uint32)
        self.was_changed = True
        clear_slice_parcellation(self.annotation_dir, slice_id)
        self.parcel_preview = False
        self.parcel_preview_toggle.blockSignals(True)
        self.parcel_preview_toggle.setChecked(False)
        self.parcel_preview_toggle.blockSignals(False)
        self.parcel_preview_array = None
        self._sync_parcellation_ui_from_metadata()
        self.show_image_with_overlay()

    def switch_channel(self, path, display_name):
        """Load a low-res background image and refresh the annotation overlay."""
        path = Path(path)
        self.active_channel_path = path
        self.active_channel_name = display_name
        self.img_pixmap = QPixmap(str(path))
        self.img_pixmap = self.img_pixmap.scaled(
            self.current_label.shape[1],
            self.current_label.shape[0],
            Qt.AspectRatioMode.KeepAspectRatio,
        )
        self._set_img_pixmap(self.img_pixmap)
        self._update_section_labels()
        self.show_image_with_overlay()

    def refresh_drawings(self):
        """Redraw annotation overlay from current_label without changing region IDs."""
        self.show_image_with_overlay()

    def update_zoom(self):
        self._apply_zoom(self.zoom_slider.value())

    def _text_input_focused(self) -> bool:
        return isinstance(QApplication.focusWidget(), QLineEdit)

    def _view_shortcuts_allowed(self) -> bool:
        return (
            not self.is_drawing
            and not self._is_panning
            and not self._text_input_focused()
        )

    def _nudge_zoom(self, delta_percent: int):
        if not self._view_shortcuts_allowed():
            return
        value = max(50, min(1000, self.zoom_slider.value() + delta_percent))
        self._apply_zoom(value)

    def _pan_views(self, fx: float, fy: float):
        """Pan both panes by ~20% of the visible viewport via scrollbars."""
        if not self._view_shortcuts_allowed():
            return
        vp = self.img_view.viewport()
        dx = int(round(fx * 0.2 * vp.width()))
        dy = int(round(fy * 0.2 * vp.height()))
        if dx == 0 and dy == 0:
            return
        self._syncing_scroll = True
        try:
            for view in (self.img_view, self.anno_view):
                h = view.horizontalScrollBar()
                v = view.verticalScrollBar()
                h.setValue(h.value() + dx)
                v.setValue(v.value() + dy)
        finally:
            self._syncing_scroll = False

    def _pan_by_pixels(self, dx: int, dy: int):
        if dx == 0 and dy == 0:
            return
        self._syncing_scroll = True
        try:
            for view in (self.img_view, self.anno_view):
                h = view.horizontalScrollBar()
                v = view.verticalScrollBar()
                h.setValue(h.value() + dx)
                v.setValue(v.value() + dy)
        finally:
            self._syncing_scroll = False

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Space and not event.isAutoRepeat():
            self._space_down = True
        super().keyPressEvent(event)

    def keyReleaseEvent(self, event):
        if event.key() == Qt.Key.Key_Space and not event.isAutoRepeat():
            self._space_down = False
            if self._is_panning and self._space_pan_active:
                self._is_panning = False
                self._space_pan_active = False
                self._pan_last_pos = None
        super().keyReleaseEvent(event)

    def _fill_selected_label_with_liw(self):
        """Fill all pixels of the selected label with Lost in Warp (id 0)."""
        if not self._view_shortcuts_allowed():
            return
        if not self.allow_adjustment.isChecked():
            return
        if self.selected_region_id is None or self.current_label is None:
            return
        rid = int(self.selected_region_id)
        if rid == 0:
            return
        before = self.current_label.copy()
        mask = self.current_label == rid
        if not np.any(mask):
            return
        self.current_label[mask] = 0
        self._push_relabel_undo(before, self.current_label)
        self.was_changed = True
        self.set_paint_region(0, "LIW", "Lost in Warp")
        self.show_image_with_overlay()

    def _install_view_shortcuts(self):
        def bind(keys, slot):
            for key in keys:
                sc = QShortcut(QKeySequence(key), self)
                sc.setContext(Qt.ShortcutContext.WindowShortcut)
                sc.activated.connect(slot)

        bind(["-", "Minus", "KeypadMinus"], lambda: self._nudge_zoom(-10))
        bind(["=", "+", "Plus", "KeypadPlus"], lambda: self._nudge_zoom(10))
        bind(["Left"], lambda: self._pan_views(-1, 0))
        bind(["Right"], lambda: self._pan_views(1, 0))
        bind(["Up"], lambda: self._pan_views(0, -1))
        bind(["Down"], lambda: self._pan_views(0, 1))
        bind(["Delete", "Backspace"], self._fill_selected_label_with_liw)

    def update_brush(self):
        self.brush_size = self.brush_slider.value()
        self._update_paint_target_strip()

    def convert_to_parents(self):
        """Quick rollup: cortical layers → functional areas (this section only)."""
        if not self.catalog:
            return
        self.parcel_tier_combo.blockSignals(True)
        for i in range(self.parcel_tier_combo.count()):
            if self.parcel_tier_combo.itemData(i) == "areas":
                self.parcel_tier_combo.setCurrentIndex(i)
                break
        self.parcel_tier_combo.blockSignals(False)
        self.parcel_tier_id = "areas"
        self._apply_parcellation_from_baseline(
            tier_id="areas",
            st_level=None,
            update_metadata=True,
        )

    def update_opacity(self):
        self.opacity = self.opacity_slider.value()
        if self.overlay_visible:
            anno_pix = self._anno_pixmap()
            if anno_pix is None:
                return
            overlayed = self.img_pixmap.copy()
            painter = QPainter(overlayed)
            painter.setOpacity(self.opacity / 255)
            painter.drawPixmap(0, 0, anno_pix)
            painter.end()
            self._set_img_pixmap(overlayed)

    def toggle_overlay(self):
        self.overlay_visible = not self.overlay_visible
        self._set_img_pixmap(self.img_pixmap)
        self.repaint_selected_only()

    def show_image_with_overlay(self):
        center = self._viewport_center_scene_pos(self.img_view)
        # Create a blank annotation image with the same dimensions
        label_array = np.array(self._label_for_display(), dtype=np.uint32)
        height, width = label_array.shape
        anno_image = QImage(width, height, QImage.Format.Format_ARGB32_Premultiplied)
        anno_image.fill(Qt.transparent)
        # Start painting on annotation image
        painter = QPainter(anno_image)
        # Loop through label values present in this slice
        present_labels = np.unique(label_array)
        for label_id in present_labels:
            if int(label_id) == 0:
                continue
            color = QColor(
                *resolve_label_color(
                    int(label_id), self.structure_map, self.catalog
                )
            )
            painter.setPen(color)
            mask = label_array == label_id
            y_coords, x_coords = np.where(mask)
            points = [QPoint(x, y) for x, y in zip(x_coords, y_coords)]
            painter.drawPoints(points)
        painter.end()

        anno_as_array = qimage_to_numpy_array(anno_image)
        anno_image = numpy_array_to_qimage(add_outlines(label_array, anno_as_array))
        self.anno_pixmap = QPixmap.fromImage(anno_image)
        self._set_anno_pixmap(self.anno_pixmap)

        # Create a new scene for the annotations if we want to display them
        if self.overlay_visible:
            overlayed = self.img_pixmap.copy()
            painter = QPainter(overlayed)
            painter.setOpacity(self.opacity / 255)
            painter.drawPixmap(0, 0, self.anno_pixmap)
            painter.end()
            self._set_img_pixmap(overlayed)

        self._overlay_ready = True
        self.repaint_selected_only()
        self._update_paint_resolution_warning()
        self._apply_zoom(self.zoom_level, center_scene_pos=center)

    def paint_deltas(self, points):
        # Update the annotation pixmap with the new points
        base = self._anno_pixmap()
        if base is None:
            return
        new_annos = base.copy()
        painter = QPainter(new_annos)
        color = QColor(218, 112, 214)
        painter.setPen(color)
        painter.drawPoints(points)
        painter.end()
        if self.overlay_visible:
            overlayed = self.img_pixmap.copy()
            painter = QPainter(overlayed)
            painter.setOpacity(self.opacity / 255)
            painter.drawPixmap(0, 0, new_annos)
            painter.end()
            self._set_img_pixmap(overlayed)

        self._set_anno_pixmap(new_annos)

    def _poll_save_exit(self) -> None:
        try:
            if self._save_exit_flag.is_file():
                self._save_exit_flag.unlink()
                set_viewer_exit_reason("cancel")
                self.close()
        except OSError:
            pass

    def closeEvent(self, event):
        if self.was_changed:
            if not self.warn_unsaved_changes():
                event.ignore()
                return
        if get_viewer_exit_reason() != "cancel":
            set_viewer_exit_reason("done")
        self._save_exit_timer.stop()
        super().closeEvent(event)

    def warn_unsaved_changes(self):
        dialog = QMessageBox(self)
        dialog.setIcon(QMessageBox.Icon.Critical)
        dialog.setText("You have unsaved changes!")
        dialog.setInformativeText("Do you want to save your changes?")
        dialog.setStandardButtons(
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel
        )
        dialog.setDefaultButton(QMessageBox.StandardButton.Save)
        ret = dialog.exec()
        if ret == QMessageBox.StandardButton.Save:
            self.save_changes()
            return True
        elif ret == QMessageBox.StandardButton.Discard:
            return True

    def save_changes(self):
        if not is_suppressed(KEY_CONFIRM_SAVE_OVERWRITE):
            dialog = QMessageBox(self)
            dialog.setIcon(QMessageBox.Icon.Information)
            dialog.setText("Are you sure you want to save your changes?")
            dialog.setInformativeText(
                "This will overwrite the current annotation file."
            )
            dialog.setStandardButtons(
                QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Cancel
            )
            dialog.setDefaultButton(QMessageBox.StandardButton.Save)
            dont_show = QCheckBox("Don't show this warning again")
            dialog.setCheckBox(dont_show)
            ret = dialog.exec()
            if ret == QMessageBox.StandardButton.Cancel:
                return
            if dont_show.isChecked():
                set_suppressed(KEY_CONFIRM_SAVE_OVERWRITE, True)

        # Save the current label
        _, anno_path, _ = self.pairs[self.current_index]
        with open(anno_path, "wb") as f:
            pickle.dump(self.current_label, f)
        self.was_changed = False
        self._update_parcellation_labels()
        self._refresh_annotation_label_audit_cache(show_intensity_notice=True)

    def _refresh_annotation_label_audit_cache(self, show_intensity_notice: bool = False):
        from annotation_label_audit import (
            audit_align_leaf,
            audit_label_array,
            write_audit_cache,
        )
        from annotation_relabel import get_slice_parcellation

        if not self.catalog:
            return
        try:
            audit = audit_align_leaf(
                self.annotation_dir, self.catalog, self.structure_map
            )
            write_audit_cache(self.annotation_dir, audit)
        except OSError:
            return
        self._update_paint_resolution_warning()
        if not show_intensity_notice:
            return
        entry = get_slice_parcellation(self.annotation_dir, self._current_slice_id())
        slice_audit = audit_label_array(
            self.current_label, self.catalog, self.structure_map, entry
        )
        if not slice_audit.get("issues"):
            return
        if is_suppressed(KEY_ISOLATE_LABEL_AUDIT):
            return
        dialog = QMessageBox(self)
        dialog.setIcon(QMessageBox.Icon.Warning)
        dialog.setWindowTitle("Isolate Regions")
        dialog.setText("Saved labels may affect Isolate Regions")
        dialog.setInformativeText(
            "This section has mixed or mismatched label resolution. Re-run Isolate "
            "Regions after fixing annotations, or review Include cortical layers on "
            "the setup page."
        )
        dialog.setStandardButtons(QMessageBox.StandardButton.Ok)
        dont_show = QCheckBox("Don't show this warning again")
        dialog.setCheckBox(dont_show)
        dialog.exec()
        if dont_show.isChecked():
            set_suppressed(KEY_ISOLATE_LABEL_AUDIT, True)

    def prev_image(self):
        if self.current_index > 0:
            if self.was_changed:
                if not self.warn_unsaved_changes():
                    return
            self.current_index -= 1
            _, anno_path, slice_id = self.pairs[self.current_index]
            with open(anno_path, "rb") as f:
                self.current_label = pickle.load(f)

            ensure_full_backup(self.annotation_dir, slice_id, self.current_label)
            self.current_delta = 0
            self.deltas = []
            self.originals = []
            self.was_changed = False
            self._update_section_labels()
            self._sync_parcellation_ui_from_metadata()
            self.rebuild_channel_combo()
            self.show_image_with_overlay()

    def next_image(self):
        if self.current_index < len(self.pairs) - 1:
            if self.was_changed:
                if not self.warn_unsaved_changes():
                    return

            self.current_index += 1
            _, anno_path, slice_id = self.pairs[self.current_index]
            with open(anno_path, "rb") as f:
                self.current_label = pickle.load(f)

            ensure_full_backup(self.annotation_dir, slice_id, self.current_label)
            self.current_delta = 0
            self.deltas = []
            self.originals = []
            self.was_changed = False
            self._update_section_labels()
            self._sync_parcellation_ui_from_metadata()
            self.rebuild_channel_combo()
            self.show_image_with_overlay()

    def view_to_image_coordinates(self, view, point):
        # Transform the point from view coordinates to scene coordinates
        scene_point = view.mapToScene(point)
        # Convert to integer QPoint
        scene_point = QPoint(int(scene_point.x()), int(scene_point.y()))
        return scene_point

    def update_status_bar_with_region(self, pos):
        if (
            pos.x() < 0
            or pos.y() < 0
            or pos.x() >= self.current_label.shape[1]
            or pos.y() >= self.current_label.shape[0]
        ):
            # Out of bounds
            self.status_bar.showMessage("Out of bounds")
        else:
            label_value = self.current_label[pos.y(), pos.x()]
            region_name = self.structure_map.get(label_value, {}).get(
                "name", "Unknown region"
            )
            self.status_bar.showMessage(
                f"Region: {region_name} | Selected: {self.selected_region_name}"
            )

    def points_in_circle(self, center, radius):
        """Return a list of points in a circle"""
        points = []
        for x in range(center[0] - radius, center[0] + radius + 1):
            for y in range(center[1] - radius, center[1] + radius + 1):
                if (x - center[0]) ** 2 + (y - center[1]) ** 2 <= radius**2:
                    points.append((x, y))
        return points

    def draw_on_image(self, point):
        if (
            point
            and 0 <= point.x() < self.current_label.shape[1]
            and 0 <= point.y() < self.current_label.shape[0]
        ):
            update_points = self.points_in_circle(
                (point.x(), point.y()), self.brush_size
            )

            # Initialize the set for the current stroke if it doesn't exist
            if len(self.deltas) <= self.current_delta:
                self.deltas.append(set())
                self.originals.append({})

            # Keep track of changes
            new_points = set()
            new_originals = {}
            for p in update_points:
                # Check if this point has already been modified in the current stroke
                if p not in self.deltas[self.current_delta]:
                    # Double check if update points are in bounds
                    if (
                        0 <= p[0] < self.current_label.shape[1]
                        and 0 <= p[1] < self.current_label.shape[0]
                    ):
                        # If not, record the original value
                        new_originals[p] = self.current_label[p[1], p[0]]
                        # And mark it as changed
                        new_points.add(p)

                        # Then perform the drawing
                        self.current_label[p[1], p[0]] = self.selected_region_id

            # Add the new points and their original values
            self.deltas[self.current_delta].update(new_points)
            self.originals[self.current_delta].update(new_originals)

            self.was_changed = True

            # Convert the points to QPoint objects for any necessary GUI operations
            update_points = [QPoint(x, y) for x, y in new_points]
            self.paint_deltas(update_points)

    def undo_last_delta(self):
        if self.current_delta > 0:
            # Get the last set of points and original values
            last_points = self.deltas[self.current_delta - 1]
            last_originals = self.originals[self.current_delta - 1]

            # Restore the original values
            for p in last_points:
                self.current_label[p[1], p[0]] = last_originals[p]

            # Remove the last delta and originals from the tracking
            self.deltas.pop(self.current_delta - 1)
            self.originals.pop(self.current_delta - 1)
            self.current_delta -= 1  # Decrease the current delta index

            # Reflect the changes in the image
            self.show_image_with_overlay()

    def repaint_selected_only(self):
        """Repaint the selected region only"""
        if (
            not self._overlay_ready
            or not hasattr(self, "anno_pixmap")
            or self.anno_pixmap is None
            or self.anno_pixmap.isNull()
        ):
            return

        # make a copy of the annotation pixmap
        anno_pixmap = self.anno_pixmap.copy()
        painter = QPainter(anno_pixmap)
        color = QColor(218, 112, 214)
        painter.setPen(color)

        # Create a mask where the label array matches the current label value
        mask = self.current_label == self.selected_region_id
        points = [QPoint(j, i) for i, j in zip(*np.where(mask))]
        painter.drawPoints(points)
        painter.end()

        if self.overlay_visible:
            # paint the annotation pixmap on the overlayed image
            overlayed = self.img_pixmap.copy()
            painter = QPainter(overlayed)
            painter.setOpacity(self.opacity / 255)
            painter.drawPixmap(0, 0, anno_pixmap)
            painter.end()
            self._set_img_pixmap(overlayed)

        self._set_anno_pixmap(anno_pixmap)

    def eventFilter(self, source, event):
        if source in (self.img_view, self.anno_view):
            if (
                event.type() == QEvent.Type.KeyPress
                and event.key() == Qt.Key.Key_Space
                and not event.isAutoRepeat()
            ):
                self._space_down = True
            elif (
                event.type() == QEvent.Type.KeyRelease
                and event.key() == Qt.Key.Key_Space
                and not event.isAutoRepeat()
            ):
                self._space_down = False
                if self._is_panning and self._space_pan_active:
                    self._is_panning = False
                    self._space_pan_active = False
                    self._pan_last_pos = None

        is_view_vp = source in (
            self.img_view.viewport(),
            self.anno_view.viewport(),
        )

        if is_view_vp and event.type() == QEvent.Type.Wheel:
            if self._view_shortcuts_allowed():
                delta = event.angleDelta().y()
                if delta != 0:
                    self._nudge_zoom(10 if delta > 0 else -10)
                    return True
            return True

        if event.type() == QEvent.Type.MouseButtonPress and is_view_vp:
            if event.button() == Qt.MouseButton.MiddleButton or (
                event.button() == Qt.MouseButton.LeftButton
                and getattr(self, "_space_down", False)
            ):
                self._is_panning = True
                self._space_pan_active = (
                    event.button() == Qt.MouseButton.LeftButton
                    and getattr(self, "_space_down", False)
                )
                self._pan_last_pos = event.pos()
                self.is_drawing = False
                return True
            if (
                event.button() == Qt.MouseButton.LeftButton
                and self.allow_adjustment.isChecked()
                and self.selected_region_id is not None
                and not getattr(self, "_space_down", False)
            ):
                self.is_drawing = True
                point = event.pos()
                self.last_draw_point = self.view_to_image_coordinates(
                    source.parent(), point
                )
                self.draw_on_image(self.last_draw_point)
                return True
            if event.button() == Qt.MouseButton.RightButton:
                # Select paint target from clicked atlas label.
                point = event.pos()
                image_point = self.view_to_image_coordinates(source.parent(), point)
                if (
                    image_point.x() < 0
                    or image_point.y() < 0
                    or image_point.x() >= self.current_label.shape[1]
                    or image_point.y() >= self.current_label.shape[0]
                ):
                    self.status_bar.showMessage("Out of bounds")
                    return True
                label_value = int(self.current_label[image_point.y(), image_point.x()])
                self.set_paint_region(label_value)
                self._sync_area_combo_to_region(label_value)
                self.repaint_selected_only()
                return True

        elif event.type() == QEvent.Type.MouseMove and is_view_vp:
            point = event.pos()
            view = source.parent()
            if self._is_panning and self._pan_last_pos is not None:
                dx = self._pan_last_pos.x() - point.x()
                dy = self._pan_last_pos.y() - point.y()
                self._pan_last_pos = point
                self._pan_by_pixels(dx, dy)
                return True
            if self.is_drawing:
                image_point = self.view_to_image_coordinates(view, point)
                if image_point != self.last_draw_point:
                    self.last_draw_point = image_point
                    self.draw_on_image(image_point)
                return True
            image_point = self.view_to_image_coordinates(view, point)
            self.update_status_bar_with_region(image_point)
            self._update_brush_cursor(view, image_point)
            return True

        elif event.type() == QEvent.Type.MouseButtonRelease and is_view_vp:
            if self._is_panning and event.button() in (
                Qt.MouseButton.MiddleButton,
                Qt.MouseButton.LeftButton,
            ):
                self._is_panning = False
                self._space_pan_active = False
                self._pan_last_pos = None
                return True
            if self.is_drawing and event.button() == Qt.MouseButton.LeftButton:
                self.is_drawing = False
                self.last_draw_point = None
                self.current_delta += 1
                self._update_parcellation_labels()
                self.show_image_with_overlay()
                return True

        return super(AnnotationViewer, self).eventFilter(source, event)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Allow adjustment of region alignments"
    )
    parser.add_argument(
        "-a",
        "--annotations",
        help="annotation files path",
        default="",
    )
    parser.add_argument(
        "-i",
        "--images",
        help="images path",
        default="",
    )
    parser.add_argument(
        "-s",
        "--structures",
        help="structures map",
    )
    parser.add_argument(
        "--slice-list",
        default="",
        help="Optional JSON file with slice_ids to restrict pairing",
    )
    parser.add_argument(
        "--previews-dir",
        default="",
        help="Optional low-res preview directory (default: sibling _previews of images dir)",
    )
    args = parser.parse_args()
    print(2, flush=True)
    print("Viewing...", flush=True)

    set_viewer_exit_reason("done")

    def on_app_exit():
        if get_viewer_exit_reason() == "cancel":
            print("Viewer closed", flush=True)
        else:
            print("Done!", flush=True)

    images_path = Path(args.images.strip())
    annotations_path = Path(args.annotations.strip())
    structure_map_path = Path(args.structures.strip())
    structure_map = pickle.load(open(structure_map_path, "rb"))

    graph_path = structure_map_path.parent / "structure_graph.json"
    catalog = None
    if graph_path.is_file():
        catalog = load_catalog(graph_path)
    else:
        print(
            f"WARNING: structure graph not found at {graph_path}",
            file=sys.stderr,
            flush=True,
        )

    pairs, orphan_images, orphan_annos = build_adjust_pairs(
        images_path, annotations_path, args.slice_list.strip() or None
    )
    if orphan_images:
        print(
            f"Unpaired images ({len(orphan_images)}): "
            + ", ".join(orphan_images[:20])
            + ("..." if len(orphan_images) > 20 else ""),
            file=sys.stderr,
            flush=True,
        )
    if orphan_annos:
        print(
            f"Unpaired annotations ({len(orphan_annos)}): "
            + ", ".join(orphan_annos[:20])
            + ("..." if len(orphan_annos) > 20 else ""),
            file=sys.stderr,
            flush=True,
        )

    app = QApplication(sys.argv)

    if not pairs:
        QMessageBox.critical(
            None,
            "No matched pairs",
            "No image/annotation pairs matched by slice ID.\n"
            "Check that DAPI images and annotation PKLs share the same filename stem "
            "(e.g. M528_s027.tif and Annotation_M528_s027.pkl).",
        )
        sys.exit(1)

    app.aboutToQuit.connect(on_app_exit)

    previews_dir = None
    if args.previews_dir.strip():
        previews_dir = Path(args.previews_dir.strip())

    window = AnnotationViewer(
        pairs, structure_map, images_path, previews_dir, catalog
    )
    if catalog is None:
        QMessageBox.critical(
            window,
            "Atlas catalog missing",
            f"Could not load CCF ontology:\n{graph_path}\n\n"
            "Paint-region selection is disabled; right-click on existing labels still works.",
        )
    window.show()
    raise_and_activate(window)

    sys.exit(app.exec_())
