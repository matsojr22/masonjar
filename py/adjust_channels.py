"""Low-resolution background channel discovery for Viewer/Editor (adjust)."""

from __future__ import annotations

from pathlib import Path


def resolve_previews_dir(images_dir: Path) -> Path | None:
    """Return ``data/counting/_previews`` sibling of ``00_dapi`` if it exists."""
    candidate = Path(images_dir).parent / "_previews"
    return candidate if candidate.is_dir() else None


def _display_name_from_suffix(suffix: str) -> str:
    return suffix.replace("_", " ").title()


def _dapi_path(images_dir: Path, slice_id: str) -> Path | None:
    for ext in (".tif", ".tiff"):
        path = images_dir / f"{slice_id}{ext}"
        if path.is_file():
            return path
    return None


def lowres_channels_for_slice(
    images_dir: Path,
    slice_id: str,
    previews_dir: Path | None = None,
) -> list[tuple[str, Path]]:
    """Return ``[(display_name, path), ...]`` with DAPI first, then preview channels."""
    images_dir = Path(images_dir)
    if previews_dir is None:
        previews_dir = resolve_previews_dir(images_dir)

    channels: list[tuple[str, Path]] = []
    dapi = _dapi_path(images_dir, slice_id)
    if dapi is not None:
        channels.append(("DAPI", dapi))

    if previews_dir is not None and previews_dir.is_dir():
        prefix = f"{slice_id}_"
        preview_paths: list[tuple[str, Path]] = []
        for entry in sorted(previews_dir.iterdir()):
            if not entry.is_file():
                continue
            name = entry.name
            lower = name.lower()
            if not (lower.endswith(".tif") or lower.endswith(".tiff") or lower.endswith(".png")):
                continue
            if not name.startswith(prefix):
                continue
            suffix = entry.stem[len(slice_id) + 1 :]
            if not suffix:
                continue
            preview_paths.append((_display_name_from_suffix(suffix), entry))
        channels.extend(preview_paths)

    return channels
