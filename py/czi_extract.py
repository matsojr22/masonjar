"""Extract CZI channels to z-stack TIFFs, previews, and max projections."""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from czi_common import (
    ROLE_DAPI,
    ROLE_UNUSED,
    branch_for_channel,
    branch_for_role_key,
    dapi_preview_path,
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
    read_czi_plane,
    role_key_for_channel,
    signal_preview_path,
    slice_order_ordinal_map,
    write_import_state,
    z_indices_from_czi,
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
    if stack.ndim == 2:
        return stack
    z_axis = int(np.argmin(stack.shape))
    return np.max(stack, axis=z_axis)


def max_project_file(input_path: Path, output_path: Path) -> None:
    img = tiff.imread(str(input_path))
    out = max_project_z(np.asarray(img))
    parent = output_path.parent
    if not parent.exists():
        emit_log(f"  mkdir {parent}")
    parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), out)


def read_plane(czi, scene: int, z: int, channel: int):
    return read_czi_plane(czi, scene, z, channel)


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
) -> None:
    planes = []
    mid_z = z_indices[len(z_indices) // 2] if z_indices else 0
    n_z = len(z_indices)
    for i, z in enumerate(z_indices):
        emit_log(f"  Reading Z {i + 1}/{n_z} ({slice_id} ch {channel})")
        plane = read_plane(czi, scene, z, channel)
        planes.append(plane)
    h, w = planes[0].shape[:2] if planes else (0, 0)
    emit_log(f"  Stacking {n_z} planes ({h}x{w})")
    stack = np.stack(planes, axis=0)
    parent = out_path.parent
    if not parent.exists():
        emit_log(f"  mkdir {parent}")
    parent.mkdir(parents=True, exist_ok=True)
    tiff.imwrite(str(out_path), stack, photometric="minisblack")
    try:
        rel = out_path.relative_to(bundle_root) if bundle_root else out_path.name
    except ValueError:
        rel = out_path.name
    approx_mb = out_path.stat().st_size / (1024 * 1024) if out_path.exists() else stack.nbytes / (1024 * 1024)
    emit_log(f"  Writing z-stack → {rel} ({approx_mb:.1f} MB approx)")

    if preview_path is not None:
        preview_plane = planes[z_indices.index(mid_z)] if z_indices else planes[0]
        preview = downscale_plane(preview_plane, preview_scale)
        pparent = preview_path.parent
        if not pparent.exists():
            emit_log(f"  mkdir {pparent}")
        pparent.mkdir(parents=True, exist_ok=True)
        tiff.imwrite(str(preview_path), preview, photometric="minisblack")
        try:
            prev_rel = preview_path.relative_to(bundle_root) if bundle_root else preview_path.name
        except ValueError:
            prev_rel = preview_path.name
        emit_log(f"  Writing preview → {prev_rel}")


def slice_id_for_scene(file_entry: dict, scene_index: int) -> str:
    for scene in file_entry.get("scenes") or []:
        if int(scene.get("index", -1)) == int(scene_index):
            return str(scene.get("sliceId") or "")
    basename = Path(file_entry.get("path") or file_entry.get("basename", "slice")).name
    scenes = file_entry.get("scenes") or [{"index": scene_index}]
    return default_slice_id(basename, scene_index, len(scenes) or 1)


def build_work_items(cfg: dict) -> list[dict]:
    channels = [c for c in cfg.get("channels") or [] if c.get("keep") and c.get("role") != ROLE_UNUSED]
    files_by_name = {}
    for f in cfg.get("files") or []:
        files_by_name[Path(f.get("path", "")).name] = f
        files_by_name[f.get("basename", "")] = f

    items = []
    for ch in channels:
        if ch.get("role") == ROLE_UNUSED:
            continue
        if ch.get("role") == "other" and not branch_for_channel(ch):
            continue
        file_key = ch.get("file") or ""
        file_entry = files_by_name.get(file_key) or files_by_name.get(Path(file_key).name)
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
            emit_log(f"  still loading aicspylibczi… ({elapsed}s)")
            mid = min(84, 50 + int(elapsed / 90 * 35))
            emit_progress_phase(mid, f"Loading aicspylibczi ({elapsed}s)")

    emit_log("Importing aicspylibczi (large native library; may take 30–90s on first run)…")
    emit_progress_phase(50, "Loading aicspylibczi…")
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


def run_max_for_role_key(bundle_root: Path, role_key: str, slice_ids: list[str]) -> str:
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
    emit_log(f"Max projecting {branch} ({len(files)} slices)…")
    emit_progress("Max projecting signal channels…")
    for fname in files:
        emit_log(f"  max ← {fname}")
        max_project_file(in_dir / fname, out_dir / f"{Path(fname).stem}.tif")
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

    emit_log("Importing numpy…")
    emit_progress_phase(10, "Loading numpy…")
    import numpy as _np

    np = _np
    emit_log("  numpy ready")
    emit_progress_phase(25, "numpy loaded")

    emit_log("Importing opencv…")
    emit_progress_phase(25, "Loading opencv…")
    import cv2 as _cv2

    cv2 = _cv2
    emit_log("  opencv ready")
    emit_progress_phase(40, "opencv loaded")

    emit_log("Importing tifffile…")
    emit_progress_phase(40, "Loading tifffile…")
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
    preview_scale = float(cfg.get("preview_scale") or 0.05)
    work = build_work_items(cfg)
    if not work:
        emit_result({"ok": False, "error": "No channels marked to keep"})
        return 1

    channels_kept = len([c for c in cfg.get("channels") or [] if c.get("keep") and c.get("role") != ROLE_UNUSED])
    files_in_work = len({str(item["czi_path"]) for item in work})

    out_dirs = collect_output_dirs(bundle_root, work)
    emit_log(f"Creating output directories ({len(out_dirs)} paths)…")
    for d in out_dirs:
        if not d.exists():
            emit_log(f"  mkdir {d}")
        d.mkdir(parents=True, exist_ok=True)

    emit_log(f"{len(work)} work items ({channels_kept} channels kept across {files_in_work} files)")
    emit_log("Beginning extraction…")

    state_path = meta_state_path(bundle_root)
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
    extracted_by_role_key: dict[str, list[str]] = {}
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
            is_mosaic = bool(getattr(czi, "is_mosaic", lambda: False)())
            emit_log(f"  dims={dims_str or '?'}, is_mosaic={is_mosaic}")
            if is_mosaic and key not in mosaic_logged:
                emit_log("  mosaic read, scale_factor=1.0")
                mosaic_logged.add(key)
            czi_cache[key] = czi
        return czi_cache[key]

    for i, item in enumerate(work):
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
        czi = get_czi(czi_path)
        z_idxs = z_indices_from_czi(czi)
        out_path = original_scans_path(bundle_root, ch, slice_id)
        preview_path = None
        if role == ROLE_DAPI:
            preview_path = dapi_preview_path(bundle_root, slice_id)
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
        )
        extracted_by_role_key.setdefault(role_key, []).append(slice_id)
        state["done"] = i + 1
        write_import_state(bundle_root, state)

    for czi in czi_cache.values():
        close = getattr(czi, "close", None)
        if callable(close):
            close()
    czi_cache.clear()

    max_runs: dict[str, str] = {}
    primary_role = cfg.get("primary_signal_role") or ""
    for role_key, slice_ids in extracted_by_role_key.items():
        if role_key in (ROLE_DAPI, ROLE_UNUSED):
            continue
        if not branch_for_role_key(role_key):
            continue
        rel = run_max_for_role_key(bundle_root, role_key, slice_ids)
        if rel:
            max_runs[role_key] = rel
            branch = branch_for_role_key(role_key) or role_key
            emit_log(f"max projection {branch} → {rel}")
            if not primary_role:
                primary_role = role_key

    state["phase"] = "complete"
    state["max_runs"] = max_runs
    write_import_state(bundle_root, state)

    emit_result(
        {
            "ok": True,
            "extracted": extracted_by_role_key,
            "max_runs": max_runs,
            "primary_signal_role": primary_role,
            "slice_numbering": cfg.get("slice_numbering"),
            "slice_order_count": len(cfg.get("slice_order") or []),
        }
    )
    print("Done!", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
