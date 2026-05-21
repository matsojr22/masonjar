"""Low-resolution background channel discovery for Viewer/Editor (adjust)."""

from __future__ import annotations

from pathlib import Path


def resolve_previews_dir(images_dir: Path) -> Path | None:
    """Return ``data/counting/_previews`` sibling of ``00_dapi`` if it exists."""
    candidate = Path(images_dir).parent / "_previews"
    return candidate if candidate.is_dir() else None


def _display_name_from_suffix(suffix: str) -> str:
    return suffix.replace("_", " ").title()


def lowres_channels_for_slice(
    images_dir: Path,
    slice_id: str,
    previews_dir: Path | None = None,
) -> list[tuple[str, Path]]:
    """Return ``[(display_name, path), ...]`` from ``_previews/{sliceId}_*.png`` only."""
    images_dir = Path(images_dir)
    if previews_dir is None:
        previews_dir = resolve_previews_dir(images_dir)

    channels: list[tuple[str, Path]] = []
    if previews_dir is None or not previews_dir.is_dir():
        return channels

    prefix = f"{slice_id}_"
    for entry in sorted(previews_dir.iterdir()):
        if not entry.is_file():
            continue
        name = entry.name
        if not name.lower().endswith(".png"):
            continue
        if not name.startswith(prefix):
            continue
        suffix = entry.stem[len(slice_id) + 1 :]
        if not suffix:
            continue
        channels.append((_display_name_from_suffix(suffix), entry))

    return channels
