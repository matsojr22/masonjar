#!/usr/bin/env python3
"""Post-run sharpen debug probe — compare input/output TIFF stats."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import tifffile as tiff


def _stats(arr: np.ndarray, label: str) -> dict:
    flat = np.asarray(arr).astype(np.float64).ravel()
    if flat.size == 0:
        return {"label": label, "dtype": str(arr.dtype), "shape": arr.shape, "count": 0}
    hist, edges = np.histogram(flat, bins=8)
    return {
        "label": label,
        "dtype": str(arr.dtype),
        "shape": tuple(arr.shape),
        "count": int(flat.size),
        "min": float(flat.min()),
        "max": float(flat.max()),
        "mean": float(flat.mean()),
        "std": float(flat.std()),
        "p50": float(np.percentile(flat, 50)),
        "p95": float(np.percentile(flat, 95)),
        "hist_bins": hist.tolist(),
        "hist_edges": [float(e) for e in edges],
    }


def _print_stats(s: dict) -> None:
    print(f"--- {s['label']} ---")
    print(f"  dtype={s['dtype']} shape={s['shape']} count={s['count']}")
    if s["count"] == 0:
        return
    print(
        f"  min={s['min']:.2f} max={s['max']:.2f} mean={s['mean']:.2f} std={s['std']:.2f}"
    )
    print(f"  p50={s['p50']:.2f} p95={s['p95']:.2f}")
    print(f"  hist={s['hist_bins']}")


def _load_2d(path: Path) -> np.ndarray:
    arr = tiff.imread(str(path))
    if arr.ndim > 2:
        arr = np.max(arr, axis=0)
    return arr


def main() -> int:
    parser = argparse.ArgumentParser(description="Sharpen input/output debug probe")
    parser.add_argument("--input", required=True, help="Source max TIFF")
    parser.add_argument("--output", required=True, help="Sharpened output TIFF")
    parser.add_argument("--preview", default="", help="Optional preview PNG")
    parser.add_argument(
        "--reference",
        default="",
        help="Optional Bell Jar reference output TIFF for diff stats",
    )
    args = parser.parse_args()

    inp = Path(args.input)
    out = Path(args.output)
    if not inp.is_file():
        print(f"ERROR: input not found: {inp}", file=sys.stderr)
        return 1
    if not out.is_file():
        print(f"ERROR: output not found: {out}", file=sys.stderr)
        return 1

    raw_in = _load_2d(inp)
    raw_out = _load_2d(out)
    _print_stats(_stats(raw_in, "input"))
    _print_stats(_stats(raw_out, "output"))

    if raw_in.shape == raw_out.shape:
        diff = raw_out.astype(np.float64) - raw_in.astype(np.float64)
        _print_stats(_stats(diff, "output_minus_input"))
    else:
        print("WARN: input/output shape mismatch — skip diff")

    if args.preview:
        prev_path = Path(args.preview)
        if prev_path.is_file():
            import cv2

            prev = cv2.imread(str(prev_path), cv2.IMREAD_GRAYSCALE)
            if prev is not None:
                _print_stats(_stats(prev, "preview_png"))
        else:
            print(f"WARN: preview not found: {prev_path}")

    if args.reference:
        ref_path = Path(args.reference)
        if ref_path.is_file():
            raw_ref = _load_2d(ref_path)
            _print_stats(_stats(raw_ref, "reference"))
            if raw_out.shape == raw_ref.shape:
                ref_diff = raw_out.astype(np.float64) - raw_ref.astype(np.float64)
                _print_stats(_stats(ref_diff, "output_minus_reference"))
        else:
            print(f"WARN: reference not found: {ref_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
