"""Sharpen / equalize pipeline for Mason Jar (unsharp + optional CLAHE + white tophat)."""

from __future__ import annotations

import pipeline_io_bootstrap  # noqa: F401
import argparse
import json
import os
import sys
import traceback
from pathlib import Path

import cv2
import numpy as np
import tifffile as tiff
from skimage.filters import unsharp_mask
from skimage.morphology import disk, white_tophat

from grayscale_load import load_grayscale_native, load_grayscale_uint8

# Full-frame sharpen on ~15k×12k uint8 peaks ~6 GB RAM (unsharp + tophat); use tiles above this.
TILED_SHARPEN_PIXEL_THRESHOLD = 50_000_000
TILED_SHARPEN_TILE = 4096
TILED_SHARPEN_PAD = 32
TOPHAT_DISK_RADIUS = 15


def _sharpen_debug_enabled() -> bool:
    return os.environ.get("MASONJAR_SHARPEN_DEBUG", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _image_stats(arr: np.ndarray) -> dict[str, float | int | str]:
    flat = np.asarray(arr).astype(np.float64).ravel()
    if flat.size == 0:
        return {"dtype": str(arr.dtype), "min": 0, "max": 0, "p50": 0, "p95": 0}
    return {
        "dtype": str(arr.dtype),
        "min": float(flat.min()),
        "max": float(flat.max()),
        "p50": float(np.percentile(flat, 50)),
        "p95": float(np.percentile(flat, 95)),
    }


def _log_debug(prefix: str, **fields: object) -> None:
    if not _sharpen_debug_enabled():
        return
    parts = " ".join(f"{k}={v}" for k, v in fields.items())
    print(f"LOG: {prefix} {parts}".strip(), flush=True)


def enhance_contrast(image, saturation_level=0.05):
    saturation_point = saturation_level / 100
    flat_image = image.ravel()
    low_saturation_value = np.percentile(flat_image, saturation_point)
    high_saturation_value = np.percentile(flat_image, 100 - saturation_point)
    clipped_image = np.clip(flat_image, low_saturation_value, high_saturation_value)
    if np.issubdtype(image.dtype, np.integer):
        dtype_min, dtype_max = np.iinfo(image.dtype).min, np.iinfo(image.dtype).max
    else:
        dtype_min, dtype_max = np.finfo(image.dtype).min, np.finfo(image.dtype).max
    rescaled_image = np.interp(
        clipped_image,
        (clipped_image.min(), clipped_image.max()),
        (dtype_min, dtype_max),
    )
    enhanced_image = rescaled_image.reshape(image.shape)
    return enhanced_image.astype(image.dtype)


def sharpen_image_belljar(
    img: np.ndarray,
    radius: float,
    amount: float,
    equalize: bool,
    tophat_radius: int = TOPHAT_DISK_RADIUS,
) -> np.ndarray:
    """Bell Jar Electron core: native dtype through filters, astype(original_dtype) at end."""
    work = np.asarray(img)
    if work.ndim != 2:
        raise ValueError(f"expected 2D image, got ndim={work.ndim}")

    if equalize:
        clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8))
        work = clahe.apply(work)
        work = enhance_contrast(work)

    original_dtype = work.dtype
    work = unsharp_mask(work, radius=radius, amount=amount, preserve_range=True)
    work = white_tophat(work, disk(tophat_radius))
    return work.astype(original_dtype)


def stretch_preview_for_display(roi: np.ndarray) -> np.ndarray:
    """Percentile stretch for wizard preview PNG only (not batch output)."""
    if roi.size == 0:
        return roi.astype(np.uint8)
    out = roi.astype(np.float64)
    lo = float(np.percentile(out, 2))
    hi = float(np.percentile(out, 98))
    if hi <= lo:
        lo = float(out.min())
        hi = float(out.max())
    if hi <= lo:
        return np.zeros(out.shape, dtype=np.uint8)
    stretched = np.clip((out - lo) / (hi - lo) * 255.0, 0, 255)
    return stretched.astype(np.uint8)


def _sharpen_image_tiled(
    img: np.ndarray,
    radius: float,
    amount: float,
    equalize: bool,
) -> np.ndarray:
    h, w = img.shape[:2]
    original_dtype = img.dtype
    out = np.empty((h, w), dtype=original_dtype)
    tile = TILED_SHARPEN_TILE
    pad = TILED_SHARPEN_PAD
    tiles_x = (w + tile - 1) // tile
    tiles_y = (h + tile - 1) // tile
    tiles_total = tiles_x * tiles_y
    tiles_done = 0
    print(
        f"LOG: sharpen_tiled size={w}x{h} tile={tile} pad={pad} tiles={tiles_total}",
        flush=True,
    )

    for y0 in range(0, h, tile):
        for x0 in range(0, w, tile):
            ye = min(h, y0 + tile)
            xe = min(w, x0 + tile)
            cy0 = max(0, y0 - pad)
            cx0 = max(0, x0 - pad)
            cy1 = min(h, ye + pad)
            cx1 = min(w, xe + pad)
            crop = img[cy0:cy1, cx0:cx1]
            proc = sharpen_image_belljar(crop, radius, amount, equalize)
            oy, ox = y0 - cy0, x0 - cx0
            th, tw = ye - y0, xe - x0
            out[y0:ye, x0:xe] = proc[oy : oy + th, ox : ox + tw]
            tiles_done += 1
            if tiles_done == 1 or tiles_done == tiles_total or tiles_done % 4 == 0:
                print(
                    f"LOG: sharpen_tiled progress {tiles_done}/{tiles_total}",
                    flush=True,
                )

    return out


def sharpen_image(img: np.ndarray, radius: float, amount: float, equalize: bool) -> np.ndarray:
    if img.ndim != 2:
        raise ValueError(f"expected 2D image, got ndim={img.ndim}")
    use_tiled = img.size > TILED_SHARPEN_PIXEL_THRESHOLD
    mode = "tiled" if use_tiled else "full"
    _log_debug(
        "sharpen_core",
        mode=mode,
        equalize=equalize,
        radius=radius,
        amount=amount,
        work_dtype=str(img.dtype),
        shape=f"{img.shape[0]}x{img.shape[1]}",
    )
    if use_tiled:
        print(f"LOG: sharpen_mode=tiled pixels={img.size}", flush=True)
        return _sharpen_image_tiled(img, radius, amount, equalize)
    print(f"LOG: sharpen_mode=full pixels={img.size}", flush=True)
    return sharpen_image_belljar(img, radius, amount, equalize)


def process_roi(
    img: np.ndarray, x: int, y: int, w: int, h: int, radius: float, amount: float, equalize: bool
) -> np.ndarray:
    pad = 32
    y0 = max(0, y - pad)
    x0 = max(0, x - pad)
    y1 = min(img.shape[0], y + h + pad)
    x1 = min(img.shape[1], x + w + pad)
    crop = img[y0:y1, x0:x1]
    out = sharpen_image(crop, radius, amount, equalize)
    oy = y - y0
    ox = x - x0
    return out[oy : oy + h, ox : ox + w]


def emit_preview_json(payload: dict) -> None:
    print("PREVIEW_JSON:" + json.dumps(payload), flush=True)


def run_preview(args) -> int:
    path = Path(args.image.strip())
    if not path.is_file():
        emit_preview_json({"ok": False, "error": "image not found"})
        return 1
    suffix = path.suffix.lower()
    source_kind = "png" if suffix == ".png" else "tiff"
    img = load_grayscale_native(path) if source_kind == "tiff" else load_grayscale_uint8(path)
    x, y, w, h = int(args.x), int(args.y), int(args.w), int(args.h)
    w = max(8, min(w, img.shape[1]))
    h = max(8, min(h, img.shape[0]))
    x = max(0, min(x, img.shape[1] - w))
    y = max(0, min(y, img.shape[0] - h))
    radius = float(args.radius or 3)
    amount = float(args.amount or 2)
    equalize = bool(args.equalize)
    _log_debug(
        "sharpen_preview",
        source_path=str(path.resolve()),
        source_kind=source_kind,
        roi=f"x={x} y={y} w={w} h={h}",
        display_stretch="on",
        input_dtype=str(img.dtype),
    )
    roi = process_roi(img, x, y, w, h, radius, amount, equalize)
    roi = stretch_preview_for_display(roi)
    out_dir = Path(args.preview_dir.strip()) if args.preview_dir else path.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "_sharpen_preview.png"
    cv2.imwrite(str(out_path), roi)
    emit_preview_json(
        {
            "ok": True,
            "previewPath": str(out_path.resolve()),
            "width": int(w),
            "height": int(h),
        }
    )
    return 0


from slice_input_files import list_input_files  # noqa: E402


def run_batch(args) -> int:
    if args.config:
        with open(args.config.strip(), encoding="utf-8") as f:
            cfg = json.load(f)
        input_path = Path(cfg.get("source_abs") or cfg.get("input_dir") or args.input)
        output_path = Path(cfg.get("output_abs") or cfg.get("output_dir") or args.output)
        amount = float(cfg.get("amount", 2))
        radius = float(cfg.get("radius", 3))
        equalize = bool(cfg.get("equalize", True))
        slice_list = cfg.get("slice_list") or args.slice_list
        signal_branch = cfg.get("signal_branch", "")
        source_run_rel = cfg.get("source_run_rel", "")
        source_kind = cfg.get("source_kind", "max")
    else:
        input_path = Path(args.input.strip())
        output_path = Path(args.output.strip())
        amount = float(args.amount.strip())
        radius = float(args.radius.strip())
        equalize = bool(args.equalize)
        slice_list = args.slice_list
        signal_branch = ""
        source_run_rel = ""
        source_kind = "max"

    output_path.mkdir(parents=True, exist_ok=True)
    input_files = list_input_files(input_path, slice_list)
    print(f"{len(input_files)}", flush=True)
    if not input_files:
        print("LOG: no input files", flush=True)
        return 1

    written = []
    for fpath in input_files:
        print(f"LOG: Processing {fpath.name}", flush=True)
        try:
            raw = tiff.imread(str(fpath))
            if raw.ndim > 2:
                raw = np.max(raw, axis=0)
            stats_in = _image_stats(raw)
            print(
                "LOG: sharpen_input "
                f"path={fpath.name} dtype={stats_in['dtype']} shape={tuple(raw.shape)} "
                f"min={stats_in['min']:.1f} max={stats_in['max']:.1f} "
                f"p50={stats_in['p50']:.1f} p95={stats_in['p95']:.1f}",
                flush=True,
            )
            out = sharpen_image(raw, radius, amount, equalize)
            stats_out = _image_stats(out)
            out_path = output_path / fpath.name
            tiff.imwrite(str(out_path), out)
            written.append(fpath.name)
            print(
                "LOG: sharpen_output "
                f"path={fpath.name} dtype={stats_out['dtype']} "
                f"min={stats_out['min']:.1f} max={stats_out['max']:.1f} "
                f"p50={stats_out['p50']:.1f} p95={stats_out['p95']:.1f}",
                flush=True,
            )
            print(f"LOG: sharpen_done {fpath.name}", flush=True)
        except Exception as e:
            print(f"LOG: Failed {fpath.name}: {e}", flush=True)
            traceback.print_exc()

    if not written:
        print(
            f"SHARPEN_NO_OUTPUT: 0 of {len(input_files)} files written.",
            flush=True,
        )
        print("Done!", flush=True)
        return 1

    print("Done!", flush=True)
    from run_manifest import write_run_manifest

    write_run_manifest(
        str(output_path),
        {
            "step": "sharpen",
            "input_dir": str(input_path),
            "input_files": written,
            "radius": radius,
            "amount": amount,
            "equalize": equalize,
            "signal_branch": signal_branch,
            "source_run_rel": source_run_rel,
            "source_kind": source_kind,
        },
    )
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process images with sharpen pipeline")
    parser.add_argument("-o", "--output", default="")
    parser.add_argument("-i", "--input", default="")
    parser.add_argument("-r", "--radius", default="3")
    parser.add_argument("-a", "--amount", default="2")
    parser.add_argument("-e", "--equalize", action="store_true", help="equalize histogram")
    parser.add_argument("-j", "--config", default="")
    parser.add_argument("--slice-list", default="")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--image", default="")
    parser.add_argument("--x", default="0")
    parser.add_argument("--y", default="0")
    parser.add_argument("--w", default="512")
    parser.add_argument("--h", default="512")
    parser.add_argument("--preview-dir", default="")
    args = parser.parse_args()

    if args.preview:
        sys.exit(run_preview(args))

    if args.config:
        sys.exit(run_batch(args))

    if args.input and args.output:
        sys.exit(run_batch(args))

    print("LOG: missing -j or -i/-o", flush=True)
    sys.exit(1)
