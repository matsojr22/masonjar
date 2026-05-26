"""Flatten Allen CCF structure_graph.json for region pickers (mirrors js/structure_catalog.js)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

GROUP_STYLE_LEVEL = 6

# Semantic tier definitions. Order is the order shown in the Hierarchy dropdown.
# Rules are derived from CCFv3 ``st_level`` plus simple name heuristics so a
# future ontology update keeps working without hardcoded acronym lists.
TIER_DEFS: list[dict[str, Any]] = [
    {
        "id": "major",
        "label": "Major divisions",
        "description": "Cerebrum, brain stem, cerebellum",
    },
    {
        "id": "regions",
        "label": "Classic regions",
        "description": "Isocortex, thalamus, hypothalamus, midbrain, …",
    },
    {
        "id": "areas",
        "label": "Functional areas",
        "description": "Sensory, motor, association (VIS, AUD, SSp, MO, RSP, …)",
    },
    {
        "id": "subareas",
        "label": "Sub-areas",
        "description": "VISp, VISal, SSp-bfd, ACAd, individual nuclei",
    },
    {
        "id": "layers",
        "label": "Cortical layers",
        "description": "VISp1, VISp2/3, ACA6a, …",
    },
]

CCF_ADVANCED_HELP = (
    "Allen Institute CCFv3 ontology depths (st_level 0–11). Some depths group "
    "structures that are not anatomically meaningful (e.g. Level 4 contains "
    "only Cortical plate). Use the standard tiers above for everyday region "
    "picking."
)


def _parse_id_path(id_path: str | list[int] | None) -> list[int]:
    if not id_path:
        return []
    if isinstance(id_path, list):
        return list(id_path)
    return [int(part) for part in str(id_path).split("/") if part]


def group_parent_for_region(region: dict[str, Any], by_id: dict[int, dict[str, Any]]):
    if not region:
        return None
    path_ids = region.get("idPath") or _parse_id_path(region.get("id_path"))
    if not path_ids:
        path_ids = [region["id"]]
    at_level = None
    nearest_shallow = None
    for nid in path_ids:
        node = by_id.get(nid)
        if not node:
            continue
        if node["st_level"] == GROUP_STYLE_LEVEL:
            at_level = node
        if node["st_level"] < GROUP_STYLE_LEVEL:
            nearest_shallow = node
    if at_level:
        return at_level
    if nearest_shallow:
        return nearest_shallow
    return region


def _flatten_graph(
    graph: dict[str, Any],
    id_path: list[int],
    nodes: list[dict[str, Any]],
    by_id: dict[int, dict[str, Any]],
    by_acronym: dict[str, dict[str, Any]],
) -> None:
    current_path = id_path + [graph["id"]]
    node = {
        "id": graph["id"],
        "acronym": graph["acronym"],
        "name": graph["name"],
        "st_level": graph["st_level"],
        "idPath": current_path,
        "id_path": "/".join(str(i) for i in current_path),
        "groupParentId": graph["id"],
        "groupParentAcronym": graph["acronym"],
        "groupParentName": graph["name"],
        "color_hex_triplet": graph.get("color_hex_triplet"),
    }
    nodes.append(node)
    by_id[graph["id"]] = node
    acronym = graph.get("acronym")
    if acronym and acronym not in by_acronym:
        by_acronym[acronym] = node
    for child in graph.get("children") or []:
        _flatten_graph(child, current_path, nodes, by_id, by_acronym)


def load_catalog(graph_path: str | Path) -> dict[str, Any]:
    """Load and flatten structure_graph.json into a catalog dict."""
    graph_path = Path(graph_path)
    with graph_path.open("r", encoding="utf-8") as f:
        root = json.load(f)
    nodes: list[dict[str, Any]] = []
    by_id: dict[int, dict[str, Any]] = {}
    by_acronym: dict[str, dict[str, Any]] = {}
    _flatten_graph(root, [], nodes, by_id, by_acronym)
    for node in nodes:
        group_node = group_parent_for_region(node, by_id)
        if group_node:
            node["groupParentId"] = group_node["id"]
            node["groupParentAcronym"] = group_node["acronym"]
            node["groupParentName"] = group_node["name"]
    levels: dict[int, dict[str, Any]] = {}
    for node in nodes:
        lvl = node["st_level"]
        if lvl not in levels:
            levels[lvl] = node
    return {
        "nodes": nodes,
        "by_id": by_id,
        "by_acronym": by_acronym,
        "levels": levels,
    }


def _is_layer_name(node: dict[str, Any]) -> bool:
    return "layer" in str(node.get("name", "")).lower()


def _tier_region_ids(tier_id: str, catalog: dict[str, Any]) -> list[int]:
    """Apply the tier rule from the plan (data-driven, no acronym hardcoding)."""
    nodes = catalog["nodes"]
    if tier_id == "major":
        return [n["id"] for n in nodes if n["st_level"] == 2]
    if tier_id == "regions":
        return [n["id"] for n in nodes if n["st_level"] == 5]
    if tier_id == "areas":
        return [n["id"] for n in nodes if n["st_level"] == 6]
    if tier_id == "subareas":
        return [
            n["id"]
            for n in nodes
            if n["st_level"] == 8 and not _is_layer_name(n)
        ]
    if tier_id == "layers":
        return [
            n["id"]
            for n in nodes
            if n["st_level"] == 11 or _is_layer_name(n)
        ]
    return []


def list_tiers(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    """Curated semantic tiers (default Hierarchy picker for both toolsets)."""
    out: list[dict[str, Any]] = []
    for tier in TIER_DEFS:
        region_ids = _tier_region_ids(tier["id"], catalog)
        region_ids = sorted(set(region_ids))
        out.append(
            {
                "id": tier["id"],
                "label": tier["label"],
                "description": tier["description"],
                "region_ids": region_ids,
            }
        )
    return out


def list_regions_for_tier(
    tier_id: str,
    catalog: dict[str, Any],
    search_query: str = "",
) -> list[dict[str, Any]]:
    """Region rows for a semantic tier, sorted by acronym; supports search."""
    ids = set(_tier_region_ids(tier_id, catalog))
    q = (search_query or "").strip().lower()
    out: list[dict[str, Any]] = []
    for node in catalog["nodes"]:
        if node["id"] not in ids:
            continue
        if q:
            hay = (
                f"{node['acronym']} {node['name']} {node['groupParentAcronym']}"
            ).lower()
            if q not in hay:
                continue
        out.append(node)
    out.sort(key=lambda item: item["acronym"])
    return out


def _level_kind(level: int, count: int, layer_share: float) -> str:
    if layer_share >= 0.25:
        return "layers"
    if count == 1:
        return "single structure"
    if level <= 3:
        return "major divisions"
    if count <= 20:
        return "divisions"
    return "regions"


def _level_info_for_st(
    level: int,
    catalog: dict[str, Any],
    *,
    max_samples: int = 5,
) -> dict[str, Any]:
    acronyms: list[str] = []
    layer_count = 0
    seen: set[str] = set()
    for node in catalog["nodes"]:
        if node["st_level"] != level:
            continue
        ac = node["acronym"]
        if ac not in seen:
            seen.add(ac)
            acronyms.append(ac)
        if _is_layer_name(node):
            layer_count += 1
    acronyms.sort()
    count = len(acronyms)
    layer_share = (layer_count / count) if count else 0.0
    kind = _level_kind(level, count, layer_share)
    samples = acronyms[:max_samples]
    has_more = count > len(samples)
    return {
        "level": level,
        "count": count,
        "kind": kind,
        "sampleAcronyms": samples,
        "hasMore": has_more,
    }


def list_ccf_levels(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    """Enriched CCFv3 raw depths (used by Advanced toggle).

    Each entry: ``level, count, kind, sampleAcronyms, hasMore``.
    """
    levels: list[int] = sorted({n["st_level"] for n in catalog["nodes"]})
    return [_level_info_for_st(lvl, catalog) for lvl in levels]


def format_ccf_level_label(info: dict[str, Any]) -> str:
    """E.g. ``Level 6 — 34 regions (AUD, DORpm, GU, MO, SS, …)``.

    Same template as the JS sibling so PyQt and Electron labels match.
    """
    samples = list(info.get("sampleAcronyms") or [])
    suffix = ""
    if samples:
        joined = ", ".join(samples)
        if info.get("hasMore"):
            joined += ", …"
        suffix = f" ({joined})"
    return f"Level {info['level']} — {info['count']} {info['kind']}{suffix}"


def list_levels(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    """Backward-compatible sorted CCF levels.

    Kept for tests and existing callers; new UIs should use
    :func:`list_ccf_levels` + :func:`format_ccf_level_label` for the Advanced
    mode, or :func:`list_tiers` for the default semantic picker.
    """
    seen: set[int] = set()
    out: list[dict[str, Any]] = []
    for node in catalog["nodes"]:
        lvl = node["st_level"]
        if lvl in seen:
            continue
        seen.add(lvl)
        example = catalog["levels"][lvl]
        out.append(
            {
                "level": lvl,
                "exampleAcronym": example["acronym"],
                "exampleName": example["name"],
            }
        )
    out.sort(key=lambda item: item["level"])
    return out


def list_regions_at_level(
    level: int,
    search_query: str = "",
    catalog: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Regions at st_level, optional acronym/name/group-parent search; sorted by acronym."""
    if catalog is None:
        raise ValueError("catalog is required")
    q = (search_query or "").strip().lower()
    out: list[dict[str, Any]] = []
    for node in catalog["nodes"]:
        if node["st_level"] != level:
            continue
        if q:
            hay = (
                f"{node['acronym']} {node['name']} {node['groupParentAcronym']}"
            ).lower()
            if q not in hay:
                continue
        out.append(node)
    out.sort(key=lambda item: item["acronym"])
    return out


def get_region(region_id: int, catalog: dict[str, Any]) -> dict[str, Any] | None:
    return catalog["by_id"].get(int(region_id))
