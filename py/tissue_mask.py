"""Tissue isolation mask shared by DAPI cleanup and tissue edge cleanup."""

from __future__ import annotations

import cv2
import numpy as np
from scipy.ndimage import binary_fill_holes
from skimage.measure import label, regionprops
from skimage.morphology import binary_closing, binary_opening, disk, remove_small_objects


def isolate_tissue_mask(gray_u8: np.ndarray) -> np.ndarray:
    blurred = cv2.GaussianBlur(gray_u8, (5, 5), 0)
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = otsu > 0
    if float(np.mean(gray_u8[mask])) > float(np.mean(gray_u8[~mask])):
        mask = ~mask
    se = disk(3)
    mask = binary_closing(mask, se)
    mask = binary_opening(mask, se)
    labeled = label(mask)
    if labeled.max() == 0:
        return mask.astype(bool)
    regions = regionprops(labeled)
    largest = max(regions, key=lambda r: r.area)
    tissue = labeled == largest.label
    tissue = remove_small_objects(tissue, min_size=64)
    tissue = binary_fill_holes(tissue)
    return tissue.astype(bool)
