"""Detection QC histograms for Cell Detection runs."""

from __future__ import annotations

import json
import math
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np

RUN_QC_FILES = (
    "detect_qc_confidence.png",
    "detect_qc_long_axis_px.png",
    "detect_qc_eccentricity.png",
)
SUMMARY_JSON = "detect_qc_summary.json"
SLICES_DIR = "detect_qc_slices"


def bbox_area(box) -> float:
    x1, y1, x2, y2 = box
    return float(max(0.0, x2 - x1) * max(0.0, y2 - y1))


def bbox_long_axis(box) -> float:
    x1, y1, x2, y2 = box
    return float(max(max(0.0, x2 - x1), max(0.0, y2 - y1)))


def object_confidence(obj) -> float:
    score = getattr(obj, "score", None)
    if score is None:
        return float("nan")
    return float(getattr(score, "value", score))


def object_xyxy(obj):
    return obj.bbox.to_xyxy()


@dataclass
class QcMetricLists:
    confidence: list[float] = field(default_factory=list)
    long_axis: list[float] = field(default_factory=list)
    area: list[float] = field(default_factory=list)
    eccentricity: list[float] = field(default_factory=list)

    def extend_from_objects(self, objects, *, include_eccentricity: list[float] | None = None):
        for obj in objects or []:
            box = object_xyxy(obj)
            self.confidence.append(object_confidence(obj))
            self.long_axis.append(bbox_long_axis(box))
            self.area.append(bbox_area(box))
        if include_eccentricity:
            self.eccentricity.extend(include_eccentricity)

    def merge_into(self, other: "QcMetricLists") -> None:
        other.confidence.extend(self.confidence)
        other.long_axis.extend(self.long_axis)
        other.area.extend(self.area)
        other.eccentricity.extend(self.eccentricity)


@dataclass
class DetectQcCollector:
    run: QcMetricLists = field(default_factory=QcMetricLists)
    raw_run: QcMetricLists = field(default_factory=QcMetricLists)
    pre_ecc_run: QcMetricLists = field(default_factory=QcMetricLists)
    slices: dict[str, QcMetricLists] = field(default_factory=dict)
    raw_slices: dict[str, QcMetricLists] = field(default_factory=dict)
    pre_ecc_slices: dict[str, QcMetricLists] = field(default_factory=dict)

    def _slice_bucket(self, mapping: dict[str, QcMetricLists], slice_id: str) -> QcMetricLists:
        if slice_id not in mapping:
            mapping[slice_id] = QcMetricLists()
        return mapping[slice_id]

    def add_slice_pass(
        self,
        slice_id: str,
        raw_objects,
        pre_ecc_objects,
        final_objects,
        pre_ecc_eccentricities: list[float] | None = None,
    ) -> None:
        pre_ecc_eccentricities = pre_ecc_eccentricities or []

        raw_slice = self._slice_bucket(self.raw_slices, slice_id)
        raw_slice.extend_from_objects(raw_objects)
        self.raw_run.extend_from_objects(raw_objects)

        pre_ecc_slice = self._slice_bucket(self.pre_ecc_slices, slice_id)
        pre_ecc_slice.eccentricity.extend(pre_ecc_eccentricities)
        self.pre_ecc_run.eccentricity.extend(pre_ecc_eccentricities)

        final_slice = self._slice_bucket(self.slices, slice_id)
        final_slice.extend_from_objects(final_objects)
        self.run.extend_from_objects(final_objects)


def cleanup_detect_qc_artifacts(output_dir: Path) -> list[str]:
    output_dir = Path(output_dir)
    removed: list[str] = []
    for name in (*RUN_QC_FILES, SUMMARY_JSON):
        path = output_dir / name
        if path.is_file():
            path.unlink()
            removed.append(name)
    slices_root = output_dir / SLICES_DIR
    if slices_root.is_dir():
        shutil.rmtree(slices_root)
        removed.append(SLICES_DIR + "/")
    return removed


def _percentile(values: list[float], pct: float) -> float | None:
    clean = [float(v) for v in values if v is not None and not math.isnan(v)]
    if not clean:
        return None
    return float(np.percentile(clean, pct))


def _summary_stats(values: list[float]) -> dict[str, Any]:
    clean = [float(v) for v in values if v is not None and not math.isnan(v)]
    if not clean:
        return {"count": 0, "median": None, "p10": None, "p90": None}
    arr = np.asarray(clean, dtype=float)
    return {
        "count": int(arr.size),
        "median": float(np.median(arr)),
        "p10": float(np.percentile(arr, 10)),
        "p90": float(np.percentile(arr, 90)),
    }


def build_summary_payload(
    collector: DetectQcCollector,
    thresholds: dict[str, float],
    *,
    per_slice_enabled: bool,
    run_files: list[str],
    slice_files: dict[str, list[str]],
) -> dict[str, Any]:
    return {
        "thresholds": thresholds,
        "run": {
            "raw": {
                "confidence": _summary_stats(collector.raw_run.confidence),
                "long_axis_px": _summary_stats(collector.raw_run.long_axis),
                "area_px2": _summary_stats(collector.raw_run.area),
            },
            "pre_eccentricity_filter": {
                "eccentricity": _summary_stats(collector.pre_ecc_run.eccentricity),
            },
            "final": {
                "confidence": _summary_stats(collector.run.confidence),
                "long_axis_px": _summary_stats(collector.run.long_axis),
                "area_px2": _summary_stats(collector.run.area),
            },
        },
        "per_slice_enabled": bool(per_slice_enabled),
        "artifacts": {
            "run": run_files,
            "per_slice_dir": SLICES_DIR if per_slice_enabled else None,
            "per_slice": slice_files,
        },
    }


def _plot_dual_histogram(
    path: Path,
    title: str,
    xlabel: str,
    raw_values: list[float],
    final_values: list[float],
    *,
    threshold: float | None = None,
    threshold_label: str | None = None,
    xlim: tuple[float, float] | None = None,
) -> None:
    fig, ax = plt.subplots(figsize=(7, 4.5), dpi=120)
    raw_clean = [float(v) for v in raw_values if v is not None and not math.isnan(v)]
    final_clean = [float(v) for v in final_values if v is not None and not math.isnan(v)]

    if raw_clean:
        ax.hist(
            raw_clean,
            bins=min(40, max(10, len(raw_clean) // 5)),
            alpha=0.45,
            color="#6c757d",
            label=f"Raw SAHI ({len(raw_clean)})",
            edgecolor="white",
            linewidth=0.4,
        )
    if final_clean:
        ax.hist(
            final_clean,
            bins=min(40, max(10, len(final_clean) // 5)),
            alpha=0.75,
            color="#0d6efd",
            label=f"Final saved ({len(final_clean)})",
            edgecolor="white",
            linewidth=0.4,
        )
    if not raw_clean and not final_clean:
        ax.text(
            0.5,
            0.5,
            "No detections",
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=12,
            color="#666",
        )

    if threshold is not None:
        ax.axvline(
            threshold,
            color="#dc3545",
            linestyle="--",
            linewidth=1.5,
            label=threshold_label or f"Threshold = {threshold:g}",
        )

    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel("Count")
    if xlim:
        ax.set_xlim(xlim)
    ax.legend(loc="best", fontsize=8)
    ax.grid(True, alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def _plot_eccentricity_histogram(
    path: Path,
    values: list[float],
    *,
    threshold: float | None = None,
) -> None:
    fig, ax = plt.subplots(figsize=(7, 4.5), dpi=120)
    clean = [float(v) for v in values if v is not None and not math.isnan(v)]
    if clean:
        ax.hist(
            clean,
            bins=min(40, max(10, len(clean) // 5)),
            alpha=0.75,
            color="#198754",
            label=f"Pre-eccentricity filter ({len(clean)})",
            edgecolor="white",
            linewidth=0.4,
        )
    else:
        ax.text(
            0.5,
            0.5,
            "No detections",
            transform=ax.transAxes,
            ha="center",
            va="center",
            fontsize=12,
            color="#666",
        )
    if threshold is not None:
        ax.axvline(
            threshold,
            color="#dc3545",
            linestyle="--",
            linewidth=1.5,
            label=f"Eccentricity cutoff = {threshold:g}",
        )
    ax.set_title("Eccentricity (post-area filter)")
    ax.set_xlabel("Eccentricity")
    ax.set_ylabel("Count")
    ax.set_xlim(0, 1)
    ax.legend(loc="best", fontsize=8)
    ax.grid(True, alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def write_slice_histograms(
    collector: DetectQcCollector,
    slice_id: str,
    output_dir: Path,
    thresholds: dict[str, float],
) -> list[str]:
    output_dir = Path(output_dir)
    slice_dir = output_dir / SLICES_DIR / slice_id
    slice_dir.mkdir(parents=True, exist_ok=True)

    raw = collector.raw_slices.get(slice_id, QcMetricLists())
    final = collector.slices.get(slice_id, QcMetricLists())
    pre_ecc = collector.pre_ecc_slices.get(slice_id, QcMetricLists())

    files = [
        "confidence.png",
        "long_axis_px.png",
        "eccentricity.png",
    ]
    _plot_dual_histogram(
        slice_dir / files[0],
        f"Confidence — {slice_id}",
        "Confidence",
        raw.confidence,
        final.confidence,
        threshold=thresholds.get("confidence"),
        threshold_label=f"Confidence cutoff = {thresholds.get('confidence')}",
        xlim=(0, 1),
    )
    _plot_dual_histogram(
        slice_dir / files[1],
        f"BBox long axis — {slice_id}",
        "Long axis (px)",
        raw.long_axis,
        final.long_axis,
        threshold=None,
    )
    _plot_eccentricity_histogram(
        slice_dir / files[2],
        pre_ecc.eccentricity,
        threshold=thresholds.get("eccentricity"),
    )
    return [f"{SLICES_DIR}/{slice_id}/{name}" for name in files]


def write_run_histograms(
    collector: DetectQcCollector,
    output_dir: Path,
    thresholds: dict[str, float],
    *,
    per_slice_enabled: bool = False,
) -> dict[str, Any]:
    output_dir = Path(output_dir)
    run_files = []

    confidence_path = output_dir / RUN_QC_FILES[0]
    _plot_dual_histogram(
        confidence_path,
        "Detection confidence (run total)",
        "Confidence",
        collector.raw_run.confidence,
        collector.run.confidence,
        threshold=thresholds.get("confidence"),
        threshold_label=f"Confidence cutoff = {thresholds.get('confidence')}",
        xlim=(0, 1),
    )
    run_files.append(RUN_QC_FILES[0])

    long_axis_path = output_dir / RUN_QC_FILES[1]
    _plot_dual_histogram(
        long_axis_path,
        "BBox long axis (run total)",
        "Long axis (px)",
        collector.raw_run.long_axis,
        collector.run.long_axis,
        threshold=None,
    )
    run_files.append(RUN_QC_FILES[1])

    ecc_path = output_dir / RUN_QC_FILES[2]
    _plot_eccentricity_histogram(
        ecc_path,
        collector.pre_ecc_run.eccentricity,
        threshold=thresholds.get("eccentricity"),
    )
    run_files.append(RUN_QC_FILES[2])

    slice_files: dict[str, list[str]] = {}
    if per_slice_enabled:
        for slice_id in sorted(set(collector.slices.keys()) | set(collector.raw_slices.keys())):
            slice_files[slice_id] = write_slice_histograms(
                collector, slice_id, output_dir, thresholds
            )

    summary = build_summary_payload(
        collector,
        thresholds,
        per_slice_enabled=per_slice_enabled,
        run_files=run_files,
        slice_files=slice_files,
    )
    summary_path = output_dir / SUMMARY_JSON
    with open(summary_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)

    return {
        "run_files": run_files,
        "summary_json": SUMMARY_JSON,
        "slice_files": slice_files,
        "summary": summary,
    }
