"""Flatten Allen CCF structure_graph.json for region pickers (mirrors js/structure_catalog.js)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

GROUP_STYLE_LEVEL = 6


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


def list_levels(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    """Return sorted CCF levels with one example acronym/name each."""
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
