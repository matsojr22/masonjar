"""Apply per-slice rotation/flip geometry to CZI-derived TIFFs using OpenCV."""

from __future__ import annotations

import argparse
import sys
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


def transform_file(path: Path, ops: list) -> None:
    data = tiff.imread(str(path))
    arr = np.asarray(data)
    transformed = apply_ops_to_array(arr, ops)
    tiff.imwrite(str(path), transformed, photometric="minisblack")


def signal_branch_dirs_from_cfg(cfg: dict) -> set[str]:
    branches = {"somata", "nuclei", "axons"}
    for ch in cfg.get("channels") or []:
        branch = branch_for_channel(ch)
        if branch:
            branches.add(branch)
    return branches


def paths_for_slice(bundle_root: Path, slice_id: str, cfg: dict) -> list[Path]:
    paths: list[Path] = []
    dapi = bundle_root / CANONICAL_REL["dapi"] / f"{slice_id}.tif"
    if dapi.exists():
        paths.append(dapi)
    prev_dir = bundle_root / CANONICAL_REL["previews"]
    if prev_dir.exists():
        for p in prev_dir.glob(f"{slice_id}_*.tif"):
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

    # de-dupe
    seen = set()
    unique = []
    for p in paths:
        key = str(p.resolve())
        if key not in seen:
            seen.add(key)
            unique.append(p)
    return unique


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply geometry to CZI import outputs")
    parser.add_argument("-b", "--bundle", required=True)
    parser.add_argument("-j", "--json", required=True, help="Import config or geometry-only JSON")
    args = parser.parse_args()
    args.bundle = str(args.bundle).strip()
    args.json = str(args.json).strip()

    bundle_root = Path(args.bundle).resolve()
    try:
        cfg = load_import_config(args.json)
    except FileNotFoundError as exc:
        emit_result({"ok": False, "error": str(exc)})
        return 1
    geometry = cfg.get("geometry") or {}
    if not geometry:
        emit_result({"ok": True, "changed": 0})
        print("Done!", flush=True)
        return 0

    slice_ids = sorted(geometry.keys())
    print(len(slice_ids), flush=True)
    changed = 0
    for i, slice_id in enumerate(slice_ids):
        spec = geometry[slice_id] or {}
        ops = compose_ops(spec.get("rotate", 0), spec.get("flipX"), spec.get("flipY"))
        if not ops:
            continue
        targets = paths_for_slice(bundle_root, slice_id, cfg)
        for tpath in targets:
            transform_file(tpath, ops)
            changed += 1
        print(f"Applied geometry to {slice_id}", flush=True)

    emit_result({"ok": True, "changed": changed})
    print("Done!", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
