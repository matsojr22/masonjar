"""Bundle ledger of in-place image edits. Scripts write this; the menu only reads it."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

LEDGER_NAME = "image_operations.json"
DAPI_PREFIX = ("data", "counting", "00_dapi")
PREVIEW_PREFIX = ("data", "counting", "_previews")
MAX_PREFIX = ("data", "counting", "03_max")


def ledger_path(bundle_root: Path) -> Path:
    return Path(bundle_root) / ".masonjar" / LEDGER_NAME


def classify_bundle_path(bundle_root: Path, path: Path | str) -> str | None:
    """Stable target key for a file inside the bundle, or None when it is not a listed row."""
    rel = _relative_parts(bundle_root, path)
    if rel[:3] == DAPI_PREFIX:
        return "dapi"
    if rel[:3] == PREVIEW_PREFIX:
        return "previews"
    if rel[:3] == MAX_PREFIX and len(rel) >= 5:
        leaf = "/".join(rel[3:-1])
        if leaf:
            return "max:" + leaf
    return None


def slice_id_for_path(path: Path | str, target: str) -> str:
    stem = Path(path).stem
    if target == "previews" and "_" in stem:
        return stem.rsplit("_", 1)[0]
    return stem


def load_ledger(bundle_root: Path) -> dict:
    path = ledger_path(bundle_root)
    if not path.is_file():
        return {"targets": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"targets": {}}
    if not isinstance(data, dict):
        return {"targets": {}}
    targets = data.get("targets")
    if not isinstance(targets, dict):
        data["targets"] = {}
    return data


def save_ledger(bundle_root: Path, ledger: dict) -> None:
    path = ledger_path(bundle_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(ledger, indent=2)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def record_append(
    bundle_root: Path,
    paths: list,
    op: str,
    *,
    deprecated: bool,
) -> None:
    """Append one op on each target these files belong to. Does not clear older ops."""
    grouped = _group_paths(bundle_root, paths)
    if not grouped:
        return
    ledger = load_ledger(bundle_root)
    targets = ledger.setdefault("targets", {})
    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    for key, info in grouped.items():
        entry = targets.setdefault(key, {"ops": []})
        ops = entry.get("ops")
        if not isinstance(ops, list):
            ops = []
            entry["ops"] = ops
        ops.append(
            {
                "op": op,
                "at": stamp,
                "slices": len(info["slices"]),
                "files": info["files"],
                "deprecated": bool(deprecated),
            }
        )
    save_ledger(bundle_root, ledger)


def record_replace(bundle_root: Path, paths: list | None = None, keys: list | None = None) -> None:
    """Drop older ops on targets whose pixels were written fresh."""
    target_keys = set(keys or [])
    if paths:
        target_keys.update(_group_paths(bundle_root, paths).keys())
    if not target_keys:
        return
    ledger = load_ledger(bundle_root)
    targets = ledger.setdefault("targets", {})
    changed = False
    for key in target_keys:
        entry = targets.get(key)
        if isinstance(entry, dict) and entry.get("ops"):
            entry["ops"] = []
            changed = True
    if changed or ledger_path(bundle_root).is_file():
        if changed:
            save_ledger(bundle_root, ledger)


def geometry_is_deprecated(apply_source: str) -> bool:
    """Only the deprecated Orient slices page is a deprecated geometry edit."""
    return str(apply_source or "") == "orient"


def record_tissue_cleanup(bundle_root: Path, result: dict) -> None:
    if not result.get("ok"):
        return
    paths: list = []
    slices = result.get("slices") or {}
    if isinstance(slices, dict):
        for entry in slices.values():
            if isinstance(entry, dict):
                paths.extend(entry.get("files_touched") or [])
    record_append(bundle_root, paths, "tissue_cleanup", deprecated=False)


def bundle_root_from_dapi_dir(input_dir: Path) -> Path | None:
    resolved = Path(input_dir).resolve()
    if resolved.name.lower() != "00_dapi":
        return None
    counting = resolved.parent
    data = counting.parent
    if counting.name != "counting" or data.name != "data":
        return None
    return data.parent


def record_dapi_inplace(input_dir: Path, succeeded_files: list) -> None:
    root = bundle_root_from_dapi_dir(input_dir)
    if root is None or not succeeded_files:
        return
    record_append(root, succeeded_files, "dapi_cleanup", deprecated=True)


def record_geometry(bundle_root: Path, paths: list, apply_source: str) -> None:
    record_append(
        bundle_root,
        paths,
        "orient",
        deprecated=geometry_is_deprecated(apply_source),
    )


def reextract_replace_keys(extracted_roles: dict | None, refreshed_max_rels: list | None) -> list[str]:
    """Targets whose pixels a CZI re-extract wrote fresh."""
    keys: list[str] = []
    roles = extracted_roles or {}
    if roles.get("dapi"):
        keys.append("dapi")
    if any(roles.values()):
        keys.append("previews")
    for rel in refreshed_max_rels or []:
        clean = str(rel).replace("\\", "/").strip("/")
        if clean:
            keys.append("max:" + clean)
    return keys


def _relative_parts(bundle_root: Path, path: Path | str) -> tuple[str, ...]:
    raw = Path(path)
    try:
        rel = raw.resolve().relative_to(Path(bundle_root).resolve())
    except (OSError, ValueError):
        rel = raw
    return tuple(part for part in rel.as_posix().split("/") if part not in ("", "."))


def _group_paths(bundle_root: Path, paths: list) -> dict[str, dict]:
    grouped: dict[str, dict] = {}
    for path in paths or []:
        key = classify_bundle_path(bundle_root, path)
        if not key:
            continue
        slot = grouped.setdefault(key, {"files": 0, "slices": set()})
        slot["files"] += 1
        slot["slices"].add(slice_id_for_path(path, key))
    return grouped
