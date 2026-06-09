"""Extract CZI channels to z-stack TIFFs, previews, and max projections."""

from __future__ import annotations

import pipeline_io_bootstrap  # noqa: F401
import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from czi_common import (
    CANONICAL_REL,
    PREVIEW_FORMAT_VERSION,
    ROLE_DAPI,
    ROLE_SIGNAL_AXONS,
    ROLE_UNUSED,
    assess_mosaic_import,
    branch_for_channel,
    branch_for_role_key,
    clamp_preview_scale,
    collapse_z_stack_to_2d,
    dapi_preview_path,
    orient_dapi_preview_path,
    default_slice_id,
    dim_size,
    emit_log,
    emit_progress,
    emit_progress_phase,
    emit_result,
    load_import_config,
    max_input_dir,
    max_output_run_dir,
    meta_state_path,
    natural_sort_filenames,
    natural_sort_key,
    natural_sort_slice_ids,
    normalized_dim_blocks,
    original_scans_path,
    preview_autoscale_to_uint8,
    read_czi_plane,
    build_files_lookup,
    resolve_file_entry,
    role_key_for_channel,
    signal_preview_path,
    slice_order_ordinal_map,
    write_import_state,
    z_indices_with_data,
)
from run_manifest import write_run_manifest

# Populated by staged imports in main().
np = None
cv2 = None
tiff = None
CziFile = None


def downscale_plane(plane, scale: float):
    if scale >= 0.999:
        return plane
    h, w = plane.shape[:2]
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return cv2.resize(plane, (new_w, new_h), interpolation=cv2.INTER_AREA)


def max_project_z(stack):
    return collapse_z_stack_to_2d(stack)


def max_project_file(input_path: Path, output_path: Path, *, bit_depth: int = 8) -> None:
    img = tiff.imread(str(input_path))
    arr = np.asarray(img)
    parent = output_path.parent
    if not parent.exists():
        emit_log(f"  mkdir {parent}")
    parent.mkdir(parents=True, exist_ok=True)
    if arr.ndim <= 2:
        emit_log(f"  copy single plane -> {output_path.name}")
        out = coerce_stack_depth(arr, bit_depth)
        write_pipeline_tiff(output_path, out, bit_depth)
        return
    if arr.ndim == 3 and arr.shape[0] == 1:
        emit_log(f"  copy single Z plane -> {output_path.name}")
        out = coerce_stack_depth(arr[0], bit_depth)
        write_pipeline_tiff(output_path, out, bit_depth)
        return
    out = max_project_z(arr)
    out = coerce_stack_depth(out, bit_depth)
    write_pipeline_tiff(output_path, out, bit_depth)


def bit_depth_for_role(cfg: dict, role_key: str) -> int:
    by_role = cfg.get("bit_depth_by_role") or {}
    raw = by_role.get(role_key, 8)
    try:
        depth = int(raw)
    except (TypeError, ValueError):
        depth = 8
    if role_key != ROLE_SIGNAL_AXONS:
        return 8
    return 16 if depth == 16 else 8


def coerce_stack_depth(arr, bit_depth: int):
    work = np.asarray(arr)
    if bit_depth >= 16:
        if work.dtype == np.uint16:
            return work
        if np.issubdtype(work.dtype, np.floating):
            scaled = np.clip(work, 0, None)
            if scaled.max() <= 1.0:
                scaled = scaled * 65535.0
            elif scaled.max() <= 255.0:
                scaled = scaled * 257.0
            return np.clip(scaled, 0, 65535).astype(np.uint16)
        if work.dtype == np.uint8:
            return work.astype(np.uint16) * 257
        return np.clip(work, 0, 65535).astype(np.uint16)
    if work.dtype == np.uint8:
        return work
    if np.issubdtype(work.dtype, np.floating):
        if work.max() <= 1.0:
            return np.clip(work * 255.0, 0, 255).astype(np.uint8)
        return np.clip(work, 0, 255).astype(np.uint8)
    if work.dtype == np.uint16:
        return (work / 257).astype(np.uint8)
    return np.clip(work, 0, 255).astype(np.uint8)


def write_pipeline_tiff(path: Path, arr, bit_depth: int) -> None:
    out = coerce_stack_depth(arr, bit_depth)
    tiff.imwrite(str(path), out, photometric="minisblack")


def read_plane(czi, scene: int, z: int, channel: int):
    return read_czi_plane(czi, scene, z, channel)


def _preview_plane_from_stack(planes: list, z_indices: list[int]):
    """Pick brightest plane for preview (sparse counterstain / single focal plane)."""
    if not planes:
        return None
    if len(planes) == 1:
        return planes[0]
    import numpy as _np

    best = planes[0]
    best_score = -1.0
    for plane in planes:
        arr = _np.asarray(plane)
        if arr.size == 0:
            continue
        score = float(_np.percentile(arr, 99))
        if score > best_score:
            best_score = score
            best = plane
    return best


def extract_z_stack(
    czi,
    scene: int,
    channel: int,
    z_indices: list[int],
    out_path: Path,
    preview_path: Path | None,
    preview_scale: float,
    slice_id: str = "",
    bundle_root: Path | None = None,
    *,
    cfg: dict | None = None,
    role_key: str = "",
) -> None:
    planes = []
    n_z = len(z_indices)
    for i, z in enumerate(z_indices):
        emit_log(f"  Reading Z {i + 1}/{n_z} ({slice_id} ch {channel})")
        try:
            plane = read_plane(czi, scene, z, channel)
        except Exception as exc:
            sparse_n = len(z_indices)
            raise RuntimeError(
                f"CZI channel C={channel} Z={z} unsupported pixel type ({exc}). "
                f"Sparse-Z had {sparse_n} position(s). "
                "Try re-export from ZEN as 16-bit grayscale, or skip this channel."
            ) from exc
        planes.append(plane)
    h, w = planes[0].shape[:2] if planes else (0, 0)
    parent = out_path.parent
    if not parent.exists():
        emit_log(f"  mkdir {parent}")
    parent.mkdir(parents=True, exist_ok=True)
    if n_z == 1:
        emit_log(f"  Single Z plane ({h}x{w}), writing 2D TIFF (no z-stack)")
        depth = bit_depth_for_role(cfg or {}, role_key)
        write_pipeline_tiff(out_path, planes[0], depth)
    else:
        emit_log(f"  Stacking {n_z} planes ({h}x{w})")
        stack = np.stack(planes, axis=0)
        depth = bit_depth_for_role(cfg or {}, role_key)
        write_pipeline_tiff(out_path, stack, depth)
    try:
        rel = out_path.relative_to(bundle_root) if bundle_root else out_path.name
    except ValueError:
        rel = out_path.name
    if out_path.exists():
        approx_mb = out_path.stat().st_size / (1024 * 1024)
    else:
        nbytes = planes[0].nbytes if planes else 0
        approx_mb = nbytes / (1024 * 1024)
    emit_log(f"  Writing {'plane' if n_z == 1 else 'z-stack'} -> {rel} ({approx_mb:.1f} MB approx)")

    if preview_path is not None or role_key == ROLE_DAPI:
        preview_plane = _preview_plane_from_stack(planes, z_indices)
        if preview_plane is None:
            preview_plane = planes[0]
        if role_key == ROLE_DAPI:
            if bundle_root is None:
                raise ValueError("bundle_root required for DAPI preview dual-write")
            write_dapi_preview_pair(bundle_root, slice_id, preview_plane, preview_scale)
        elif preview_path is not None:
            write_preview_at_path(
                preview_path,
                preview_plane,
                preview_scale,
                bundle_root,
                slice_id=slice_id,
            )


def slice_id_for_scene(file_entry: dict, scene_index: int) -> str:
    for scene in file_entry.get("scenes") or []:
        if int(scene.get("index", -1)) == int(scene_index):
            return str(scene.get("sliceId") or "")
    basename = Path(file_entry.get("path") or file_entry.get("basename", "slice")).name
    scenes = file_entry.get("scenes") or [{"index": scene_index}]
    return default_slice_id(basename, scene_index, len(scenes) or 1)


def build_work_items(cfg: dict) -> list[dict]:
    channels = [c for c in cfg.get("channels") or [] if c.get("keep") and c.get("role") != ROLE_UNUSED]
    lookup = build_files_lookup(cfg.get("files") or [])

    items = []
    for ch in channels:
        if ch.get("role") == ROLE_UNUSED:
            continue
        if ch.get("role") == "other" and not branch_for_channel(ch):
            continue
        file_key = ch.get("file") or ""
        file_entry = resolve_file_entry(str(file_key), lookup)
        if not file_entry:
            continue
        czi_path = Path(file_entry["path"])
        for scene in file_entry.get("scenes") or [{"index": 0, "sliceId": "slice"}]:
            items.append(
                {
                    "czi_path": czi_path,
                    "file_entry": file_entry,
                    "scene_index": int(scene["index"]),
                    "slice_id": str(scene.get("sliceId") or slice_id_for_scene(file_entry, scene["index"])),
                    "channel_index": int(ch["index"]),
                    "channel": dict(ch),
                    "role_key": role_key_for_channel(ch),
                }
            )
    ordinal_map = slice_order_ordinal_map(cfg)
    if ordinal_map:
        items.sort(
            key=lambda item: (
                ordinal_map.get((str(item["czi_path"]), item["scene_index"]), 10**9),
                item["channel_index"],
            )
        )
    else:
        items.sort(
            key=lambda item: natural_sort_key(
                slice_id=item["slice_id"],
                basename=item["czi_path"].name,
                scene_index=item["scene_index"],
                path=str(item["czi_path"]),
                section_identifier=cfg.get("section_identifier"),
            )
        )
    return items


def collect_output_dirs(bundle_root: Path, work: list[dict]) -> list[Path]:
    dirs: set[Path] = set()
    for item in work:
        ch = item["channel"]
        slice_id = item["slice_id"]
        out_path = original_scans_path(bundle_root, ch, slice_id)
        dirs.add(out_path.parent)
        role = ch.get("role")
        if role == ROLE_DAPI:
            dirs.add(dapi_preview_path(bundle_root, slice_id).parent)
            dirs.add(orient_dapi_preview_path(bundle_root, slice_id).parent)
        elif branch_for_channel(ch):
            dirs.add(signal_preview_path(bundle_root, slice_id, ch).parent)
    meta = meta_state_path(bundle_root).parent
    dirs.add(meta)
    return sorted(dirs)


def import_aicspylibczi():
    """Import aicspylibczi with periodic still-loading logs."""
    stop = threading.Event()
    start = time.monotonic()

    def tick() -> None:
        while not stop.wait(5):
            elapsed = int(time.monotonic() - start)
            emit_log(f"  still loading aicspylibczi... ({elapsed}s)")
            mid = min(84, 50 + int(elapsed / 90 * 35))
            emit_progress_phase(mid, f"Loading aicspylibczi ({elapsed}s)")

    emit_log("Importing aicspylibczi (large native library; may take 30-90s on first run)...")
    emit_progress_phase(50, "Loading aicspylibczi...")
    thread = threading.Thread(target=tick, daemon=True)
    thread.start()
    try:
        from aicspylibczi import CziFile as _CziFile

        emit_log("  aicspylibczi ready")
        emit_progress_phase(85, "aicspylibczi loaded")
        return _CziFile
    except ImportError:
        raise
    finally:
        stop.set()
        thread.join(timeout=0.1)


def read_import_state(bundle_root: Path) -> dict:
    state_path = meta_state_path(bundle_root)
    if not state_path.is_file():
        return {}
    with open(state_path, encoding="utf-8") as f:
        return json.load(f)


def plane_from_zstack(arr):
    if arr.ndim <= 2:
        return arr
    if arr.ndim == 3:
        return arr[arr.shape[0] // 2]
    return collapse_z_stack_to_2d(arr)


def preview_path_for_channel(bundle_root: Path, ch: dict, slice_id: str) -> Path | None:
    role = ch.get("role")
    if role == ROLE_DAPI:
        return dapi_preview_path(bundle_root, slice_id)
    if branch_for_channel(ch):
        return signal_preview_path(bundle_root, slice_id, ch)
    return None


def _is_low_res_preview_path(preview_path: Path) -> bool:
    parts = {p.lower() for p in preview_path.parts}
    return "00_dapi" in parts or "_previews" in parts


def _path_under_00_dapi(preview_path: Path) -> bool:
    return "00_dapi" in {p.lower() for p in preview_path.parts}


def _write_preview_array(preview, preview_path: Path) -> None:
    if _path_under_00_dapi(preview_path) and preview_path.suffix.lower() != ".png":
        raise ValueError(f"00_dapi accepts PNG only, not {preview_path}")
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    if _is_low_res_preview_path(preview_path):
        cv2.imwrite(str(preview_path), preview)
        return
    if preview_path.suffix.lower() == ".png":
        cv2.imwrite(str(preview_path), preview)
    else:
        tiff.imwrite(str(preview_path), preview, photometric="minisblack")


def write_preview_at_path(
    preview_path: Path,
    plane,
    preview_scale: float,
    bundle_root: Path | None,
    slice_id: str = "",
) -> None:
    preview = downscale_plane(preview_autoscale_to_uint8(plane), preview_scale)
    _write_preview_array(preview, preview_path)
    try:
        prev_rel = preview_path.relative_to(bundle_root) if bundle_root else preview_path.name
    except ValueError:
        prev_rel = preview_path.name
    emit_log(f"  Writing preview -> {prev_rel} ({slice_id})")


def write_dapi_preview_pair(
    bundle_root: Path,
    slice_id: str,
    plane,
    preview_scale: float,
) -> None:
    """Write orient ``_previews/{id}_dapi.png`` and pipeline ``00_dapi/{id}.png``."""
    preview = downscale_plane(preview_autoscale_to_uint8(plane), preview_scale)
    for dest in (
        orient_dapi_preview_path(bundle_root, slice_id),
        dapi_preview_path(bundle_root, slice_id),
    ):
        _write_preview_array(preview, dest)
        try:
            rel = dest.relative_to(bundle_root)
        except ValueError:
            rel = dest.name
        emit_log(f"  Writing preview -> {rel} ({slice_id})")


def _remaining_00_dapi_tiffs(dapi_dir: Path) -> list[Path]:
    if not dapi_dir.is_dir():
        return []
    return sorted(dapi_dir.glob("*.tif")) + sorted(dapi_dir.glob("*.tiff"))


def migrate_low_res_tiffs(bundle_root: Path, cfg: dict, preview_scale: float) -> int:
    """Convert legacy low-res TIFFs to PNG; sync orient DAPI previews; delete TIFFs."""
    migrated = 0
    dapi_dir = bundle_root / CANONICAL_REL["dapi"]
    if dapi_dir.is_dir():
        legacy_tifs = _remaining_00_dapi_tiffs(dapi_dir)
        for tif_path in legacy_tifs:
            slice_id = tif_path.stem
            arr = np.asarray(tiff.imread(str(tif_path)))
            plane = plane_from_zstack(arr) if arr.ndim > 2 else arr
            write_dapi_preview_pair(bundle_root, slice_id, plane, preview_scale)
            tif_path.unlink(missing_ok=True)
            emit_log(f"  migrated {tif_path.name} -> PNG (pipeline + orient)")
            migrated += 1
        for png_path in sorted(dapi_dir.glob("*.png")):
            slice_id = png_path.stem
            orient_png = orient_dapi_preview_path(bundle_root, slice_id)
            if not orient_png.exists():
                arr = cv2.imread(str(png_path), cv2.IMREAD_UNCHANGED)
                if arr is not None:
                    _write_preview_array(np.asarray(arr), orient_png)
                    emit_log(f"  synced orient preview from {png_path.name}")
                    migrated += 1

    prev_dir = bundle_root / CANONICAL_REL["previews"]
    if prev_dir.is_dir():
        legacy_prev = sorted(prev_dir.glob("*.tif")) + sorted(prev_dir.glob("*.tiff"))
        for tif_path in legacy_prev:
            png_path = tif_path.with_suffix(".png")
            arr = np.asarray(tiff.imread(str(tif_path)))
            plane = plane_from_zstack(arr) if arr.ndim > 2 else arr
            write_preview_at_path(png_path, plane, preview_scale, bundle_root)
            tif_path.unlink(missing_ok=True)
            emit_log(f"  migrated {tif_path.name} -> {png_path.name}")
            migrated += 1

    leftover = _remaining_00_dapi_tiffs(dapi_dir)
    if leftover:
        names = ", ".join(p.name for p in leftover)
        emit_log(f"  ERROR: TIFF still in 00_dapi after migrate: {names}")
        raise RuntimeError(f"00_dapi must not contain TIFF files: {names}")
    return migrated


def repair_preview_from_zstack(
    bundle_root: Path,
    ch: dict,
    slice_id: str,
    preview_scale: float,
) -> bool:
    z_path = original_scans_path(bundle_root, ch, slice_id)
    if not z_path.is_file():
        emit_log(f"  z-stack missing for repair: {z_path.name}")
        return False
    emit_log(f"  Repair preview from z-stack {z_path.name}")
    arr = np.asarray(tiff.imread(str(z_path)))
    plane = plane_from_zstack(arr)
    if ch.get("role") == ROLE_DAPI:
        write_dapi_preview_pair(bundle_root, slice_id, plane, preview_scale)
        return True
    preview_path = preview_path_for_channel(bundle_root, ch, slice_id)
    if preview_path is None:
        return False
    write_preview_at_path(preview_path, plane, preview_scale, bundle_root, slice_id)
    return True


def channel_from_repair_target(cfg: dict, target: dict) -> dict | None:
    idx = int(target.get("channel_index", -1))
    role_key = target.get("role_key")
    for ch in cfg.get("channels") or []:
        if int(ch.get("index", -1)) != idx:
            continue
        if role_key and role_key_for_channel(ch) != role_key:
            continue
        return dict(ch)
    return None


def repair_target_to_work_item(cfg: dict, target: dict, lookup: dict) -> dict | None:
    ch = channel_from_repair_target(cfg, target)
    if not ch:
        return None
    file_key = target.get("file") or ch.get("file") or ""
    file_entry = resolve_file_entry(str(file_key), lookup)
    if not file_entry:
        return None
    czi_path = Path(target.get("czi_path") or file_entry.get("path") or "")
    if not czi_path.is_file():
        return None
    return {
        "czi_path": czi_path,
        "file_entry": file_entry,
        "scene_index": int(target.get("scene_index", 0)),
        "slice_id": str(target.get("slice_id") or ""),
        "channel_index": int(ch["index"]),
        "channel": ch,
        "role_key": role_key_for_channel(ch),
    }


def max_runs_on_disk(bundle_root: Path, max_runs: dict[str, str]) -> bool:
    if not max_runs:
        return False
    base = bundle_root / "data/counting/03_max"
    for rel in max_runs.values():
        if not rel or not (base / rel).is_dir():
            return False
    return True


def refresh_max_slices_in_run(
    bundle_root: Path,
    role_key: str,
    slice_ids: list[str],
    max_run_rel: str,
    cfg: dict,
) -> int:
    """Max-project selected slices into an existing run leaf."""
    branch = branch_for_role_key(role_key)
    if not branch or not max_run_rel:
        return 0
    in_dir = max_input_dir(bundle_root, role_key)
    rel = str(max_run_rel).replace("\\", "/").strip("/")
    out_dir = bundle_root / "data/counting/03_max" / rel
    if not in_dir.is_dir() or not out_dir.is_dir():
        emit_log(f"  skip max refresh {role_key}: missing input or output dir")
        return 0
    depth = bit_depth_for_role(cfg, role_key)
    refreshed = 0
    for sid in natural_sort_slice_ids(list({s for s in slice_ids if s})):
        src = in_dir / f"{sid}.tif"
        dst = out_dir / f"{sid}.tif"
        if not src.is_file():
            emit_log(f"  skip max refresh {sid}: missing {src.name}")
            continue
        emit_log(f"  max refresh {branch} <- {src.name} -> {rel}/{dst.name}")
        max_project_file(src, dst, bit_depth=depth)
        refreshed += 1
    return refreshed


def build_reextract_work(cfg: dict, repair_targets: list[dict], lookup: dict) -> list[dict]:
    work: list[dict] = []
    for target in repair_targets:
        item = repair_target_to_work_item(cfg, target, lookup)
        if item:
            work.append(item)
    return work


def run_max_for_role_key(bundle_root: Path, role_key: str, slice_ids: list[str], cfg: dict) -> str:
    branch = branch_for_role_key(role_key)
    if not branch:
        return ""
    in_dir = max_input_dir(bundle_root, role_key)
    if not in_dir.exists():
        return ""
    stems = natural_sort_slice_ids(list({sid for sid in slice_ids}))
    slug = stems[0] if len(stems) == 1 else f"{stems[0]}-{stems[-1]}"
    out_dir = max_output_run_dir(bundle_root, role_key, slug)
    if not out_dir.exists():
        emit_log(f"  mkdir {out_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)
    files = natural_sort_filenames([p.name for p in in_dir.glob("*.tif")])
    emit_log(f"Max projecting {branch} ({len(files)} slices)...")
    emit_progress("Max projecting signal channels...")
    depth = bit_depth_for_role(cfg, role_key)
    for fname in files:
        emit_log(f"  max <- {fname}")
        max_project_file(in_dir / fname, out_dir / f"{Path(fname).stem}.tif", bit_depth=depth)
    write_run_manifest(
        out_dir,
        {
            "step": "max",
            "source": "czi_import",
            "branch": branch,
            "input_dir": str(in_dir),
            "input_files": files,
        },
    )
    rel = f"{branch}/max/{slug}"
    return rel


def main() -> int:
    global np, cv2, tiff, CziFile

    parser = argparse.ArgumentParser(description="Extract CZI into project bundle")
    parser.add_argument("-b", "--bundle", required=True, help="Project bundle root")
    parser.add_argument("-j", "--json", required=True, help="CZI import config JSON path")
    args = parser.parse_args()
    args.bundle = str(args.bundle).strip()
    args.json = str(args.json).strip()

    emit_progress_phase(0, "Starting extract worker")
    emit_log(f"Worker PID {os.getpid()} argv {sys.argv[1:]}")
    emit_log(f"Parsed bundle={args.bundle} config={args.json}")
    emit_progress_phase(5, "Arguments OK")

    emit_log("Importing numpy...")
    emit_progress_phase(10, "Loading numpy...")
    import numpy as _np

    np = _np
    emit_log("  numpy ready")
    emit_progress_phase(25, "numpy loaded")

    emit_log("Importing opencv...")
    emit_progress_phase(25, "Loading opencv...")
    import cv2 as _cv2

    cv2 = _cv2
    emit_log("  opencv ready")
    emit_progress_phase(40, "opencv loaded")

    emit_log("Importing tifffile...")
    emit_progress_phase(40, "Loading tifffile...")
    import tifffile as _tiff

    tiff = _tiff
    emit_log("  tifffile ready")
    emit_progress_phase(50, "tifffile loaded")

    try:
        CziFile = import_aicspylibczi()
    except ImportError as exc:
        emit_result({"ok": False, "error": str(exc)})
        return 1

    emit_log("All libraries loaded")
    emit_progress_phase(100, "Libraries ready")

    bundle_root = Path(args.bundle).resolve()
    try:
        cfg = load_import_config(args.json)
    except FileNotFoundError as exc:
        emit_result({"ok": False, "error": str(exc)})
        return 1
    source_dir = cfg.get("source_dir") or ""
    emit_log(f"Bundle root: {bundle_root}")
    emit_log(f"Config: {args.json}")
    emit_log(f"CZI source: {source_dir or '(from config paths)'}")

    emit_progress_phase(100, "Building work list")
    preview_scale = clamp_preview_scale(cfg.get("preview_scale"))
    repair_mode = cfg.get("repair_mode")
    repair_targets = list(cfg.get("repair_targets") or [])
    prior_state = read_import_state(bundle_root)
    max_runs_existing = dict(cfg.get("max_runs") or prior_state.get("max_runs") or {})

    if repair_mode == "previews":
        emit_log("Preview repair mode — migrating legacy TIFFs to PNG")
        migrate_low_res_tiffs(bundle_root, cfg, preview_scale)
        if not repair_targets:
            state = read_import_state(bundle_root) or {}
            state["phase"] = "complete"
            state["repair_mode"] = repair_mode
            state["preview_format_version"] = PREVIEW_FORMAT_VERSION
            write_import_state(bundle_root, state)
            emit_result(
                {
                    "ok": True,
                    "extracted": {},
                    "max_runs": dict(max_runs_existing),
                    "primary_signal_role": cfg.get("primary_signal_role") or "",
                    "repair_mode": repair_mode,
                    "repaired_previews": 0,
                    "migrate_only": True,
                }
            )
            print("Done!", flush=True)
            return 0
        emit_log(f"Preview repair ({len(repair_targets)} target(s))")
        files_lookup = build_files_lookup(cfg.get("files") or [])
        fallback_work: list[dict] = []
        repaired = 0
        state = {
            "phase": "repair",
            "started": datetime.now(timezone.utc).isoformat(),
            "total": len(repair_targets),
            "done": 0,
            "repair_mode": repair_mode,
        }
        write_import_state(bundle_root, state)
        print(len(repair_targets), flush=True)
        extracted_by_role_key: dict[str, list[str]] = {}
        for i, target in enumerate(repair_targets):
            slice_id = str(target.get("slice_id") or "")
            ch = channel_from_repair_target(cfg, target)
            if not ch or not slice_id:
                emit_log(f"[{i + 1}/{len(repair_targets)}] skip invalid repair target")
                state["done"] = i + 1
                write_import_state(bundle_root, state)
                continue
            emit_log(f"[{i + 1}/{len(repair_targets)}] repair preview {slice_id} ch {ch.get('index')}")
            emit_progress(f"Repairing preview {slice_id}")
            if repair_preview_from_zstack(bundle_root, ch, slice_id, preview_scale):
                repaired += 1
                role_key = role_key_for_channel(ch)
                extracted_by_role_key.setdefault(role_key, []).append(slice_id)
            else:
                item = repair_target_to_work_item(cfg, target, files_lookup)
                if item:
                    fallback_work.append(item)
                else:
                    emit_log(f"  could not repair or fall back for {slice_id}")
            state["done"] = i + 1
            write_import_state(bundle_root, state)
        work = fallback_work
    elif repair_mode == "reextract":
        emit_log(f"CZI re-extract mode ({len(repair_targets)} target(s))")
        if not repair_targets:
            emit_result({"ok": False, "error": "No re-extract targets"})
            return 1
        files_lookup = build_files_lookup(cfg.get("files") or [])
        work = build_reextract_work(cfg, repair_targets, files_lookup)
        if not work:
            emit_result({"ok": False, "error": "No valid re-extract work items (check CZI paths)"})
            return 1
        repaired = 0
        extracted_by_role_key = {}
        state = {
            "phase": "reextract",
            "started": datetime.now(timezone.utc).isoformat(),
            "total": len(work),
            "done": 0,
            "repair_mode": repair_mode,
        }
        write_import_state(bundle_root, state)
        print(len(work), flush=True)
    else:
        work = build_work_items(cfg)
        if not work:
            emit_result({"ok": False, "error": "No channels marked to keep"})
            return 1
        repaired = 0

    if work:
        channels_kept = len(
            [c for c in cfg.get("channels") or [] if c.get("keep") and c.get("role") != ROLE_UNUSED],
        )
        files_in_work = len({str(item["czi_path"]) for item in work})
        out_dirs = collect_output_dirs(bundle_root, work)
        emit_log(f"Creating output directories ({len(out_dirs)} paths)...")
        for d in out_dirs:
            if not d.exists():
                emit_log(f"  mkdir {d}")
            d.mkdir(parents=True, exist_ok=True)
        emit_log(f"{len(work)} work items ({channels_kept} channels kept across {files_in_work} files)")
        emit_log("Beginning extraction...")
        state = {
            "phase": "extract",
            "started": datetime.now(timezone.utc).isoformat(),
            "total": len(work),
            "done": 0,
            "slice_numbering": cfg.get("slice_numbering"),
            "slice_order_count": len(cfg.get("slice_order") or []),
        }
        write_import_state(bundle_root, state)
        print(len(work), flush=True)
    elif repair_mode != "previews" and repair_mode != "reextract":
        emit_result({"ok": False, "error": "No channels marked to keep"})
        return 1

    if repair_mode not in ("previews", "reextract"):
        extracted_by_role_key = {}
    czi_cache: dict[str, object] = {}

    mosaic_logged: set[str] = set()

    def get_czi(path: Path):
        key = str(path.resolve())
        if key not in czi_cache:
            emit_log(f"  Opening CZI {path.name} (first open for this file)")
            czi = CziFile(key)
            blocks = normalized_dim_blocks(czi)
            dim_letters = sorted({str(k).upper() for b in blocks for k in b.keys()})
            dims_str = "".join(dim_letters)
            mosaic_info = assess_mosaic_import(czi, sample_read=True, sample_scale=0.05)
            is_mosaic = bool(mosaic_info.get("is_mosaic"))
            emit_log(f"  dims={dims_str or '?'}, is_mosaic={is_mosaic}")
            if is_mosaic and key not in mosaic_logged:
                stitch_status = str(mosaic_info.get("mosaic_stitch_status") or "unknown")
                if stitch_status == "ok":
                    emit_log("  mosaic stitched read OK (scale_factor=1.0, no S dimension)")
                elif stitch_status == "suspect":
                    emit_log("  mosaic read, scale_factor=1.0")
                    for warn in mosaic_info.get("mosaic_warnings") or []:
                        if "ZEN" in warn or "stitch" in warn.lower() or "tile" in warn.lower():
                            emit_log(f"  WARNING: {warn}")
                else:
                    emit_log("  mosaic read, scale_factor=1.0 (stitch status unknown)")
                    for warn in mosaic_info.get("mosaic_warnings") or []:
                        if "Could not read" in warn:
                            emit_log(f"  WARNING: {warn}")
                mosaic_logged.add(key)
            czi_cache[key] = czi
        return czi_cache[key]

    failed_items: list[str] = []
    for i, item in enumerate(work or []):
        czi_path = item["czi_path"]
        ch = item["channel"]
        role = ch.get("role")
        role_key = item["role_key"]
        scene_index = item["scene_index"]
        channel_index = item["channel_index"]
        slice_id = item["slice_id"]
        emit_log(
            f"[{i + 1}/{len(work)}] {slice_id} role={role_key} "
            f"file={czi_path.name} scene={scene_index} ch={channel_index}"
        )
        emit_progress(f"Extracting {czi_path.name} scene {scene_index} ch {channel_index}")
        # Isolate per-item failures: one bad scene/channel/plane must not abort
        # the entire import (which would lose all remaining work).
        try:
            czi = get_czi(czi_path)
            z_idxs = z_indices_with_data(czi, scene_index, channel_index)
            out_path = original_scans_path(bundle_root, ch, slice_id)
            preview_path = None
            if role == ROLE_DAPI:
                preview_path = None
            elif branch_for_channel(ch):
                preview_path = signal_preview_path(bundle_root, slice_id, ch)

            extract_z_stack(
                czi,
                scene_index,
                channel_index,
                z_idxs,
                out_path,
                preview_path,
                preview_scale,
                slice_id=slice_id,
                bundle_root=bundle_root,
                cfg=cfg,
                role_key=role_key,
            )
            extracted_by_role_key.setdefault(role_key, []).append(slice_id)
        except Exception as exc:
            failed_items.append(f"{slice_id} (role={role_key} ch={channel_index})")
            emit_log(
                f"  ERROR extracting {slice_id} role={role_key} "
                f"ch={channel_index} from {czi_path.name}: {exc}"
            )
        state["done"] = i + 1
        write_import_state(bundle_root, state)

    if failed_items:
        emit_log(
            f"WARNING: {len(failed_items)} extraction item(s) failed and were "
            f"skipped: {', '.join(failed_items[:20])}"
            + (" …" if len(failed_items) > 20 else "")
        )

    for czi in czi_cache.values():
        close = getattr(czi, "close", None)
        if callable(close):
            close()
    czi_cache.clear()

    max_runs: dict[str, str] = dict(max_runs_existing)
    primary_role = cfg.get("primary_signal_role") or prior_state.get("primary_signal_role") or ""
    skip_max = repair_mode == "previews" and max_runs_on_disk(bundle_root, max_runs)
    if skip_max:
        emit_log("Skipping max projection (existing max runs on disk)")
    elif repair_mode == "reextract":
        for role_key, slice_ids in extracted_by_role_key.items():
            if role_key in (ROLE_DAPI, ROLE_UNUSED):
                continue
            if not branch_for_role_key(role_key):
                continue
            rel = str(max_runs.get(role_key) or "").strip()
            if not rel:
                emit_log(f"  skip max refresh {role_key}: no max run registered")
                continue
            n = refresh_max_slices_in_run(bundle_root, role_key, slice_ids, rel, cfg)
            if n:
                emit_log(f"  refreshed {n} max TIFF(s) for {role_key} in {rel}")
    else:
        for role_key, slice_ids in extracted_by_role_key.items():
            if role_key in (ROLE_DAPI, ROLE_UNUSED):
                continue
            if not branch_for_role_key(role_key):
                continue
            rel = run_max_for_role_key(bundle_root, role_key, slice_ids, cfg)
            if rel:
                max_runs[role_key] = rel
                branch = branch_for_role_key(role_key) or role_key
                emit_log(f"max projection {branch} -> {rel}")
                if not primary_role:
                    primary_role = role_key

    migrated_tiffs = migrate_low_res_tiffs(bundle_root, cfg, preview_scale)
    if migrated_tiffs:
        emit_log(f"Migrated {migrated_tiffs} low-res TIFF artifact(s) to PNG")

    state = read_import_state(bundle_root) or {}
    state["phase"] = "complete"
    state["max_runs"] = max_runs
    state["preview_format_version"] = PREVIEW_FORMAT_VERSION
    state["config_fingerprint"] = cfg.get("config_fingerprint") or ""
    if repair_mode:
        state["repair_mode"] = repair_mode
    write_import_state(bundle_root, state)

    emit_result(
        {
            "ok": True,
            "extracted": extracted_by_role_key,
            "max_runs": max_runs,
            "primary_signal_role": primary_role,
            "slice_numbering": cfg.get("slice_numbering"),
            "slice_order_count": len(cfg.get("slice_order") or []),
            "preview_format_version": PREVIEW_FORMAT_VERSION,
            "config_fingerprint": cfg.get("config_fingerprint") or "",
            "repair_mode": repair_mode,
            "repaired_previews": repaired if repair_mode == "previews" else None,
        }
    )
    print("Done!", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
