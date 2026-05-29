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
    QButtonGroup,
    QComboBox,
    QCompleter,
    QGroupBox,
    QListWidget,
    QListWidgetItem,
)
from qtpy.QtGui import QImage, QPixmap, QPainter, QColor
from qtpy.QtCore import Qt, QPoint, QEvent
from slice_atlas import add_outlines
from adjust_channels import (
    lowres_channels_for_slice,
    resolve_previews_dir,
)
from slice_index import build_adjust_pairs
from structure_catalog import (
    CCF_ADVANCED_HELP,
    FULL_DETAIL_TIER,
    format_ccf_level_label,
    get_region,
    list_ccf_levels,
    list_regions_at_level,
    list_regions_for_tier,
    list_tiers,
    load_catalog,
)
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
        ui_layout = QVBoxLayout()

        self.section_info_label = QLabel("", self)
        self.section_info_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        ui_layout.addWidget(self.section_info_label)

        channel_row = QHBoxLayout()
        channel_row.addWidget(QLabel("Background channel:", self))
        self.channel_buttons_container = QHBoxLayout()
        channel_row.addLayout(self.channel_buttons_container)
        channel_row.addStretch()
        self.channel_button_group = QButtonGroup(self)
        self.channel_button_group.setExclusive(True)
        self.channel_button_group.idClicked.connect(self._on_channel_selected)
        ui_layout.addLayout(channel_row)

        paint_row = QHBoxLayout()
        paint_row.addWidget(QLabel("Hierarchy:", self))
        self.tier_combo = QComboBox(self)
        self.tier_combo.currentIndexChanged.connect(self._on_tier_changed)
        paint_row.addWidget(self.tier_combo)
        self.level_combo = QComboBox(self)
        self.level_combo.currentIndexChanged.connect(self._on_level_changed)
        self.level_combo.setVisible(False)
        paint_row.addWidget(self.level_combo)
        paint_row.addWidget(QLabel("Area:", self))
        self.area_combo = QComboBox(self)
        self.area_combo.setEditable(True)
        self.area_combo.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self.area_combo.setMinimumWidth(280)
        area_completer = self.area_combo.completer()
        area_completer.setCompletionMode(QCompleter.CompletionMode.PopupCompletion)
        area_completer.setFilterMode(Qt.MatchFlag.MatchContains)
        self.area_combo.lineEdit().textChanged.connect(self._on_area_search_changed)
        self.area_combo.activated.connect(self._on_area_activated)
        paint_row.addWidget(self.area_combo)
        paint_row.addStretch()
        ui_layout.addLayout(paint_row)
        toggle_row = QHBoxLayout()
        self.ccf_advanced_toggle = QCheckBox(
            "Advanced — show CCFv3 raw depths", self
        )
        self.ccf_advanced_toggle.setChecked(False)
        self.ccf_advanced_toggle.toggled.connect(self._on_ccf_advanced_toggled)
        toggle_row.addWidget(self.ccf_advanced_toggle)
        toggle_row.addStretch()
        ui_layout.addLayout(toggle_row)
        self.ccf_advanced_help = QLabel(CCF_ADVANCED_HELP, self)
        self.ccf_advanced_help.setWordWrap(True)
        font = self.ccf_advanced_help.font()
        font.setItalic(True)
        self.ccf_advanced_help.setFont(font)
        self.ccf_advanced_help.setVisible(False)
        ui_layout.addWidget(self.ccf_advanced_help)
        self.paint_hint_label = QLabel(
            "Select area for brush; right-click slice still picks existing labels.",
            self,
        )
        self.paint_hint_label.setWordWrap(True)
        ui_layout.addWidget(self.paint_hint_label)
        self._init_paint_region_controls()
        self._init_parcellation_controls(ui_layout)

        # images
        image_layout = QHBoxLayout()
        self.img_view = QGraphicsView(self)
        self.anno_view = QGraphicsView(self)
        self.anno_scene = QGraphicsScene(self)
        self.anno_view.setScene(self.anno_scene)

        self.img_scene = QGraphicsScene(self)
        self.img_pixmap = QPixmap()
        self.img_view.setScene(self.img_scene)
        self._update_section_labels()
        self.rebuild_channel_buttons()

        self.is_drawing = False
        self.last_draw_point = None
        self.img_view.viewport().setAttribute(
            Qt.WidgetAttribute.WA_AcceptTouchEvents, False
        )
        self.anno_view.viewport().setAttribute(
            Qt.WidgetAttribute.WA_AcceptTouchEvents, False
        )

        image_layout.addWidget(self.img_view)
        image_layout.addWidget(self.anno_view)

        ui_layout.addLayout(image_layout)
        # Loading labels
        # Bottom widget for controls
        controls_layout = QVBoxLayout()
        # Buttons for nav
        nav_layout = QHBoxLayout()
        self.prev_button = QPushButton("Previous", self)
        self.prev_button.clicked.connect(self.prev_image)
        self.next_button = QPushButton("Next", self)
        self.next_button.clicked.connect(self.next_image)
        nav_layout.addWidget(self.prev_button)
        nav_layout.addWidget(self.next_button)
        controls_layout.addLayout(nav_layout)
        # Slider for opacity
        opacity_layout = QHBoxLayout()
        self.overlay_toggle = QPushButton("Toggle Overlay", self)
        self.overlay_toggle.clicked.connect(self.toggle_overlay)
        opacity_layout.addWidget(self.overlay_toggle)
        self.opacity_slider = QSlider(Qt.Horizontal)
        self.opacity_slider.setRange(0, 255)
        self.opacity_slider.setValue(self.opacity)
        self.opacity_slider.valueChanged.connect(self.update_opacity)
        self.opacity_label = QLabel("Opacity", self)
        opacity_layout.addWidget(self.opacity_label)
        opacity_layout.addWidget(self.opacity_slider)
        # slider for zoom level
        zoom_layout = QHBoxLayout()
        self.zoom_label = QLabel(f"Zoom {self.zoom_level}%", self)
        self.zoom_slider = QSlider(Qt.Horizontal)
        self.zoom_slider.setRange(100, 1000)
        self.zoom_slider.setValue(self.zoom_level)
        self.zoom_slider.valueChanged.connect(self.update_zoom)
        zoom_layout.addWidget(self.zoom_label)
        zoom_layout.addWidget(self.zoom_slider)
        controls_layout.addLayout(zoom_layout)
        # slider for brush size
        brush_layout = QHBoxLayout()
        self.brush_label = QLabel(f"Brush Size {self.brush_size}", self)
        self.brush_slider = QSlider(Qt.Horizontal)
        self.brush_slider.setRange(1, 10)
        self.brush_slider.setValue(self.brush_size)
        self.brush_slider.valueChanged.connect(self.update_brush)
        brush_layout.addWidget(self.brush_label)
        brush_layout.addWidget(self.brush_slider)
        controls_layout.addLayout(brush_layout)
        adjustment_layout = QHBoxLayout()
        self.allow_adjustment = QCheckBox("Allow Adjustment", self)
        self.allow_adjustment.setChecked(False)
        self.convert_button = QPushButton("Quick: layers → functional areas", self)
        self.convert_button.setToolTip(
            "Roll cortical layers up to functional areas on this section only."
        )
        self.convert_button.clicked.connect(self.convert_to_parents)
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
        adjustment_layout.addWidget(self.refresh_button)
        adjustment_layout.addWidget(self.undo_button)
        adjustment_layout.addWidget(self.save_button)
        adjustment_layout.addWidget(self.convert_button)
        adjustment_layout.addWidget(self.allow_adjustment)

        controls_layout.addLayout(opacity_layout)
        controls_layout.addLayout(adjustment_layout)

        ui_layout.addLayout(controls_layout)

        # Status bar for displaying region information
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)

        # Set an event filter to track mouse movements on the annotation view
        self.anno_view.setMouseTracking(True)
        self.anno_view.viewport().installEventFilter(self)

        self.img_view.setMouseTracking(True)
        self.img_view.viewport().installEventFilter(self)

        container = QWidget()
        container.setLayout(ui_layout)
        self.setCentralWidget(container)

        self.show_image_with_overlay()

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

    def rebuild_channel_buttons(self):
        """Rebuild channel buttons for the current slice."""
        while self.channel_buttons_container.count():
            item = self.channel_buttons_container.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        for button in list(self.channel_button_group.buttons()):
            self.channel_button_group.removeButton(button)

        _, _, slice_id = self.pairs[self.current_index]
        self.channel_sources = lowres_channels_for_slice(
            self.images_dir, slice_id, self.previews_dir
        )

        default_id = 0
        for i, (name, _) in enumerate(self.channel_sources):
            btn = QPushButton(name, self)
            btn.setCheckable(True)
            self.channel_button_group.addButton(btn, i)
            self.channel_buttons_container.addWidget(btn)
            if name == "DAPI":
                default_id = i

        if not self.channel_sources:
            return

        self.channel_button_group.button(default_id).setChecked(True)
        name, path = self.channel_sources[default_id]
        self.switch_channel(path, name)

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
        elif regions and not search_query.strip():
            self.area_combo.setCurrentIndex(0)
            if line_edit is not None:
                line_edit.setText(self.area_combo.currentText())
            self.set_paint_region(regions[0]["id"])

        if line_edit is not None:
            line_edit.blockSignals(False)
        self.area_combo.blockSignals(False)
        self._area_combo_updating = False

    def _on_level_changed(self, _index: int):
        if self.ccf_advanced:
            self._rebuild_area_combo()

    def _on_tier_changed(self, _index: int):
        tier_id = self._current_tier_id()
        if tier_id:
            self.current_tier_id = tier_id
        if not self.ccf_advanced:
            self._rebuild_area_combo()

    def _on_ccf_advanced_toggled(self, checked: bool):
        self.ccf_advanced = bool(checked)
        self.tier_combo.setVisible(not self.ccf_advanced)
        self.level_combo.setVisible(self.ccf_advanced)
        self.ccf_advanced_help.setVisible(self.ccf_advanced)
        self._rebuild_area_combo()

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
                info = self.structure_map.get(self.selected_region_id, {})
                self.selected_region_name = info.get("name", "Unknown region")
        if self._overlay_ready:
            self.repaint_selected_only()

    def _sync_area_combo_to_region(self, region_id):
        """After right-click pick, align hierarchy/area combos with the slice label."""
        if not self.catalog:
            return
        node = get_region(int(region_id), self.catalog)
        if not node:
            return
        if self.ccf_advanced:
            level = node["st_level"]
            for i in range(self.level_combo.count()):
                if self.level_combo.itemData(i) == level:
                    self.level_combo.blockSignals(True)
                    self.level_combo.setCurrentIndex(i)
                    self.level_combo.blockSignals(False)
                    break
        self._rebuild_area_combo(select_id=node["id"])

    def _current_slice_id(self) -> str:
        return self.pairs[self.current_index][2]

    def _init_parcellation_controls(self, ui_layout):
        """Parcellation level controls (separate from paint-brush hierarchy)."""
        group = QGroupBox("Parcellation (this section)", self)
        layout = QVBoxLayout()

        self.parcel_status_label = QLabel("", self)
        self.parcel_status_label.setWordWrap(True)
        layout.addWidget(self.parcel_status_label)

        target_row = QHBoxLayout()
        target_row.addWidget(QLabel("Target:", self))
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

        bulk_row = QHBoxLayout()
        self.parcel_select_all = QCheckBox("Select all sections", self)
        self.parcel_select_all.toggled.connect(self._on_parcel_select_all)
        bulk_row.addWidget(self.parcel_select_all)
        self.parcel_confirm_each = QCheckBox("Confirm each section", self)
        bulk_row.addWidget(self.parcel_confirm_each)
        bulk_row.addStretch()
        layout.addLayout(bulk_row)

        self.parcel_slice_list = QListWidget(self)
        self.parcel_slice_list.setMaximumHeight(120)
        layout.addWidget(self.parcel_slice_list)

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

        bulk_btn_row = QHBoxLayout()
        self.parcel_apply_selected_button = QPushButton(
            "Apply to selected sections…", self
        )
        self.parcel_apply_selected_button.clicked.connect(
            self.apply_parcellation_to_selected
        )
        bulk_btn_row.addWidget(self.parcel_apply_selected_button)
        bulk_btn_row.addStretch()
        layout.addLayout(bulk_btn_row)

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
        tiers = list_tiers(self.catalog)
        default_tier_index = 0
        for i, tier in enumerate(tiers):
            self.parcel_tier_combo.addItem(tier["label"], tier["id"])
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

        self._populate_parcel_slice_list()
        self._sync_parcellation_ui_from_metadata()

    def _populate_parcel_slice_list(self):
        self.parcel_slice_list.blockSignals(True)
        self.parcel_slice_list.clear()
        current_sid = self._current_slice_id()
        for i, (_, _, slice_id) in enumerate(self.pairs):
            item = QListWidgetItem(f"{slice_id} ({i + 1}/{len(self.pairs)})")
            item.setData(Qt.ItemDataRole.UserRole, slice_id)
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            checked = Qt.CheckState.Checked if slice_id == current_sid else Qt.CheckState.Unchecked
            item.setCheckState(checked)
            self.parcel_slice_list.addItem(item)
        self.parcel_slice_list.blockSignals(False)

    def _on_parcel_select_all(self, checked: bool):
        state = Qt.CheckState.Checked if checked else Qt.CheckState.Unchecked
        for i in range(self.parcel_slice_list.count()):
            self.parcel_slice_list.item(i).setCheckState(state)

    def _checked_slice_ids(self) -> list[str]:
        out: list[str] = []
        for i in range(self.parcel_slice_list.count()):
            item = self.parcel_slice_list.item(i)
            if item.checkState() == Qt.CheckState.Checked:
                out.append(str(item.data(Qt.ItemDataRole.UserRole)))
        return out

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

    def _clear_parcel_excludes(self):
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
        self.parcel_status_label.setText(f"Section: {slice_id} ({n} / {m})")

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
        self.parcel_preview_array = result.label_array

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

    def _set_parcel_bulk_busy(self, busy: bool) -> None:
        widgets = [
            self.parcel_tier_combo,
            self.parcel_level_combo,
            self.parcel_ccf_advanced_toggle,
            self.parcel_preview_toggle,
            self.parcel_apply_button,
            self.parcel_restore_button,
            self.parcel_select_all,
            self.parcel_confirm_each,
            self.parcel_slice_list,
            self.parcel_exclude_button,
            self.parcel_clear_exclude_button,
            self.parcel_exclude_list,
            self.parcel_apply_selected_button,
            self.tier_combo,
            self.level_combo,
            self.area_combo,
            self.brush_slider,
            self.convert_button,
            self.refresh_button,
        ]
        for widget in widgets:
            if widget is not None:
                widget.setEnabled(not busy)
        if busy:
            self.status_bar.showMessage("Applying parcellation to selected sections…")
        QApplication.processEvents()

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

    def apply_parcellation_to_selected(self):
        tier_id, st_level = self._parcel_target()
        if tier_id == FULL_DETAIL_TIER and not self._parcel_excluded_region_ids():
            QMessageBox.information(
                self,
                "Full detail",
                "Choose a coarser parcellation target or add excludes.",
            )
            return
        selected = self._checked_slice_ids()
        if not selected:
            QMessageBox.warning(self, "No sections", "Select at least one section.")
            return

        target_label = parcellation_target_label(
            self.catalog,
            tier_id=tier_id,
            st_level=st_level,
            ccf_advanced=self.parcel_ccf_advanced,
        )
        preview = ", ".join(selected[:5])
        if len(selected) > 5:
            preview += f", … and {len(selected) - 5} more"
        dialog = QMessageBox(self)
        dialog.setIcon(QMessageBox.Icon.Warning)
        dialog.setWindowTitle("Apply parcellation")
        dialog.setText(f"Apply parcellation to {len(selected)} sections?")
        unsaved = (
            "\n\nYou have unsaved brush strokes on the current section."
            if self.was_changed
            else ""
        )
        dialog.setInformativeText(
            f"Target: {target_label}. Sections: {preview}.\n"
            "Manual brush adjustments on selected sections will be reverted."
            f"{unsaved}\n\nUnchecked sections are not changed."
        )
        dialog.setStandardButtons(
            QMessageBox.StandardButton.Apply | QMessageBox.StandardButton.Cancel
        )
        if dialog.exec() != QMessageBox.StandardButton.Apply:
            return

        self._set_parcel_bulk_busy(True)
        self.parcel_preview = False
        self.parcel_preview_toggle.setChecked(False)
        self.parcel_preview_array = None

        ok_count = 0
        fail_count = 0
        confirm_each = self.parcel_confirm_each.isChecked()
        try:
            for i, sid in enumerate(selected):
                self.status_bar.showMessage(
                    f"Parcellation {i + 1}/{len(selected)}: {sid}"
                )
                QApplication.processEvents()
                if confirm_each:
                    if not self._confirm_parcellation_apply(sid, target_label):
                        continue
                result = apply_parcellation_to_slice(
                    self.annotation_dir,
                    sid,
                    tier_id=tier_id,
                    st_level=st_level,
                    excluded_region_ids=self._parcel_excluded_region_ids() or None,
                    structure_map=self.structure_map,
                    catalog=self.catalog,
                    write_disk=True,
                )
                if result.ok:
                    ok_count += 1
                else:
                    fail_count += 1
        finally:
            self._set_parcel_bulk_busy(False)

        current_sid = self._current_slice_id()
        if current_sid in selected:
            pkl_path = self.annotation_dir / f"Annotation_{current_sid}.pkl"
            if pkl_path.is_file():
                with pkl_path.open("rb") as f:
                    self.current_label = pickle.load(f)
                self.was_changed = False
                self.show_image_with_overlay()

        self._sync_parcellation_ui_from_metadata()
        self.status_bar.showMessage(
            f"Bulk parcellation: {ok_count} ok, {fail_count} failed"
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

    def _on_channel_selected(self, button_id: int):
        if button_id < 0 or button_id >= len(self.channel_sources):
            return
        name, path = self.channel_sources[button_id]
        self.switch_channel(path, name)

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
        if self.img_scene.items():
            self.img_scene.removeItem(self.img_scene.items()[0])
        self.img_scene.addPixmap(self.img_pixmap)
        self._update_section_labels()
        self.show_image_with_overlay()

    def refresh_drawings(self):
        """Redraw annotation overlay from current_label without changing region IDs."""
        self.show_image_with_overlay()

    def update_zoom(self):
        self.zoom_level = self.zoom_slider.value()
        self.zoom_label.setText(f"Zoom {self.zoom_level}%")
        self.img_view.resetTransform()
        self.img_view.scale(self.zoom_level / 100, self.zoom_level / 100)

    def update_brush(self):
        self.brush_size = self.brush_slider.value()
        self.brush_label.setText(f"Brush Size {self.brush_size}")

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
            anno_pix = self.anno_scene.items()[0].pixmap()
            overlayed = self.img_pixmap.copy()
            painter = QPainter(overlayed)
            painter.setOpacity(self.opacity / 255)
            painter.drawPixmap(0, 0, anno_pix)
            painter.end()
            self.img_scene.removeItem(self.img_scene.items()[0])
            self.img_scene.addPixmap(overlayed)

    def toggle_overlay(self):
        self.overlay_visible = not self.overlay_visible
        self.img_scene.removeItem(self.img_scene.items()[0])
        self.img_scene.addPixmap(self.img_pixmap)
        self.repaint_selected_only()

    def show_image_with_overlay(self):
        # Create a blank annotation image with the same dimensions
        label_array = np.array(self._label_for_display(), dtype=np.uint32)
        height, width = label_array.shape
        anno_image = QImage(width, height, QImage.Format.Format_ARGB32_Premultiplied)
        anno_image.fill(Qt.transparent)
        # Start painting on annotation image
        painter = QPainter(anno_image)
        # Loop through all unique label values
        present_labels = np.unique(label_array)
        for label_value, info in self.structure_map.items():
            if label_value not in present_labels:
                continue

            color = QColor(*info["color"])

            painter.setPen(color)

            # Create a mask where the label array matches the current label value
            mask = label_array == label_value

            # Paint all matching pixels
            y_coords, x_coords = np.where(mask)
            points = [QPoint(x, y) for x, y in zip(x_coords, y_coords)]
            painter.drawPoints(points)
        painter.end()

        anno_as_array = qimage_to_numpy_array(anno_image)
        anno_image = numpy_array_to_qimage(add_outlines(label_array, anno_as_array))
        self.anno_pixmap = QPixmap.fromImage(anno_image)
        if len(self.anno_scene.items()) > 0:
            self.anno_scene.removeItem(self.anno_scene.items()[0])
        self.anno_scene.addPixmap(self.anno_pixmap)

        # Create a new scene for the annotations if we want to display them
        if self.overlay_visible:
            overlayed = self.img_pixmap.copy()
            painter = QPainter(overlayed)
            painter.setOpacity(self.opacity / 255)
            painter.drawPixmap(0, 0, self.anno_pixmap)
            painter.end()
            self.img_scene.removeItem(self.img_scene.items()[0])
            self.img_scene.addPixmap(overlayed)

        self._overlay_ready = True
        self.repaint_selected_only()

    def paint_deltas(self, points):
        # Update the annotation pixmap with the new points
        new_annos = self.anno_scene.items()[0].pixmap().copy()
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
            self.img_scene.removeItem(self.img_scene.items()[0])
            self.img_scene.addPixmap(overlayed)

        self.anno_scene.removeItem(self.anno_scene.items()[0])
        self.anno_scene.addPixmap(new_annos)

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
        # Ask if they're sure
        dialog = QMessageBox(self)
        dialog.setIcon(QMessageBox.Icon.Information)
        dialog.setText("Are you sure you want to save your changes?")
        dialog.setInformativeText("This will overwrite the current annotation file.")
        dialog.setStandardButtons(
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Cancel
        )
        dialog.setDefaultButton(QMessageBox.StandardButton.Save)
        ret = dialog.exec()
        if ret == QMessageBox.StandardButton.Cancel:
            return

        # Save the current label
        _, anno_path, _ = self.pairs[self.current_index]
        with open(anno_path, "wb") as f:
            pickle.dump(self.current_label, f)
        self.was_changed = False

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
            self.rebuild_channel_buttons()
            self._populate_parcel_slice_list()
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
            self.rebuild_channel_buttons()
            self._populate_parcel_slice_list()
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
            self.repaint_selected_only()

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
            self.img_scene.removeItem(self.img_scene.items()[0])
            self.img_scene.addPixmap(overlayed)

        if len(self.anno_scene.items()) > 0:
            self.anno_scene.removeItem(self.anno_scene.items()[0])
        self.anno_scene.addPixmap(anno_pixmap)

    def eventFilter(self, source, event):
        if event.type() == QEvent.MouseButtonPress:
            if (
                source is self.img_view.viewport()
                or source is self.anno_view.viewport()
            ):
                if (
                    event.button() == Qt.MouseButton.LeftButton
                    and self.allow_adjustment.isChecked()
                    and self.selected_region_id is not None
                ):
                    self.is_drawing = True
                    point = event.pos()
                    self.last_draw_point = self.view_to_image_coordinates(
                        source.parent(), point
                    )
                    self.draw_on_image(self.last_draw_point)
                    return True
                elif event.button() == Qt.MouseButton.RightButton:
                    # select region
                    point = event.pos()
                    image_point = self.view_to_image_coordinates(source.parent(), point)
                    label_value = self.current_label[image_point.y(), image_point.x()]
                    self.selected_region_id = label_value
                    node = (
                        get_region(int(label_value), self.catalog)
                        if self.catalog
                        else None
                    )
                    if node:
                        self.selected_region_name = self._region_display_text(node)
                        self._sync_area_combo_to_region(label_value)
                    else:
                        self.selected_region_name = self.structure_map.get(
                            label_value, {}
                        ).get("name", "Unknown region")
                    self.repaint_selected_only()

        elif event.type() == QEvent.MouseMove:
            point = event.pos()
            if self.is_drawing:
                image_point = self.view_to_image_coordinates(source.parent(), point)
                if (
                    image_point != self.last_draw_point
                ):  # Only draw if the point has changed
                    self.last_draw_point = image_point
                    self.draw_on_image(image_point)
                return True
            # update the status bar
            image_point = self.view_to_image_coordinates(source.parent(), point)
            self.update_status_bar_with_region(image_point)
            return True

        elif event.type() == QEvent.MouseButtonRelease:
            if self.is_drawing and event.button() == Qt.MouseButton.LeftButton:
                self.is_drawing = False
                self.last_draw_point = None
                self.current_delta += 1
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

    def on_app_exit():
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
