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
)
from qtpy.QtGui import QImage, QPixmap, QPainter, QColor
from qtpy.QtCore import Qt, QPoint, QEvent
from slice_atlas import add_outlines
from adjust_channels import (
    lowres_channels_for_slice,
    resolve_previews_dir,
)
from slice_index import build_adjust_pairs


def numpy_array_to_qimage(array):
    """Convert a numpy array to a QImage."""
    if np.ndim(array) == 3:
        h, w, ch = array.shape
        # Ensure array is contiguous in memory
        if array.flags["C_CONTIGUOUS"]:
            array = array.copy(order="C")
        if ch == 3:
            format = QImage.Format.Format_RGB888
        elif ch == 4:
            format = QImage.Format.Format_ARGB32
        else:
            raise ValueError("Unsupported channel number: {}".format(ch))
    elif np.ndim(array) == 2:
        h, w = array.shape
        format = QImage.Format.Format_Grayscale8
    else:
        raise ValueError("Unsupported numpy array shape: {}".format(array.shape))

    # Create a QImage from the data
    qimage = QImage(array.data, w, h, array.strides[0], format)

    # Make sure to keep a reference to the array during the lifetime of the QImage
    qimage.ndarray = array

    return qimage


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
    def __init__(self, pairs, structure_map, images_dir=None, previews_dir=None):
        super().__init__()

        self.pairs = pairs
        self.structure_map = structure_map
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

        self.current_label = None
        with open(self.pairs[self.current_index][1], "rb") as f:
            self.current_label = pickle.load(f)

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
        self.convert_button = QPushButton("Convert Layers to Parents", self)
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
        """For the current labels convert all labels with layer to their parents"""
        # First dump current selections, could be children of a layer
        self.selected_region_id = None
        self.selected_region_name = "None"

        # Get the current label
        label_array = np.array(self.current_label, dtype=np.uint32)
        # Loop through all unique label values
        for label_value, info in self.structure_map.items():
            # Create a mask where the label array matches the current label value
            mask = label_array == label_value
            if "layer" in info["name"].lower():
                # Get the parent label
                parent_label = info["id_path"].split("/")[-2]
                # Set the mask to the parent label
                label_array[mask] = np.int32(parent_label)

        self.current_label = label_array
        self.show_image_with_overlay()

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
        label_array = np.array(self.current_label, dtype=np.uint32)
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
            _, anno_path, _ = self.pairs[self.current_index]
            with open(anno_path, "rb") as f:
                self.current_label = pickle.load(f)

            self.current_delta = 0
            self.deltas = []
            self.originals = []
            self.was_changed = False
            self._update_section_labels()
            self.rebuild_channel_buttons()

    def next_image(self):
        if self.current_index < len(self.pairs) - 1:
            if self.was_changed:
                if not self.warn_unsaved_changes():
                    return

            self.current_index += 1
            _, anno_path, _ = self.pairs[self.current_index]
            with open(anno_path, "rb") as f:
                self.current_label = pickle.load(f)

            self.current_delta = 0
            self.deltas = []
            self.originals = []
            self.was_changed = False
            self._update_section_labels()
            self.rebuild_channel_buttons()

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
        pairs, structure_map, images_path, previews_dir
    )
    window.show()

    sys.exit(app.exec_())
