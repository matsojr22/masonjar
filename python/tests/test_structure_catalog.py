"""Tests for py/structure_catalog.py (CCF catalog mirror of js/structure_catalog.js)."""

import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

from structure_catalog import (  # noqa: E402
    get_region,
    list_levels,
    list_regions_at_level,
    load_catalog,
)

_GRAPH_PATH = _REPO_ROOT / "csv" / "structure_graph.json"


@pytest.fixture(scope="module")
def catalog():
    return load_catalog(_GRAPH_PATH)


def test_load_catalog_size(catalog):
    assert len(catalog["nodes"]) > 1000
    assert len(catalog["by_id"]) == len(catalog["nodes"])


def test_list_levels_sorted(catalog):
    levels = list_levels(catalog)
    assert len(levels) >= 5
    level_nums = [item["level"] for item in levels]
    assert level_nums == sorted(level_nums)
    assert all("exampleAcronym" in item and "exampleName" in item for item in levels)


def test_list_regions_at_level_exact_filter(catalog):
    level6 = list_regions_at_level(6, "", catalog)
    assert len(level6) > 10
    assert all(node["st_level"] == 6 for node in level6)
    acronyms = [node["acronym"] for node in level6]
    assert acronyms == sorted(acronyms)


def test_list_regions_at_level_search(catalog):
    vis_search = list_regions_at_level(8, "visp", catalog)
    assert any(node["acronym"] == "VISp" for node in vis_search)


def test_group_parent_vis_siblings(catalog):
    visp = catalog["by_acronym"]["VISp"]
    visl = catalog["by_acronym"]["VISl"]
    assert visp["groupParentId"] == visl["groupParentId"]
    ssp = catalog["by_acronym"].get("SSp")
    if ssp:
        assert visp["groupParentId"] != ssp["groupParentId"]


def test_get_region(catalog):
    visp = get_region(catalog["by_acronym"]["VISp"]["id"], catalog)
    assert visp is not None
    assert visp["acronym"] == "VISp"
