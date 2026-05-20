"""Probe Zeiss CZI files for dimensions, scenes, and channel metadata."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from czi_common import (
    assess_mosaic_import,
    channel_indices_from_czi,
    default_slice_id,
    dim_size,
    emit_progress,
    emit_result,
    natural_sort_czi_paths,
    normalized_dim_blocks,
    scene_indices_from_czi,
    suggest_role_from_label,
    z_indices_from_czi,
)


def probe_file(path: Path) -> dict:
    try:
        from aicspylibczi import CziFile
    except ImportError as exc:
        raise RuntimeError(
            "aicspylibczi is not installed in the Mason Jar Python environment"
        ) from exc

    czi = CziFile(str(path))
    blocks = normalized_dim_blocks(czi)
    dim_letters = sorted({str(k).upper() for b in blocks for k in b.keys()})
    dims = "".join(dim_letters)
    mosaic_info = assess_mosaic_import(czi, sample_read=True)
    is_mosaic = bool(mosaic_info.get("is_mosaic"))
    has_m_dim = bool(mosaic_info.get("has_m_dim"))
    scene_indices = scene_indices_from_czi(czi)
    channel_indices = channel_indices_from_czi(czi)
    z_count = len(z_indices_from_czi(czi))

    channel_meta = []
    for cidx in channel_indices:
        label = ""
        channel_meta.append(
            {
                "index": cidx,
                "label": label,
                "suggested_role": suggest_role_from_label(label),
            }
        )

    basename = path.name
    scenes = []
    for sidx in scene_indices:
        sid = default_slice_id(basename, sidx, len(scene_indices))
        scenes.append(
            {
                "index": sidx,
                "sliceId": sid,
                "originalSliceId": sid,
            }
        )

    return {
        "path": str(path),
        "basename": basename,
        "dims": dims,
        "is_mosaic": is_mosaic,
        "has_m_dim": has_m_dim,
        "m_tile_count": mosaic_info.get("m_tile_count"),
        "likely_unstitched": bool(mosaic_info.get("likely_unstitched")),
        "mosaic_stitch_status": mosaic_info.get("mosaic_stitch_status", "unknown"),
        "mosaic_warnings": list(mosaic_info.get("mosaic_warnings") or []),
        "scene_count": len(scene_indices),
        "channel_count": len(channel_indices),
        "z_count": z_count,
        "scenes": scenes,
        "channels": channel_meta,
    }


def collect_czi_paths(target: str) -> list[Path]:
    p = Path(target)
    if p.is_file() and p.suffix.lower() == ".czi":
        return [p]
    if not p.is_dir():
        return []
    paths = list(p.glob("*.czi")) + list(p.glob("*.CZI"))
    seen: set[str] = set()
    unique: list[Path] = []
    for path in paths:
        key = str(path.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return natural_sort_czi_paths(unique)


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe CZI files")
    parser.add_argument("-i", "--input", required=True, help="CZI file or directory")
    args = parser.parse_args()
    args.input = str(args.input).strip()

    paths = collect_czi_paths(args.input)
    if not paths:
        emit_result({"ok": False, "error": "No .czi files found", "files": []})
        return 1

    print(len(paths), flush=True)
    results = []
    for i, czi_path in enumerate(paths):
        emit_progress(f"Probing {czi_path.name}")
        try:
            results.append(probe_file(czi_path))
        except Exception as exc:
            results.append(
                {
                    "path": str(czi_path),
                    "basename": czi_path.name,
                    "error": str(exc),
                }
            )
        pct = int(((i + 1) / len(paths)) * 100)
        emit_progress(f"{pct}% {czi_path.name}")

    emit_result({"ok": True, "files": results})
    print("Done!", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
