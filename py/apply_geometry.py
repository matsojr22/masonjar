"""Apply per-slice rotation/flip geometry to CZI-derived TIFFs and PNG previews."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import tifffile as tiff

from czi_common import (
    CANONICAL_REL,
    ROLE_DAPI,
    ROLE_UNUSED,
    branch_for_channel,
    branch_for_role_key,
    emit_log,
    emit_result,
    load_import_config,
    meta_state_path,
    role_key_for_channel,
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


def apply_ops_to_array(arr: np.ndarray, ops: list) -> np.ndarray:
    out = arr
    for op, val in ops:
        if op == "rotate":
            if val == 90:
                out = np.rot90(out, k=1)
            elif val == 180:
                out = np.rot90(out, k=2)
            elif val == 270:
                out = np.rot90(out, k=3)
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


def signal_branch_dirs_from_cfg(cfg: dict) -> set[str]:
    branches = {"somata", "nuclei", "axons"}
    for ch in cfg.get("channels") or []:
        branch = branch_for_channel(ch)
        if branch:
            branches.add(branch)
    return branches


def paths_for_slice(bundle_root: Path, slice_id: str, cfg: dict) -> list[Path]:
    paths: list[Path] = []
    dapi_png = bundle_root / CANONICAL_REL["dapi"] / f"{slice_id}.png"
    if dapi_png.exists():
        paths.append(dapi_png)
    prev_dir = bundle_root / CANONICAL_REL["previews"]
    if prev_dir.exists():
        for p in prev_dir.glob(f"{slice_id}_*.png"):
            paths.append(p)
    orig_base = bundle_root / CANONICAL_REL["original_scans"]
    for sub in sorted(signal_branch_dirs_from_cfg(cfg)):
        candidate = orig_base / sub / f"{slice_id}.tif"
        if candidate.exists():
            paths.append(candidate)
    flat_candidate = orig_base / f"{slice_id}.tif"
    if flat_candidate.exists():
        paths.append(flat_candidate)

    max_runs = (cfg.get("max_runs") or {}) if isinstance(cfg, dict) else {}
    if not max_runs:
        state_path = meta_state_path(bundle_root)
        if state_path.exists():
            import json

            with open(state_path, encoding="utf-8") as f:
                st = json.load(f)
            max_runs = st.get("max_runs") or {}

    role_keys = set(max_runs.keys())
    for ch in cfg.get("channels") or []:
        if ch.get("keep") and ch.get("role") not in (ROLE_DAPI, ROLE_UNUSED):
            role_keys.add(role_key_for_channel(ch))

    for role_key in role_keys:
        rel = max_runs.get(role_key)
        if rel:
            candidate = bundle_root / CANONICAL_REL["max"] / rel / f"{slice_id}.tif"
            if candidate.exists():
                paths.append(candidate)
            continue
        branch = branch_for_role_key(role_key)
        if not branch:
            continue
        max_root = bundle_root / CANONICAL_REL["max"] / branch / "max"
        if not max_root.exists():
            continue
        for run_dir in sorted(max_root.iterdir()):
            if run_dir.is_dir():
                candidate = run_dir / f"{slice_id}.tif"
                if candidate.exists():
                    paths.append(candidate)

    seen = set()
    unique = []
    for p in paths:
        key = str(p.resolve())
        if key not in seen:
            seen.add(key)
            unique.append(p)
    return unique


def collect_geometry_jobs(
    bundle_root: Path,
    geometry: dict,
    cfg: dict,
) -> list[tuple[str, list, list[Path]]]:
    jobs: list[tuple[str, list, list[Path]]] = []
    for slice_id in sorted(geometry.keys()):
        spec = geometry[slice_id] or {}
        ops = compose_ops(spec.get("rotate", 0), spec.get("flipX"), spec.get("flipY"))
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
    geometry = cfg.get("geometry") or {}
    if not geometry:
        emit_result({"ok": True, "changed": 0, "files_total": 0, "bytes_total": 0, "elapsed_sec": 0})
        print("Done!", flush=True)
        return 0

    jobs = collect_geometry_jobs(bundle_root, geometry, cfg)
    total_files = preflight_log(jobs, bundle_root)
    print(total_files, flush=True)

    changed = 0
    bytes_total = 0
    failed: list[str] = []
    file_index = 0

    for slice_id, ops, targets in jobs:
        for tpath in targets:
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
            before = None
            try:
                before, after = transform_file(tpath, ops)
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
            except Exception as exc:
                failed.append(f"{rel}: {exc}")
                emit_log(f"[{file_index}/{total_files}] FAILED {rel}: {exc}")
                print(f"Failed geometry [{file_index}/{total_files}] {rel}", flush=True)

    elapsed = time.monotonic() - started
    emit_result(
        {
            "ok": len(failed) == 0,
            "changed": changed,
            "files_total": total_files,
            "bytes_total": bytes_total,
            "elapsed_sec": round(elapsed, 2),
            "failed": failed,
        }
    )
    print("Done!", flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
