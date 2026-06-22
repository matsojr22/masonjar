"""Tests for forward AP extrapolation during Align navigation."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_PY = Path(__file__).resolve().parents[2] / "py"
sys.path.insert(0, str(REPO_PY))

from align_session import extrapolate_ap_positions  # noqa: E402


def test_linear_extrapolation_increases_when_confirmed_increase() -> None:
    # User on section index 1 (2 sections confirmed): AP 500, 520
    updates = extrapolate_ap_positions([500, 520], 5, max_ap=1319)
    assert updates == [(2, 540), (3, 560), (4, 580)]


def test_linear_extrapolation_does_not_touch_confirmed_indices() -> None:
    updates = extrapolate_ap_positions([400, 450], 4, max_ap=1319)
    indices = [idx for idx, _ in updates]
    assert 0 not in indices
    assert 1 not in indices
    assert indices == [2, 3]


def test_needs_two_confirmed_sections() -> None:
    assert extrapolate_ap_positions([500], 5, max_ap=1319) == []


def test_clamps_to_max_ap() -> None:
    updates = extrapolate_ap_positions([1300, 1310], 4, max_ap=1319)
    assert all(ap <= 1319 for _, ap in updates)


def test_poly_extrapolation_with_three_points() -> None:
    updates = extrapolate_ap_positions([100, 120, 140], 6, max_ap=1319)
    assert len(updates) == 3
    assert updates[0][0] == 3
    assert updates[0][1] > 140
