"""Per-slice tissue edge masking for Mason Jar bundles."""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import tifffile as tiff

from bundle_slice_paths import paths_for_slice
from czi_common import emit_log, emit_result, load_import_config
from tissue_mask import isolate_tissue_mask

VALID_EXTENSIONS = {".png", ".tif", ".tiff"}
TRACE_WIDTH = 12


def load_grayscale_u8(path: Path) -> np.ndarray:
    suffix = path.suffix.lower()
    if suffix in {".tif", ".tiff"}:
        img = tiff.imread(str(path))
    else:
        img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if img is None:
            raise ValueError(f"Could not read {path}")
    if img.ndim == 3:
        if img.shape[2] >= 3:
            img = cv2.cvtColor(
                img,
                cv2.COLOR_BGR2GRAY if img.shape[2] == 3 else cv2.COLOR_BGRA2GRAY,
            )
        else:
            img = img[..., 0]
    elif img.ndim > 2:
        img = np.max(img, axis=0)
    arr = np.asarray(img)
    if np.issubdtype(arr.dtype, np.floating):
        if arr.max() <= 1.0:
            arr = arr * 255.0
        elif arr.max() > 255.0:
            arr = arr * (255.0 / float(arr.max()))
    elif arr.max() > 255:
        arr = arr.astype(np.float64) / float(arr.max()) * 255.0
    return np.clip(arr, 0, 255).astype(np.uint8)


def bool_mask_to_keep_u8(mask: np.ndarray) -> np.ndarray:
    return (mask.astype(bool).astype(np.uint8) * 255)


def auto_keep_mask(gray_u8: np.ndarray) -> np.ndarray:
    return bool_mask_to_keep_u8(isolate_tissue_mask(gray_u8))


def _stroke_mask_from_points(
    shape: tuple[int, int], stroke_points: list[tuple[int, int]], width: int = TRACE_WIDTH
) -> np.ndarray:
    h, w = shape
    stroke = np.zeros((h, w), dtype=np.uint8)
    if not stroke_points:
        return stroke
    pts = np.array(stroke_points, dtype=np.int32)
    if len(pts) == 1:
        cv2.circle(stroke, tuple(int(v) for v in pts[0]), max(3, width // 2), 255, -1)
        return stroke
    for i in range(len(pts) - 1):
        p0 = tuple(int(v) for v in pts[i])
        p1 = tuple(int(v) for v in pts[i + 1])
        cv2.line(stroke, p0, p1, 255, thickness=width)
    return stroke


def guided_keep_mask(gray_u8: np.ndarray, stroke_points: list[tuple[int, int]]) -> np.ndarray:
    h, w = gray_u8.shape
    stroke = _stroke_mask_from_points((h, w), stroke_points)
    if stroke.max() == 0:
        return auto_keep_mask(gray_u8)

    ys, xs = np.where(stroke > 0)
    pad = 20
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(w, int(xs.max()) + pad + 1)
    y1 = min(h, int(ys.max()) + pad + 1)

    roi_gray = gray_u8[y0:y1, x0:x1]
    roi_stroke = stroke[y0:y1, x0:x1]
    gc_mask = np.full(roi_gray.shape, cv2.GC_BGD, dtype=np.uint8)
    gc_mask[roi_stroke > 0] = cv2.GC_FGD

    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(
            roi_gray,
            gc_mask,
            None,
            bgd_model,
            fgd_model,
            5,
            cv2.GC_INIT_WITH_MASK,
        )
        fg = np.where(
            (gc_mask == cv2.GC_FGD) | (gc_mask == cv2.GC_PR_FGD),
            255,
            0,
        ).astype(np.uint8)
        if int(np.count_nonzero(fg)) < 64:
            raise ValueError("GrabCut foreground too small")
        full = np.full((h, w), 255, dtype=np.uint8)
        full[y0:y1, x0:x1] = fg
        return full
    except Exception:
        local = isolate_tissue_mask(roi_gray)
        full = np.full((h, w), 255, dtype=np.uint8)
        full[y0:y1, x0:x1] = bool_mask_to_keep_u8(local)
        return full


def border_median_bg(arr2d: np.ndarray) -> float:
    h, w = arr2d.shape[:2]
    if h < 2 or w < 2:
        return 15.0
    border = np.concatenate(
        [
            arr2d[0, :].ravel(),
            arr2d[-1, :].ravel(),
            arr2d[1:-1, 0].ravel(),
            arr2d[1:-1, -1].ravel(),
        ]
    )
    if border.size == 0:
        return 15.0
    return float(np.median(border))


def resize_keep_mask_nearest(keep_mask: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    target_h, target_w = shape
    if keep_mask.shape == (target_h, target_w):
        return keep_mask.astype(np.uint8)
    resized = cv2.resize(
        keep_mask.astype(np.uint8),
        (target_w, target_h),
        interpolation=cv2.INTER_NEAREST,
    )
    return (resized >= 128).astype(np.uint8) * 255


def apply_keep_mask_to_array(arr: np.ndarray, keep_mask: np.ndarray, bg: float) -> np.ndarray:
    if arr.ndim == 2:
        mask = resize_keep_mask_nearest(keep_mask, arr.shape)
        out = arr.copy()
        removed = mask < 128
        if np.issubdtype(out.dtype, np.floating):
            out[removed] = bg
        else:
            out[removed] = int(round(bg))
        return out
    if arr.ndim == 3:
        planes = [apply_keep_mask_to_array(arr[z], keep_mask, bg) for z in range(arr.shape[0])]
        return np.stack(planes, axis=0)
    raise ValueError(f"Unsupported ndim={arr.ndim}")


def mask_is_all_keep(keep_mask: np.ndarray) -> bool:
    return int(np.min(keep_mask)) >= 128


def composited_preview(gray_u8: np.ndarray, keep_mask: np.ndarray) -> np.ndarray:
    rgb = cv2.cvtColor(gray_u8, cv2.COLOR_GRAY2BGR)
    removed = keep_mask < 128
    overlay = rgb.copy()
    overlay[removed, 2] = np.minimum(255, overlay[removed, 2].astype(np.int32) + 120)
    overlay[removed, 0] = np.maximum(0, overlay[removed, 0].astype(np.int32) - 40)
    overlay[removed, 1] = np.maximum(0, overlay[removed, 1].astype(np.int32) - 40)
    return cv2.addWeighted(rgb, 0.55, overlay, 0.45, 0)


def emit_preview_json(payload: dict) -> None:
    print("PREVIEW_JSON:" + json.dumps(payload), flush=True)


def _read_image_array(path: Path) -> np.ndarray:
    if path.suffix.lower() == ".png":
        img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if img is None:
            raise ValueError(f"Could not read {path}")
        return np.asarray(img)
    return np.asarray(tiff.imread(str(path)))


def _write_image_array(path: Path, arr: np.ndarray) -> None:
    parts = {p.lower() for p in path.parts}
    if "00_dapi" in parts and path.suffix.lower() != ".png":
        raise ValueError(f"00_dapi accepts PNG only, not {path}")
    if path.suffix.lower() == ".png":
        cv2.imwrite(str(path), arr)
        return
    tiff.imwrite(str(path), arr, photometric="minisblack")


def _encode_png_base64(path: Path) -> str:
    data = path.read_bytes()
    return base64.b64encode(data).decode("ascii")


def _load_cfg(config: dict, bundle_root: Path) -> dict:
    cfg_path = config.get("czi_config") or config.get("import_config")
    if cfg_path:
        try:
            return load_import_config(cfg_path)
        except FileNotFoundError:
            emit_log(f"tissue_cleanup: import config not found: {cfg_path}")
    return config.get("channels") and config or {}


def _backup_file(src: Path, backup_root: Path, bundle_root: Path) -> None:
    try:
        rel = src.relative_to(bundle_root)
    except ValueError:
        rel = Path(src.name)
    dest = backup_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        shutil.copy2(src, dest)


def apply_masks_batch(bundle_root: Path, config: dict) -> dict:
    started = time.monotonic()
    bundle_root = bundle_root.resolve()
    slices_cfg = config.get("slices") or {}
    dry_run = bool(config.get("dry_run"))
    backup_root = bundle_root / ".masonjar" / "tissue_cleanup_backup"
    cfg = _load_cfg(config, bundle_root)

    jobs: list[tuple[str, Path, np.ndarray, float | None]] = []
    for slice_id, spec in slices_cfg.items():
        mask_path = Path(str(spec.get("mask_path", "")).strip())
        if not mask_path.is_file():
            emit_log(f"tissue_cleanup: skip {slice_id} — mask missing")
            continue
        keep_mask = load_grayscale_u8(mask_path)
        if mask_is_all_keep(keep_mask):
            emit_log(f"tissue_cleanup: skip {slice_id} — unchanged mask")
            continue
        bg_override = spec.get("bg_value")
        bg = float(bg_override) if bg_override is not None else None
        jobs.append((slice_id, mask_path, keep_mask, bg))

    targets: list[tuple[str, Path]] = []
    for slice_id, _mask_path, _keep, _bg in jobs:
        for tpath in paths_for_slice(bundle_root, slice_id, cfg):
            targets.append((slice_id, tpath))

    total_files = len(targets)
    emit_log(f"tissue_cleanup apply: {len(jobs)} slice(s), {total_files} file(s)")
    print(total_files, flush=True)

    manifest_slices: dict = {}
    applied = 0
    skipped = 0
    failed: list[str] = []
    file_index = 0

    job_by_slice = {sid: (mask, bg) for sid, _mp, mask, bg in jobs}

    for slice_id, tpath in targets:
        file_index += 1
        keep_mask, bg_override = job_by_slice[slice_id]
        try:
            rel = tpath.relative_to(bundle_root)
        except ValueError:
            rel = Path(tpath.name)
        emit_log(f"[{file_index}/{total_files}] read {rel}")
        try:
            if dry_run:
                skipped += 1
                print(f"Dry-run [{file_index}/{total_files}] {rel}", flush=True)
                continue
            arr = _read_image_array(tpath)
            if arr.ndim == 2:
                bg = bg_override if bg_override is not None else border_median_bg(arr)
            elif arr.ndim == 3:
                bg = bg_override if bg_override is not None else border_median_bg(arr[0])
            else:
                raise ValueError(f"Unsupported ndim={arr.ndim}")
            _backup_file(tpath, backup_root, bundle_root)
            out = apply_keep_mask_to_array(arr, keep_mask, bg)
            _write_image_array(tpath, out)
            applied += 1
            entry = manifest_slices.setdefault(
                slice_id,
                {
                    "method": slices_cfg.get(slice_id, {}).get("method", "mixed"),
                    "files_touched": [],
                },
            )
            entry["files_touched"].append(str(rel))
            print(f"Applied tissue mask [{file_index}/{total_files}] {rel}", flush=True)
        except Exception as exc:
            failed.append(f"{rel}: {exc}")
            emit_log(f"[{file_index}/{total_files}] FAILED {rel}: {exc}")

    elapsed = round(time.monotonic() - started, 2)
    return {
        "ok": len(failed) == 0,
        "applied_files": applied,
        "skipped_files": skipped,
        "failed": failed,
        "files_total": total_files,
        "slices_applied": len(manifest_slices),
        "elapsed_sec": elapsed,
        "slices": manifest_slices,
    }


def _preview_mask_out_path(args, preview_path: Path) -> Path:
    if getattr(args, "output", None) and str(args.output).strip():
        return Path(str(args.output).strip())
    out_dir = getattr(args, "output_dir", None)
    if out_dir and str(out_dir).strip():
        return Path(str(out_dir).strip()) / "_tissue_mask.png"
    return preview_path.parent / "_tissue_mask.png"


def run_auto_preview(args) -> int:
    preview_path = Path(args.input.strip())
    if not preview_path.is_file():
        emit_preview_json({"ok": False, "error": "preview not found"})
        return 1
    gray = load_grayscale_u8(preview_path)
    keep = auto_keep_mask(gray)
    out_mask = _preview_mask_out_path(args, preview_path)
    out_mask.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_mask), keep)
    preview_out = out_mask.parent / "_tissue_preview.png"
    cv2.imwrite(str(preview_out), composited_preview(gray, keep))
    emit_preview_json(
        {
            "ok": True,
            "maskPath": str(out_mask.resolve()),
            "previewPath": str(preview_out.resolve()),
            "maskBase64": _encode_png_base64(out_mask),
            "width": int(gray.shape[1]),
            "height": int(gray.shape[0]),
        }
    )
    return 0


def run_guided_preview(args) -> int:
    preview_path = Path(args.input.strip())
    if not preview_path.is_file():
        emit_preview_json({"ok": False, "error": "preview not found"})
        return 1
    stroke_path = Path(args.stroke_json.strip())
    if not stroke_path.is_file():
        emit_preview_json({"ok": False, "error": "stroke JSON not found"})
        return 1
    with open(stroke_path, encoding="utf-8") as f:
        stroke_raw = json.load(f)
    if isinstance(stroke_raw, dict):
        stroke_raw = stroke_raw.get("points") or stroke_raw.get("stroke") or []
    stroke_points = [(int(p[0]), int(p[1])) for p in stroke_raw]
    gray = load_grayscale_u8(preview_path)
    keep = guided_keep_mask(gray, stroke_points)
    out_mask = _preview_mask_out_path(args, preview_path)
    out_mask.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_mask), keep)
    preview_out = out_mask.parent / "_tissue_preview.png"
    cv2.imwrite(str(preview_out), composited_preview(gray, keep))
    emit_preview_json(
        {
            "ok": True,
            "maskPath": str(out_mask.resolve()),
            "previewPath": str(preview_out.resolve()),
            "maskBase64": _encode_png_base64(out_mask),
            "width": int(gray.shape[1]),
            "height": int(gray.shape[0]),
        }
    )
    return 0


def run_apply(args) -> int:
    bundle_root = Path(args.bundle.strip()).resolve()
    config_path = Path(args.json.strip())
    if not config_path.is_file():
        emit_result({"ok": False, "error": f"Config not found: {config_path}"})
        return 1
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)
    result = apply_masks_batch(bundle_root, config)
    manifest_path = bundle_root / ".masonjar" / "tissue_cleanup_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    emit_result(result)
    print("Done!", flush=True)
    return 0 if result.get("ok") else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Tissue edge cleanup masks for Mason Jar")
    parser.add_argument("--auto", action="store_true", help="Auto tissue mask on preview")
    parser.add_argument("--guided", action="store_true", help="Trace-guided GrabCut mask")
    parser.add_argument("--apply", action="store_true", help="Apply confirmed masks to bundle")
    parser.add_argument("-i", "--input", help="Preview image path")
    parser.add_argument("-o", "--output", help="Output keep-mask PNG path")
    parser.add_argument(
        "--output-dir",
        help="Directory for preview mask outputs (uses _tissue_mask.png)",
    )
    parser.add_argument("--stroke-json", help="JSON list of [x,y] stroke points")
    parser.add_argument("-b", "--bundle", help="Bundle root for apply")
    parser.add_argument("-j", "--json", help="Apply config JSON path")
    args = parser.parse_args()

    if args.apply:
        if not args.bundle or not args.json:
            emit_result({"ok": False, "error": "apply requires -b and -j"})
            return 1
        return run_apply(args)
    if args.guided:
        if not args.input or not args.stroke_json:
            emit_preview_json({"ok": False, "error": "guided requires -i and --stroke-json"})
            return 1
        return run_guided_preview(args)
    if args.auto:
        if not args.input:
            emit_preview_json({"ok": False, "error": "auto requires -i"})
            return 1
        return run_auto_preview(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
