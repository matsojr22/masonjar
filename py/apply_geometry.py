"""Apply per-slice rotation/flip geometry to CZI-derived TIFFs and PNG previews."""

from __future__ import annotations

import pipeline_io_bootstrap  # noqa: F401
import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import tifffile as tiff

from bundle_slice_paths import paths_for_slice, signal_branch_dirs_from_cfg
from czi_common import CANONICAL_REL, emit_log, emit_result, load_import_config
from geometry_apply_progress import (
    clear_progress,
    is_completed,
    load_progress,
    path_key,
    record_completion,
    write_last_result,
)


def compose_ops(rotate: int, flip_x: bool, flip_y: bool):
    ops = []
    rot = int(rotate or 0) % 360
    if rot in (90, 180, 270):
        ops.append(("rotate", rot))
    if flip_x:
        ops.append(("flip_x", True))
    if flip_y:
        ops.append(("flip_y", True))
    return ops


def ops_from_string_list(op_list: list) -> list:
    """Map JS geometry.ops entries (rot90, flipX, flipY) to internal op tuples."""
    ops: list = []
    for entry in op_list or []:
        if entry == "rot90":
            ops.append(("rotate", 90))
        elif entry == "flipX":
            ops.append(("flip_x", True))
        elif entry == "flipY":
            ops.append(("flip_y", True))
    return ops


def compose_ops_from_spec(spec: dict) -> list:
    """Use ordered spec.ops when present; else legacy rotate/flip flags."""
    if not spec:
        return []
    raw_ops = spec.get("ops")
    if raw_ops:
        return ops_from_string_list(raw_ops)
    return compose_ops(spec.get("rotate", 0), spec.get("flipX"), spec.get("flipY"))


def apply_ops_to_array(arr: np.ndarray, ops: list) -> np.ndarray:
    # Rotation k matches CSS clockwise in js/orient_geometry.js geometryCssTransform.
    out = arr
    for op, val in ops:
        if op == "rotate":
            if val == 90:
                out = np.rot90(out, k=-1)
            elif val == 180:
                out = np.rot90(out, k=2)
            elif val == 270:
                out = np.rot90(out, k=1)
        elif op == "flip_x":
            out = np.fliplr(out)
        elif op == "flip_y":
            out = np.flipud(out)
    return out


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


def transform_file(path: Path, ops: list) -> tuple[np.ndarray, np.ndarray]:
    arr = _read_image_array(path)
    if arr.ndim == 2:
        transformed = apply_ops_to_array(arr, ops)
    elif arr.ndim == 3:
        planes = [apply_ops_to_array(arr[z], ops) for z in range(arr.shape[0])]
        transformed = np.stack(planes, axis=0)
    else:
        raise ValueError(f"Unsupported ndim={arr.ndim} for {path.name}")
    _write_image_array(path, transformed)
    return arr, transformed


def collect_geometry_jobs(
    bundle_root: Path,
    geometry: dict,
    cfg: dict,
) -> list[tuple[str, list, list[Path]]]:
    jobs: list[tuple[str, list, list[Path]]] = []
    for slice_id in sorted(geometry.keys()):
        spec = geometry[slice_id] or {}
        ops = compose_ops_from_spec(spec)
        if not ops:
            continue
        targets = paths_for_slice(bundle_root, slice_id, cfg)
        if targets:
            jobs.append((slice_id, ops, targets))
    return jobs


def _file_kind(path: Path) -> str:
    if path.suffix.lower() == ".png":
        return "PNG"
    return "TIFF"


def _describe_target(path: Path) -> str:
    size = path.stat().st_size if path.is_file() else 0
    kind = _file_kind(path)
    detail = f"{kind} {size} bytes"
    if kind == "TIFF":
        try:
            arr = np.asarray(tiff.imread(str(path)))
            if arr.ndim == 2:
                detail += f" 2D {arr.dtype} {arr.shape[1]}x{arr.shape[0]}"
            elif arr.ndim == 3:
                detail += f" Z-stack {arr.dtype} Z={arr.shape[0]} {arr.shape[2]}x{arr.shape[1]}"
            else:
                detail += f" ndim={arr.ndim} {arr.dtype}"
        except Exception as exc:
            detail += f" (read meta failed: {exc})"
    else:
        try:
            img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
            if img is not None:
                arr = np.asarray(img)
                detail += f" 2D {arr.dtype} {arr.shape[1]}x{arr.shape[0]}"
        except Exception as exc:
            detail += f" (read meta failed: {exc})"
    return detail


def preflight_log(jobs: list[tuple[str, list, list[Path]]], bundle_root: Path) -> int:
    total_bytes = 0
    total_files = sum(len(targets) for _, _, targets in jobs)
    emit_log(f"Preflight: {len(jobs)} slice(s), {total_files} file(s) to transform")
    for slice_id, _ops, targets in jobs:
        for tpath in targets:
            try:
                rel = tpath.relative_to(bundle_root)
            except ValueError:
                rel = Path(tpath.name)
            size = tpath.stat().st_size if tpath.is_file() else 0
            total_bytes += size
            emit_log(f"  {rel}: {_describe_target(tpath)}")
    emit_log(f"Preflight total: {total_files} files, {total_bytes} bytes")
    return total_files


def _ops_from_js_list(op_list: list) -> list:
    return ops_from_string_list(op_list)


def collect_repair_jobs(bundle_root: Path, cfg: dict) -> list[tuple[str, list, Path, str]]:
    """(slice_id, ops, path, strategy) from repair_targets."""
    jobs: list[tuple[str, list, Path, str]] = []
    for target in cfg.get("repair_targets") or []:
        strategy = str(target.get("strategy") or "derivatives_from_original")
        if strategy == "skip":
            continue
        slice_id = str(target.get("slice_id") or "")
        rel = str(target.get("rel_path") or "").strip()
        if not rel:
            continue
        op_list = target.get("ops") or []
        ops = _ops_from_js_list(op_list) if op_list else []
        path = bundle_root / rel
        if strategy == "transform_original":
            branch = str(target.get("branch") or "")
            if branch:
                orig = bundle_root / CANONICAL_REL["original_scans"] / branch / f"{slice_id}.tif"
                if orig.is_file():
                    path = orig
        jobs.append((slice_id, ops, path, strategy))
    return jobs


def run_transform_jobs(
    bundle_root: Path,
    jobs: list[tuple[str, list, list[Path]]],
    progress: dict | None,
    resume: bool,
) -> tuple[int, int, list[str], int]:
    total_files = sum(len(targets) for _, _, targets in jobs)
    changed = 0
    bytes_total = 0
    failed: list[str] = []
    file_index = 0

    for slice_id, ops, targets in jobs:
        for tpath in targets:
            rel_k = path_key(bundle_root, tpath)
            if resume and progress and is_completed(progress, rel_k):
                emit_log(f"skip completed {rel_k}")
                file_index += 1
                continue
            file_index += 1
            try:
                rel = tpath.relative_to(bundle_root)
            except ValueError:
                rel = Path(tpath.name)
            kind = _file_kind(tpath)
            size_before = tpath.stat().st_size if tpath.is_file() else 0
            emit_log(
                f"[{file_index}/{total_files}] read {rel} ({kind}, {size_before} bytes)",
            )
            read_start = time.monotonic()
            try:
                _before, after = transform_file(tpath, ops)
                read_elapsed = time.monotonic() - read_start
                if after.ndim == 2:
                    shape_desc = f"{after.shape[1]}x{after.shape[0]} {after.dtype}"
                elif after.ndim == 3:
                    shape_desc = f"Z={after.shape[0]} {after.shape[2]}x{after.shape[1]} {after.dtype}"
                else:
                    shape_desc = f"ndim={after.ndim} {after.dtype}"
                size_after = tpath.stat().st_size if tpath.is_file() else 0
                write_elapsed = time.monotonic() - read_start - read_elapsed
                emit_log(
                    f"[{file_index}/{total_files}] wrote {rel} ({shape_desc}, "
                    f"{size_after} bytes, read {read_elapsed:.2f}s write {write_elapsed:.2f}s)",
                )
                changed += 1
                bytes_total += size_after
                print(f"Applied geometry [{file_index}/{total_files}] {rel}", flush=True)
                if progress is not None:
                    record_completion(bundle_root, progress, rel_k, slice_id)
            except Exception as exc:
                failed.append(f"{rel}: {exc}")
                emit_log(f"[{file_index}/{total_files}] FAILED {rel}: {exc}")
                print(f"Failed geometry [{file_index}/{total_files}] {rel}", flush=True)

    return changed, bytes_total, failed, total_files


def run_repair_jobs(bundle_root: Path, cfg: dict) -> tuple[int, int, list[str], int]:
    jobs = collect_repair_jobs(bundle_root, cfg)
    total_files = len(jobs)
    emit_log(f"Geometry repair: {total_files} target(s)")
    print(total_files, flush=True)
    changed = 0
    bytes_total = 0
    failed: list[str] = []
    for i, (slice_id, ops, tpath, strategy) in enumerate(jobs):
        idx = i + 1
        try:
            rel = tpath.relative_to(bundle_root)
        except ValueError:
            rel = Path(tpath.name)
        if strategy == "skip" or not tpath.is_file():
            emit_log(f"[{idx}/{total_files}] skip {rel}")
            continue
        emit_log(f"[{idx}/{total_files}] repair {strategy} {rel}")
        try:
            if ops:
                _before, after = transform_file(tpath, ops)
            else:
                after = _read_image_array(tpath)
            changed += 1
            bytes_total += tpath.stat().st_size if tpath.is_file() else 0
            print(f"Repaired geometry [{idx}/{total_files}] {rel}", flush=True)
        except Exception as exc:
            failed.append(f"{rel}: {exc}")
            emit_log(f"[{idx}/{total_files}] FAILED {rel}: {exc}")
    return changed, bytes_total, failed, total_files


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply geometry to CZI import outputs")
    parser.add_argument("-b", "--bundle", required=True)
    parser.add_argument("-j", "--json", required=True, help="Import config or geometry-only JSON")
    args = parser.parse_args()
    args.bundle = str(args.bundle).strip()
    args.json = str(args.json).strip()

    started = time.monotonic()
    bundle_root = Path(args.bundle).resolve()
    try:
        cfg = load_import_config(args.json)
    except FileNotFoundError as exc:
        emit_result({"ok": False, "error": str(exc)})
        return 1

    repair_mode = cfg.get("repair_mode")
    geometry_hash = str(cfg.get("geometry_hash") or "")
    config_fingerprint = str(cfg.get("config_fingerprint") or "")
    resume = bool(cfg.get("resume_apply"))

    if repair_mode == "geometry":
        changed, bytes_total, failed, total_files = run_repair_jobs(bundle_root, cfg)
        elapsed = time.monotonic() - started
        result = {
            "ok": len(failed) == 0,
            "changed": changed,
            "files_total": total_files,
            "bytes_total": bytes_total,
            "elapsed_sec": round(elapsed, 2),
            "failed": failed,
            "repair_mode": "geometry",
        }
        write_last_result(bundle_root, {**result, "geometry_hash": geometry_hash, "config_fingerprint": config_fingerprint})
        emit_result(result)
        print("Done!", flush=True)
        return 0 if not failed else 1

    geometry = cfg.get("geometry") or {}
    if not geometry:
        emit_result({"ok": True, "changed": 0, "files_total": 0, "bytes_total": 0, "elapsed_sec": 0})
        print("Done!", flush=True)
        return 0

    jobs = collect_geometry_jobs(bundle_root, geometry, cfg)
    total_files = preflight_log(jobs, bundle_root)
    print(total_files, flush=True)

    progress = load_progress(bundle_root)
    if progress and (
        progress.get("geometry_hash") != geometry_hash
        or progress.get("config_fingerprint") != config_fingerprint
    ):
        progress = None
    if not resume or not progress:
        progress = {
            "config_fingerprint": config_fingerprint,
            "geometry_hash": geometry_hash,
            "files_total": total_files,
            "completed": 0,
            "completed_paths": [],
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        from geometry_apply_progress import save_progress

        save_progress(bundle_root, progress)
    else:
        emit_log(f"Resuming apply: {progress.get('completed', 0)}/{total_files} already done")

    changed, bytes_total, failed, _ = run_transform_jobs(bundle_root, jobs, progress, resume)

    elapsed = time.monotonic() - started
    result = {
        "ok": len(failed) == 0,
        "changed": changed,
        "files_total": total_files,
        "bytes_total": bytes_total,
        "elapsed_sec": round(elapsed, 2),
        "failed": failed,
    }
    write_last_result(
        bundle_root,
        {**result, "geometry_hash": geometry_hash, "config_fingerprint": config_fingerprint},
    )
    if result["ok"]:
        clear_progress(bundle_root)
    emit_result(result)
    print("Done!", flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
