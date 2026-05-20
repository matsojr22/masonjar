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
