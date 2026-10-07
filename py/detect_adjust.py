"""Load or rewrite one section of a finished detection run. Does not load the detector."""

from __future__ import annotations

import argparse
import json
import pickle
import shutil
from pathlib import Path


def box_key(box) -> tuple:
    return tuple(round(float(v), 2) for v in list(box)[:4])


def _as_results(payload):
    if isinstance(payload, list):
        return payload
    return [payload]


def filter_requested(source_results, requested) -> list:
    """Keep requested boxes only when each one already exists in the source.

    Returns a list of (boxes, scores, image_dimensions) per source channel.
    Raises ValueError if a requested box was not in that source.
    """
    pools = []
    for result in _as_results(source_results):
        boxes = [list(box) for box in (getattr(result, "boxes", None) or [])]
        scores = [float(score) for score in (getattr(result, "scores", None) or [])]
        dims = getattr(result, "image_dimensions", None) or (0, 0)
        pool = {}
        for index, box in enumerate(boxes):
            pool.setdefault(box_key(box), []).append(index)
        pools.append(
            {
                "boxes": boxes,
                "scores": scores,
                "dims": (int(dims[0]), int(dims[1])) if len(dims) >= 2 else (0, 0),
                "pool": pool,
            }
        )
    if not pools:
        pools.append({"boxes": [], "scores": [], "dims": (0, 0), "pool": {}})

    chosen = [[] for _ in pools]
    for row in requested or []:
        channel = int(row.get("channel") or 0)
        if channel < 0 or channel >= len(pools):
            raise ValueError("Requested box is not in the source detections")
        key = box_key(row.get("xyxy") or [])
        available = pools[channel]["pool"].get(key) or []
        if not available:
            raise ValueError("Requested box is not in the source detections")
        index = available.pop(0)
        chosen[channel].append(index)

    out = []
    for channel, pool in enumerate(pools):
        boxes = []
        scores = []
        for index in chosen[channel]:
            boxes.append([float(v) for v in pool["boxes"][index]])
            score = pool["scores"][index] if index < len(pool["scores"]) else 0.0
            scores.append(float(score))
        out.append((boxes, scores, pool["dims"]))
    return out


def results_from_channels(channels) -> list:
    from find_neurons import DetectionResult

    built = []
    for boxes, scores, dims in channels:
        built.append(DetectionResult(boxes, scores, dims))
    return built


class _DetectionUnpickler(pickle.Unpickler):
    """Predictions written by find_neurons.py are stored as __main__.DetectionResult."""

    def find_class(self, module, name):
        if name == "DetectionResult" and module in ("__main__", "find_neurons"):
            from find_neurons import DetectionResult

            return DetectionResult
        return super().find_class(module, name)


def load_pickle(path: Path):
    with open(path, "rb") as handle:
        return _as_results(_DetectionUnpickler(handle).load())


def save_pickle(path: Path, results) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as handle:
        pickle.dump(results, handle)


def _emit(prefix: str, payload: dict) -> None:
    print(prefix + json.dumps(payload), flush=True)


def _progress(pct: int, message: str) -> None:
    print(f"PROGRESS:{int(pct)}:{message}", flush=True)


def _measure(results, bgr, gray) -> tuple:
    from detect_qc import bbox_intensity_p90
    from find_neurons import measure_eccentricity

    records = []
    min_score = None
    height = 0
    width = 0
    for channel, result in enumerate(results):
        dims = getattr(result, "image_dimensions", None) or (0, 0)
        if len(dims) >= 2:
            height = int(dims[0]) or height
            width = int(dims[1]) or width
        boxes = list(getattr(result, "boxes", None) or [])
        scores = list(getattr(result, "scores", None) or [])
        for index, box in enumerate(boxes):
            xyxy = [float(v) for v in box]
            score = float(scores[index]) if index < len(scores) else 0.0
            if min_score is None or score < min_score:
                min_score = score
            area = max(0.0, xyxy[2] - xyxy[0]) * max(0.0, xyxy[3] - xyxy[1])
            ecc = measure_eccentricity(xyxy, bgr)
            inten = bbox_intensity_p90(xyxy, gray)
            records.append(
                {
                    "channel": channel,
                    "xyxy": xyxy,
                    "confidence": score,
                    "area_px2": float(area),
                    "eccentricity": None if ecc is None else float(ecc),
                    "intensity_p90": None if inten is None else float(inten),
                }
            )
    if not height or not width:
        height, width = gray.shape[:2]
    return records, min_score, int(height), int(width)


def cutoff_from_intensities(intensities) -> dict:
    """GMM intensity split for the boxes already loaded. Does not invent boxes."""
    from detect_qc_analysis import estimate_intensity_threshold

    values = []
    for value in intensities or []:
        if value is None:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number != number:
            continue
        values.append(number)
    info = estimate_intensity_threshold(values)
    cutoff = info.get("intensity_threshold_estimate") if info.get("bimodal") else None
    return {
        "loadedIntensityMin": int(cutoff) if cutoff is not None else None,
        "loadedIntensityReason": info.get("reason"),
        "loadedIntensityCount": len(values),
    }


def run_preview(args) -> None:
    from detect_param_raw import _scale_gray, _write_gray_png, prepare_detection_image

    image_path = str(args.image or "").strip()
    pkl_path = str(args.pkl or "").strip()
    display_path = Path(str(args.display or "").strip())
    if not image_path or not pkl_path or not str(display_path):
        raise SystemExit("preview needs --image, --pkl, and --display")
    _progress(10, "Loading section…")
    _bgr, gray, full_height, full_width = prepare_detection_image(image_path)
    bgr_full = _bgr
    _progress(40, "Measuring saved detections…")
    results = load_pickle(Path(pkl_path))
    records, min_score, _height, _width = _measure(results, bgr_full, gray)
    cutoff = cutoff_from_intensities(row.get("intensity_p90") for row in records)
    gray_out, scale = _scale_gray(gray, int(args.max_side or 0))
    _progress(80, "Writing section image…")
    _write_gray_png(gray_out, display_path)
    records_path = display_path.with_suffix(".json")
    records_path.write_text(json.dumps({"boxes": records}), encoding="utf-8")
    _progress(100, "Section ready")
    _emit(
        "ADJUST_JSON:",
        {
            "ok": True,
            "displayPath": str(display_path.resolve()),
            "recordsPath": str(records_path.resolve()),
            "count": len(records),
            "minConfidence": min_score,
            "width": int(gray_out.shape[1]),
            "height": int(gray_out.shape[0]),
            "fullWidth": int(full_width),
            "fullHeight": int(full_height),
            "displayScale": scale,
            "loadedIntensityMin": cutoff["loadedIntensityMin"],
            "loadedIntensityReason": cutoff["loadedIntensityReason"],
            "loadedIntensityCount": cutoff["loadedIntensityCount"],
        },
    )


def _read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _snapshot_params(backup_dir: Path, slice_id: str, adjust_path: Path, slice_params_path: Path) -> None:
    dest = backup_dir / (slice_id + ".params.json")
    if dest.is_file():
        return
    adjust = _read_json(adjust_path)
    slice_params = _read_json(slice_params_path)
    slices = slice_params.get("slices") if isinstance(slice_params.get("slices"), dict) else {}
    adjust_slices = adjust.get("slices") if isinstance(adjust.get("slices"), dict) else {}
    _write_json(
        dest,
        {
            "sliceId": slice_id,
            "adjust": adjust_slices.get(slice_id),
            "sliceParams": slices.get(slice_id),
            "hadSliceParams": slice_id in slices,
            "hadAdjust": slice_id in adjust_slices,
        },
    )


def _update_param_files(slice_id: str, params: dict, adjust_path: Path, slice_params_path: Path) -> None:
    adjust = _read_json(adjust_path)
    if not isinstance(adjust.get("slices"), dict):
        adjust["slices"] = {}
    adjust["slices"][slice_id] = params
    _write_json(adjust_path, adjust)

    spec = _read_json(slice_params_path)
    if not isinstance(spec.get("slices"), dict):
        spec["slices"] = {}
    if "default" not in spec:
        spec["default"] = {
            "confidence": 0.5,
            "area": 200,
            "eccentricity": 0.2,
            "intensity_min": 0,
        }
    if "policy" not in spec:
        spec["policy"] = "adjust"
    spec["slices"][slice_id] = params
    _write_json(slice_params_path, spec)


def _source_results(request: dict, pkl_path: Path):
    if str(request.get("source") or "pkl") != "raw":
        return load_pickle(pkl_path)
    raw_path = Path(str(request.get("sourceJson") or ""))
    raw = _read_json(raw_path)
    boxes = []
    scores = []
    width = int(raw.get("width") or 0)
    height = int(raw.get("height") or 0)

    class _Raw:
        def __init__(self):
            self.boxes = boxes
            self.scores = scores
            self.image_dimensions = (height, width)

    for row in raw.get("boxes") or []:
        xyxy = row.get("xyxy") or []
        if len(xyxy) < 4:
            continue
        boxes.append([float(v) for v in xyxy[:4]])
        scores.append(float(row.get("confidence") or 0))
    return [_Raw()]


def run_apply(args) -> None:
    from detect_param_raw import prepare_detection_image
    from find_neurons import export_bboxes

    request_path = Path(str(args.request or "").strip())
    request = _read_json(request_path)
    image_path = str(request.get("image") or "").strip()
    pkl_path = Path(str(request.get("pkl") or "").strip())
    slice_id = str(request.get("sliceId") or "").strip()
    if not image_path or not pkl_path.is_file() or not slice_id:
        raise SystemExit("apply request needs image, pkl, and sliceId")
    _progress(15, "Checking detections…")
    source = _source_results(request, pkl_path)
    channels = filter_requested(source, request.get("requested") or [])
    if str(request.get("source") or "pkl") == "raw":
        # Raw boxes share one image size. Keep a single predictions entry.
        boxes = []
        scores = []
        dims = channels[0][2] if channels else (0, 0)
        for group_boxes, group_scores, group_dims in channels:
            boxes.extend(group_boxes)
            scores.extend(group_scores)
            if group_dims[0] and group_dims[1]:
                dims = group_dims
        channels = [(boxes, scores, dims)]
    results = results_from_channels(channels)
    backup_dir = Path(str(request.get("backupDir") or pkl_path.parent / "adjust_backup"))
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_pkl = backup_dir / pkl_path.name
    if not backup_pkl.is_file():
        shutil.copy2(pkl_path, backup_pkl)
    bboxes_path = Path(str(request.get("bboxes") or ""))
    if bboxes_path and bboxes_path.is_file():
        backup_png = backup_dir / bboxes_path.name
        if not backup_png.is_file():
            shutil.copy2(bboxes_path, backup_png)
    _snapshot_params(
        backup_dir,
        slice_id,
        Path(str(request.get("adjustParams") or "")),
        Path(str(request.get("sliceParams") or "")),
    )
    _progress(55, "Updating predictions…")
    save_pickle(pkl_path, results)
    _progress(75, "Drawing boxes…")
    bgr, _gray, _height, _width = prepare_detection_image(image_path)
    if bboxes_path:
        export_bboxes(bgr.copy(), results[0].boxes if results else [], bboxes_path)
    params = request.get("params") or {}
    if request.get("adjustParams") and request.get("sliceParams"):
        _update_param_files(
            slice_id,
            params,
            Path(str(request.get("adjustParams"))),
            Path(str(request.get("sliceParams"))),
        )
    kept = sum(len(group[0]) for group in channels)
    _progress(100, "Section saved")
    _emit(
        "ADJUST_JSON:",
        {
            "ok": True,
            "pkl": str(pkl_path),
            "count": kept,
            "backupDir": str(backup_dir),
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Adjust one detection section")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--image", default="")
    parser.add_argument("--pkl", default="")
    parser.add_argument("--display", default="")
    parser.add_argument("--request", default="")
    parser.add_argument("--max-side", type=int, default=0)
    args = parser.parse_args()
    if args.preview:
        run_preview(args)
        return
    if args.apply:
        run_apply(args)
        return
    raise SystemExit("detect_adjust needs --preview or --apply")


if __name__ == "__main__":
    main()
