"""Shared grayscale load + uint8 normalization for preprocess filters."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import tifffile as tf


def to_uint8_grayscale(arr: np.ndarray) -> np.ndarray:
    """Scale a 2D grayscale array to uint8 for OpenCV/skimage filters."""
    raw = np.asarray(arr)
    if raw.dtype == np.uint8:
        return np.ascontiguousarray(raw)
    if raw.dtype == np.uint16:
        return np.ascontiguousarray((raw / 256).astype(np.uint8))
    return np.ascontiguousarray(np.clip(raw, 0, 255).astype(np.uint8))


def load_grayscale_uint8(path: Path) -> np.ndarray:
    """Read a grayscale PNG or TIFF and normalize to uint8."""
    suffix = path.suffix.lower()
    if suffix == ".png":
        raw = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if raw is None:
            raise ValueError(f"could not read {path}")
        return np.ascontiguousarray(raw)
    raw = tf.imread(str(path))
    if raw.ndim > 2:
        if raw.shape[-1] in (3, 4):
            raw = cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)
        else:
            raw = np.max(raw, axis=0)
    return to_uint8_grayscale(raw)
