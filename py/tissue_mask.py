"""Tissue isolation mask shared by DAPI cleanup and tissue edge cleanup."""

from __future__ import annotations

import cv2
import numpy as np
from scipy.ndimage import binary_erosion, binary_fill_holes
from skimage.measure import label, regionprops
from skimage.morphology import binary_closing, binary_opening, disk, remove_small_objects


def parse_stroke_points(stroke_raw) -> list[tuple[int, int]]:
    """Accept [[x,y]], [{x,y}], or {points: [...]}."""
    if isinstance(stroke_raw, dict):
        stroke_raw = stroke_raw.get("points") or stroke_raw.get("stroke") or []
    if not isinstance(stroke_raw, (list, tuple)):
        return []
    out: list[tuple[int, int]] = []
    for p in stroke_raw:
        if isinstance(p, dict):
            x = p.get("x", p.get(0))
            y = p.get("y", p.get(1))
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            x, y = p[0], p[1]
        else:
            continue
        out.append((int(x), int(y)))
    return out


def isolate_tissue_mask(
    gray_u8: np.ndarray,
    *,
    edge_shrink_px: int = 0,
    min_object_size: int | None = None,
    opening_disk: int = 3,
) -> np.ndarray:
    blurred = cv2.GaussianBlur(gray_u8, (5, 5), 0)
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = otsu > 0
    if float(np.mean(gray_u8[mask])) > float(np.mean(gray_u8[~mask])):
        mask = ~mask
    se = disk(max(1, int(opening_disk)))
    mask = binary_closing(mask, se)
    mask = binary_opening(mask, se)
    labeled = label(mask)
    if labeled.max() == 0:
        return mask.astype(bool)
    regions = regionprops(labeled)
    largest = max(regions, key=lambda r: r.area)
    tissue = labeled == largest.label
    min_size = min_object_size
    if min_size is None:
        min_size = 64
    tissue = remove_small_objects(tissue, min_size=int(min_size))
    tissue = binary_fill_holes(tissue)
    if edge_shrink_px > 0:
        tissue = binary_erosion(tissue, iterations=int(edge_shrink_px))
    return tissue.astype(bool)


def wizard_mask_kwargs(gray_u8: np.ndarray, edge_shrink_px: int = 2) -> dict:
    """Defaults for tissue cleanup wizard auto/guided paths."""
    h, w = gray_u8.shape
    min_area = max(64, int(h * w * 0.0005))
    return {
        "edge_shrink_px": max(0, int(edge_shrink_px)),
        "min_object_size": min_area,
        "opening_disk": 4,
    }
