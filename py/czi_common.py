"""Shared helpers for Mason Jar CZI import."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

ROLE_DAPI = "dapi"
ROLE_SIGNAL_SOMATA = "signal_somata"
ROLE_SIGNAL_NUCLEI = "signal_nuclei"
ROLE_SIGNAL_AXONS = "signal_axons"
ROLE_OTHER = "other"
ROLE_UNUSED = "unused"

SIGNAL_ROLES = (ROLE_SIGNAL_SOMATA, ROLE_SIGNAL_NUCLEI, ROLE_SIGNAL_AXONS)

ROLE_TO_BRANCH = {
    ROLE_SIGNAL_SOMATA: "somata",
    ROLE_SIGNAL_NUCLEI: "nuclei",
    ROLE_SIGNAL_AXONS: "axons",
}

CANONICAL_REL = {
    "original_scans": "data/original_scans",
    "dapi": "data/counting/00_dapi",
    "max": "data/counting/03_max",
    "previews": "data/counting/_previews",
}

DEFAULT_PREVIEW_SCALE = 0.05


def sanitize_slice_stem(stem: str) -> str:
    s = re.sub(r'[/\\:*?"<>|]+', "_", str(stem or "").strip())
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "slice"


def default_slice_id(czi_basename: str, scene_index: int, scene_count: int) -> str:
    stem = sanitize_slice_stem(Path(czi_basename).stem)
    if scene_count > 1:
        return f"{stem}_s{int(scene_index):03d}"
    return stem


def parse_section_suffix(slice_id_or_stem: str) -> int | None:
    text = str(slice_id_or_stem or "")
    match = re.search(r"_s(\d+)", text, re.I)
    if match:
        return int(match.group(1))
    trail = re.search(r"(\d+)\s*$", text)
    if trail:
        return int(trail.group(1))
    return None


def natural_sort_key(
    *,
    slice_id: str = "",
    basename: str = "",
    scene_index: int = 0,
    path: str = "",
) -> tuple:
    section = parse_section_suffix(slice_id or basename)
    section_key = section if section is not None else 10**9
    base = Path(basename or path or slice_id).name.lower()
    return (section_key, base, int(scene_index), str(path).lower())


def natural_sort_czi_paths(paths: list[Path]) -> list[Path]:
    return sorted(
        paths,
        key=lambda p: natural_sort_key(basename=p.name, path=str(p)),
    )


def natural_sort_slice_ids(slice_ids: list[str]) -> list[str]:
    return sorted(
        slice_ids,
        key=lambda sid: natural_sort_key(slice_id=sid),
    )


def natural_sort_filenames(filenames: list[str]) -> list[str]:
    return sorted(
        filenames,
        key=lambda name: natural_sort_key(basename=name, slice_id=Path(name).stem),
    )


def slice_order_ordinal_map(cfg: Mapping[str, Any]) -> dict[tuple[str, int], int]:
    mapping: dict[tuple[str, int], int] = {}
    for entry in cfg.get("slice_order") or []:
        if not isinstance(entry, Mapping):
            continue
        path = str(entry.get("path") or "")
        scene_index = int(entry.get("scene_index", 0))
        ordinal = int(entry.get("ordinal", 0))
        if path and ordinal:
            mapping[(path, scene_index)] = ordinal
    return mapping


def suggest_role_from_label(label: str) -> str:
    text = str(label or "").strip()
    if re.search(r"dapi", text, re.I):
        return ROLE_DAPI
    if re.search(r"soma|rabies", text, re.I):
        return ROLE_SIGNAL_SOMATA
    if re.search(r"nucle", text, re.I):
        return ROLE_SIGNAL_NUCLEI
    if re.search(r"axon", text, re.I):
        return ROLE_SIGNAL_AXONS
    return ROLE_UNUSED


def branch_for_role(role: str) -> str | None:
    if role == ROLE_DAPI:
        return None
    return ROLE_TO_BRANCH.get(role)


def sanitize_other_name(name: str) -> str | None:
    s = str(name or "").strip()
    if not s:
        return None
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[^a-zA-Z0-9_-]", "", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s or len(s) > 32:
        return None
    return s


def branch_for_channel(ch: Mapping[str, Any]) -> str | None:
    role = str(ch.get("role") or "")
    if role in (ROLE_DAPI, ROLE_UNUSED):
        return None
    if role == ROLE_OTHER:
        return sanitize_other_name(str(ch.get("other_name") or ""))
    return ROLE_TO_BRANCH.get(role)


def role_key_for_channel(ch: Mapping[str, Any]) -> str:
    role = str(ch.get("role") or ROLE_UNUSED)
    if role == ROLE_OTHER:
        name = sanitize_other_name(str(ch.get("other_name") or ""))
        return f"other:{name}" if name else ROLE_OTHER
    return role


def branch_for_role_key(role_key: str) -> str | None:
    if role_key.startswith("other:"):
        return role_key.split(":", 1)[1] or None
    return branch_for_role(role_key)


def original_scans_path(bundle_root: Path, channel: Mapping[str, Any], slice_id: str) -> Path:
    branch = branch_for_channel(channel)
    base = bundle_root / CANONICAL_REL["original_scans"]
    if branch:
        return base / branch / f"{slice_id}.tif"
    return base / f"{slice_id}.tif"


def dapi_preview_path(bundle_root: Path, slice_id: str) -> Path:
    return bundle_root / CANONICAL_REL["dapi"] / f"{slice_id}.tif"


def signal_preview_path(bundle_root: Path, slice_id: str, channel: Mapping[str, Any]) -> Path:
    branch = branch_for_channel(channel)
    suffix = branch or role_key_for_channel(channel)
    return bundle_root / CANONICAL_REL["previews"] / f"{slice_id}_{suffix}.tif"


def max_input_dir(bundle_root: Path, role_key: str) -> Path:
    branch = branch_for_role_key(role_key)
    base = bundle_root / CANONICAL_REL["original_scans"]
    if branch:
        return base / branch
    return base


def max_output_run_dir(bundle_root: Path, role_key: str, slug: str) -> Path:
    branch = branch_for_role_key(role_key) or "default"
    return bundle_root / CANONICAL_REL["max"] / branch / "max" / slug


def load_import_config(path: str | Path) -> dict[str, Any]:
    p = Path(str(path).strip())
    if not p.is_file():
        raise FileNotFoundError(f"Config not found: {p}")
    with open(p, encoding="utf-8") as f:
        data = json.load(f)
    if "czi_import" in data:
        return data["czi_import"]
    return data


def meta_state_path(bundle_root: Path) -> Path:
    for name in (".masonjar", ".belljar"):
        p = bundle_root / name / "czi_import_state.json"
        if p.parent.exists() or name == ".masonjar":
            return p
    return bundle_root / ".masonjar" / "czi_import_state.json"


def write_import_state(bundle_root: Path, state: Mapping[str, Any]) -> None:
    path = meta_state_path(bundle_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dict(state), f, indent=2)


def emit_progress(message: str) -> None:
    print(message, flush=True)


def emit_progress_phase(pct: int, message: str) -> None:
    """pct 0-100 within startup sub-phase; main maps to display bar."""
    print(f"PROGRESS:{pct}:{message}", flush=True)


def emit_log(message: str) -> None:
    print(f"LOG:{message}", flush=True)


def emit_result(payload: Mapping[str, Any]) -> None:
    print("RESULT:" + json.dumps(payload), flush=True)


def dim_size(block: Mapping[str, Any], letter: str) -> int:
    val = block.get(letter)
    if val is None:
        val = block.get(letter.lower())
    if isinstance(val, tuple) and len(val) >= 2:
        return max(1, int(val[1]))
    if isinstance(val, dict):
        return max(1, len(val))
    if isinstance(val, (list, tuple)):
        return max(1, len(val))
    return 1


def normalized_dim_blocks(czi) -> list[dict[str, Any]]:
    """Return per-scene dimension blocks from aicspylibczi get_dims_shape()."""
    dims_shape = czi.get_dims_shape()
    if isinstance(dims_shape, list):
        if not dims_shape:
            return [{}]
        return [d for d in dims_shape if isinstance(d, dict)]
    if isinstance(dims_shape, dict):
        return [dims_shape]
    return [{}]


def scene_indices_from_czi(czi) -> list[int]:
    blocks = normalized_dim_blocks(czi)
    if len(blocks) > 1:
        return list(range(len(blocks)))
    s_count = dim_size(blocks[0], "S")
    return list(range(s_count))


def channel_indices_from_czi(czi) -> list[int]:
    blocks = normalized_dim_blocks(czi)
    c_count = dim_size(blocks[0], "C")
    return list(range(c_count))


def z_indices_from_czi(czi) -> list[int]:
    blocks = normalized_dim_blocks(czi)
    z_count = dim_size(blocks[0], "Z")
    return list(range(z_count))


def m_tile_count_from_czi(czi) -> int:
    blocks = normalized_dim_blocks(czi)
    return dim_size(blocks[0], "M") if blocks else 1


def bbox_width_height(bbox: Any) -> tuple[int, int]:
    if bbox is None:
        return 0, 0
    w = getattr(bbox, "w", None)
    h = getattr(bbox, "h", None)
    if w is not None and h is not None:
        return max(0, int(w)), max(0, int(h))
    if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
        return max(0, int(bbox[2])), max(0, int(bbox[3]))
    if isinstance(bbox, Mapping):
        return max(0, int(bbox.get("w", 0))), max(0, int(bbox.get("h", 0)))
    return 0, 0


def assess_mosaic_import(czi, *, sample_read: bool = True) -> dict[str, Any]:
    """Heuristics for unstitched mosaic tiles (warn only; import is not blocked)."""
    blocks = normalized_dim_blocks(czi)
    is_mosaic = bool(getattr(czi, "is_mosaic", lambda: False)())
    m_tile_count = m_tile_count_from_czi(czi)
    has_m_dim = m_tile_count > 1
    warnings: list[str] = []
    likely_unstitched = False

    if is_mosaic and has_m_dim:
        likely_unstitched = True
        warnings.append(
            f"Mosaic file reports {m_tile_count} tile(s) on the M axis. If the acquisition "
            "was not stitched in ZEN before export, import may show seams, missing regions, "
            "or wrong geometry. Open the file in ZEN, run mosaic stitch, and re-export."
        )

    if not is_mosaic or not sample_read:
        return {
            "is_mosaic": is_mosaic,
            "m_tile_count": m_tile_count,
            "has_m_dim": has_m_dim,
            "mosaic_warnings": warnings,
            "likely_unstitched": likely_unstitched,
        }

    scene_indices = scene_indices_from_czi(czi)
    channel_indices = channel_indices_from_czi(czi)
    z_indices = z_indices_from_czi(czi)
    scene = scene_indices[0] if scene_indices else 0
    channel = channel_indices[0] if channel_indices else 0
    z = z_indices[0] if z_indices else 0

    try:
        plane = read_czi_plane(czi, scene, z, channel)
    except Exception as exc:
        warnings.append(f"Could not read a sample mosaic plane: {exc}")
        return {
            "is_mosaic": is_mosaic,
            "m_tile_count": m_tile_count,
            "has_m_dim": has_m_dim,
            "mosaic_warnings": warnings,
            "likely_unstitched": likely_unstitched,
        }

    import numpy as _np

    plane_h, plane_w = int(_np.asarray(plane).shape[0]), int(_np.asarray(plane).shape[1])
    scene_bbox = None
    get_scene_bbox = getattr(czi, "get_mosaic_scene_bounding_box", None)
    if callable(get_scene_bbox):
        try:
            scene_bbox = get_scene_bbox(scene)
        except Exception:
            scene_bbox = None
    scene_w, scene_h = bbox_width_height(scene_bbox)
    if scene_w > 0 and scene_h > 0:
        cover_w = plane_w / scene_w
        cover_h = plane_h / scene_h
        if cover_w < 0.85 or cover_h < 0.85:
            likely_unstitched = True
            warnings.append(
                f"Sample read is {plane_w}×{plane_h} px but the mosaic scene bounding box "
                f"is {scene_w}×{scene_h} px — tiles may not be stitched. Stitch in ZEN before import."
            )

    get_tiles = getattr(czi, "get_all_mosaic_tile_bounding_boxes", None)
    if callable(get_tiles) and has_m_dim:
        try:
            tiles = get_tiles(S=scene, Z=z, C=channel) or {}
            if len(tiles) > 1 and scene_w > 0 and scene_h > 0:
                max_tile_w = 0
                max_tile_h = 0
                for bbox in tiles.values():
                    tw, th = bbox_width_height(bbox)
                    max_tile_w = max(max_tile_w, tw)
                    max_tile_h = max(max_tile_h, th)
                if (
                    max_tile_w > 0
                    and max_tile_h > 0
                    and plane_w <= int(max_tile_w * 1.05)
                    and plane_h <= int(max_tile_h * 1.05)
                    and (plane_w < int(scene_w * 0.9) or plane_h < int(scene_h * 0.9))
                ):
                    likely_unstitched = True
                    warnings.append(
                        f"Read plane matches one tile ({plane_w}×{plane_h} px) but "
                        f"{len(tiles)} tiles span {scene_w}×{scene_h} px — stitch the mosaic in ZEN first."
                    )
        except Exception:
            pass

    return {
        "is_mosaic": is_mosaic,
        "m_tile_count": m_tile_count,
        "has_m_dim": has_m_dim,
        "mosaic_warnings": warnings,
        "likely_unstitched": likely_unstitched,
    }


def collapse_z_stack_to_2d(stack: Any) -> Any:
    """Collapse a z-stack array to 2D; single-plane stacks squeeze instead of max."""
    import numpy as _np

    arr = _np.asarray(stack)
    if arr.ndim <= 2:
        return arr
    if arr.shape[0] == 1:
        return arr[0]
    if arr.ndim == 3 and arr.shape[-1] == 1:
        return arr[..., 0]
    z_axis = int(_np.argmin(arr.shape))
    if int(arr.shape[z_axis]) == 1:
        return _np.squeeze(arr, axis=z_axis)
    return _np.max(arr, axis=z_axis)


def unpack_read_image(result: Any) -> tuple[Any, list[tuple[str, int]]]:
    """Accept bare ndarray (legacy) or aicspylibczi 3.x (data, dims) tuple."""
    if isinstance(result, tuple) and len(result) == 2:
        data, dims = result
        if isinstance(dims, list):
            return data, [(str(d[0]), int(d[1])) for d in dims if len(d) >= 2]
    return result, []


def collapse_to_plane_2d(
    data: Any,
    dims: list[tuple[str, int]],
    fixed: set[str] | None = None,
) -> Any:
    """Index 0 for kwargs-fixed dimensions; keep Y/X axes."""
    import numpy as _np

    fixed_upper = {str(d).upper() for d in (fixed or set())}
    arr = _np.asarray(data)
    if not dims:
        return arr
    letters = [str(d[0]).upper() for d in dims]
    for axis in range(len(letters) - 1, -1, -1):
        if axis >= arr.ndim:
            continue
        if letters[axis] in fixed_upper:
            arr = _np.take(arr, 0, axis=axis)
    return arr


def _plane_area(plane: Any) -> int:
    import numpy as _np

    arr = _np.asarray(plane)
    while arr.ndim > 2:
        arr = arr[0]
    if arr.ndim < 2:
        return 0
    return int(arr.shape[0]) * int(arr.shape[1])


def select_largest_plane(data: Any) -> tuple[Any, bool]:
    """When pyramid levels stack on a leading axis, pick the largest Y×X plane."""
    import numpy as _np

    arr = _np.asarray(data)
    if arr.ndim == 1 and arr.dtype == object:
        best = arr[0]
        best_area = _plane_area(best)
        picked = False
        for i in range(1, int(arr.shape[0])):
            area = _plane_area(arr[i])
            if area > best_area:
                best_area = area
                best = arr[i]
                picked = True
        return _np.asarray(best), picked

    selected = False
    while arr.ndim > 2:
        best_idx = 0
        best_area = -1
        for i in range(int(arr.shape[0])):
            area = _plane_area(arr[i])
            if area > best_area:
                best_area = area
                best_idx = i
        if best_area <= 0:
            arr = arr[0]
        else:
            if best_idx != 0 or int(arr.shape[0]) > 1:
                selected = True
            arr = arr[best_idx]
    return arr, selected


def read_czi_plane(czi, scene: int, z: int, channel: int) -> Any:
    """Read one S/Z/C plane at full resolution (pyramid-safe, mosaic-aware)."""
    import numpy as _np

    is_mosaic = bool(getattr(czi, "is_mosaic", lambda: False)())
    fixed = {"S", "Z", "C"}
    if is_mosaic:
        result = czi.read_mosaic(scale_factor=1.0, S=scene, Z=z, C=channel)
        data, dims = unpack_read_image(result)
        if not isinstance(data, _np.ndarray):
            data = _np.asarray(data)
        plane = data
        while plane.ndim > 2:
            plane = plane[0]
    else:
        result = czi.read_image(S=scene, Z=z, C=channel)
        data, dims = unpack_read_image(result)
        plane = collapse_to_plane_2d(data, dims, fixed=fixed)
        plane, picked = select_largest_plane(plane)
        if picked:
            h, w = plane.shape[:2]
            emit_log(f"  selected largest plane ({h}×{w})")
    if plane.dtype != _np.uint8 and plane.dtype != _np.uint16:
        plane = plane.astype(_np.uint16)
    return plane
