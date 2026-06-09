"""Adjust paint-region search must read catalog nodes from the real key.

load_catalog stores region nodes under "by_id"; the search/completer helper
previously read "byId" and always returned an empty list, so users could not
search for a paint target by acronym/name.
"""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import sys
import types
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_DIR = _REPO_ROOT / "py"
if str(_PY_DIR) not in sys.path:
    sys.path.insert(0, str(_PY_DIR))

pytest.importorskip("qtpy.QtWidgets")

from structure_catalog import load_catalog  # noqa: E402

_GRAPH_PATH = _REPO_ROOT / "csv" / "structure_graph.json"


def test_flatten_catalog_regions_uses_by_id() -> None:
    import adjust  # noqa: E402

    catalog = load_catalog(_GRAPH_PATH)
    fake_self = types.SimpleNamespace(catalog=catalog)

    # Unbound call: the method only reads self.catalog.
    all_regions = adjust.AnnotationViewer._flatten_catalog_regions(fake_self, "")
    assert len(all_regions) == len(catalog["by_id"]) > 1000

    # A targeted query should narrow the list (search actually works now).
    filtered = adjust.AnnotationViewer._flatten_catalog_regions(fake_self, "VIS")
    assert 0 < len(filtered) < len(all_regions)
    assert all(
        "vis" in f"{n.get('acronym', '')} {n.get('name', '')}".lower()
        for n in filtered
    )
