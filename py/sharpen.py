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


def load_grayscale(path: Path) -> np.ndarray:
    suffix = path.suffix.lower()
    if suffix == ".png":
        img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise ValueError(f"could not read {path}")
        return img
    img = tiff.imread(str(path))
    if img.ndim > 2:
        img = np.max(img, axis=0)
    return img


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


def sharpen_image(img: np.ndarray, radius: float, amount: float, equalize: bool) -> np.ndarray:
    if equalize:
        clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8))
        img = clahe.apply(img.astype(np.uint8) if img.dtype == np.uint8 else img.astype(np.uint8))
        img = enhance_contrast(img)
    original_dtype = img.dtype
    img = unsharp_mask(img, radius=radius, amount=amount, preserve_range=True)
    img = white_tophat(img, disk(15))
    return img.astype(original_dtype)


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
    if out.dtype != np.uint8:
        out = np.clip(out, 0, 255).astype(np.uint8)
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
    img = load_grayscale(path)
    if img.dtype == np.uint16:
        img = (img / 256).astype(np.uint8)
    x, y, w, h = int(args.x), int(args.y), int(args.w), int(args.h)
    w = max(8, min(w, img.shape[1]))
    h = max(8, min(h, img.shape[0]))
    x = max(0, min(x, img.shape[1] - w))
    y = max(0, min(y, img.shape[0] - h))
    radius = float(args.radius or 3)
    amount = float(args.amount or 2)
    equalize = bool(args.equalize)
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
            img = load_grayscale(fpath)
            out = sharpen_image(img, radius, amount, equalize)
            if out.dtype == np.uint16:
                out = (out / 256).astype(np.uint8)
            elif out.dtype != np.uint8:
                out = np.clip(out, 0, 255).astype(np.uint8)
            out_path = output_path / fpath.name
            tiff.imwrite(str(out_path), out)
            written.append(fpath.name)
        except Exception as e:
            print(f"LOG: Failed {fpath.name}: {e}", flush=True)
            traceback.print_exc()

    if not written:
        # Inputs existed (guarded above) but every file failed to write.
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
