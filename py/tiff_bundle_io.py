"""Path-based TIFF I/O for bundle pipelines (bypasses io_fairshare BytesIO on NAS)."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import numpy as np
import tifffile as tiff


def page_count(path: Path) -> int:
    with tiff.TiffFile(str(path)) as tf:
        return len(tf.pages)


def is_zstack(path: Path) -> bool:
    return page_count(path) > 1


def iter_tiff_pages(path: Path) -> Iterator[np.ndarray]:
    """Yield each TIFF page as an ndarray (path-based read)."""
    with tiff.TiffFile(str(path)) as tf:
        if not tf.pages:
            raise ValueError(f"No TIFF pages in {path.name}")
        for page in tf.pages:
            yield np.asarray(page.asarray())


def read_tiff_2d(path: Path) -> np.ndarray:
    """Read a single-page TIFF via TiffFile."""
    with tiff.TiffFile(str(path)) as tf:
        if not tf.pages:
            raise ValueError(f"No TIFF pages in {path.name}")
        return np.asarray(tf.pages[0].asarray())


def write_tiff_2d(path: Path, arr: np.ndarray) -> None:
    """Write a 2D array to TIFF via TiffWriter on disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tiff.TiffWriter(str(path)) as writer:
        writer.write(arr, photometric="minisblack")


def transform_tiff_pages(
    path: Path,
    plane_fn: Callable[[np.ndarray], np.ndarray],
) -> tuple[int, tuple[int, ...]]:
    """Apply plane_fn to each page; write via temp file then replace.

    Returns (page_count, shape_of_first_plane).
    """
    tmp = path.with_name(path.stem + "._tiff_tmp" + path.suffix)
    page_total = 0
    first_shape: tuple[int, ...] = ()
    try:
        with tiff.TiffFile(str(path)) as tf:
            if not tf.pages:
                raise ValueError(f"No TIFF pages in {path.name}")
            with tiff.TiffWriter(str(tmp)) as writer:
                for page in tf.pages:
                    plane = np.asarray(page.asarray())
                    out = plane_fn(plane)
                    writer.write(out, photometric="minisblack")
                    page_total += 1
                    if page_total == 1:
                        first_shape = tuple(out.shape)
        tmp.replace(path)
    except Exception:
        if tmp.is_file():
            tmp.unlink(missing_ok=True)
        raise
    return page_total, first_shape
