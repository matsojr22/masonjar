"""Liberal single-section detection export and per-slice parameter helpers.

Electron runs this for the parameterization tool. ``find_neurons.py`` imports the
JSON helpers. Model loading stays lazy so importing the helpers does not load SAHI.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

RAW_CONFIDENCE = 0.05


def _json_number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


def record_passes(
    record: dict,
    confidence: float,
    area: float,
    eccentricity: float,
    intensity_min: float,
) -> bool:
    """Match the Electron screening rules used by the live box overlay."""
    score = _json_number(record.get("confidence"))
    if score is None or score < float(confidence):
        return False
    box_area = _json_number(record.get("area_px2"))
    if box_area is None or not (box_area > float(area)):
        return False
    ecc = record.get("eccentricity")
    if ecc is not None and ecc != "":
        ecc_n = _json_number(ecc)
        if ecc_n is not None and not (ecc_n > float(eccentricity)):
            return False
    cutoff = float(intensity_min or 0)
    if cutoff > 0:
        inten = record.get("intensity_p90")
        if inten is not None and inten != "":
            inten_n = _json_number(inten)
            if inten_n is not None and inten_n < cutoff:
                return False
    return True


def filter_records(
    records: list[dict],
    confidence: float,
    area: float,
    eccentricity: float,
    intensity_min: float = 0,
) -> list[dict]:
    return [
        row
        for row in records or []
        if record_passes(row, confidence, area, eccentricity, intensity_min)
    ]


def _param_row(row: Any, fallback: dict[str, float]) -> dict[str, float]:
    src = row if isinstance(row, dict) else {}
    return {
        "confidence": float(src.get("confidence", fallback["confidence"])),
        "area": float(src.get("area", fallback["area"])),
        "eccentricity": float(src.get("eccentricity", fallback["eccentricity"])),
        "intensity_min": float(src.get("intensity_min", fallback["intensity_min"])),
    }


def load_slice_param_spec(path: str) -> dict:
    text = str(path or "").strip()
    if not text:
        raise ValueError("slice params path is empty")
    with open(text, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("slice params must be a JSON object")
    return data


def min_confidence_in_spec(spec: dict, fallback_confidence: float) -> float:
    values = [float(fallback_confidence)]
    default = spec.get("default")
    if isinstance(default, dict) and default.get("confidence") is not None:
        values.append(float(default["confidence"]))
    slices = spec.get("slices") or {}
    if isinstance(slices, dict):
        for row in slices.values():
            if isinstance(row, dict) and row.get("confidence") is not None:
                values.append(float(row["confidence"]))
    return min(values)


def params_for_slice(spec: dict, slice_id: str, fallback: dict[str, float]) -> dict[str, float]:
    slices = spec.get("slices") or {}
    row = slices.get(slice_id) if isinstance(slices, dict) else None
    if row is None:
        row = spec.get("default")
    return _param_row(row, fallback)


def records_from_objects(objects, bgr_image, gray_image) -> list[dict]:
    from detect_qc import bbox_area, bbox_intensity_p90, object_confidence, object_xyxy
    from find_neurons import measure_eccentricity

    records = []
    for obj in objects or []:
        box = object_xyxy(obj)
        xyxy = [float(v) for v in box]
        ecc = measure_eccentricity(box, bgr_image) if bgr_image is not None else None
        inten = bbox_intensity_p90(box, gray_image) if gray_image is not None else None
        records.append(
            {
                "xyxy": xyxy,
                "confidence": _json_number(object_confidence(obj)),
                "area_px2": float(bbox_area(box)),
                "eccentricity": _json_number(ecc),
                "intensity_p90": _json_number(inten),
            }
        )
    return records


def prepare_detection_image(image_path: str):
    import cv2
    import numpy as np
    import tifffile as tiff
    from skimage.exposure import equalize_adapthist

    path = Path(image_path)
    ext = path.suffix.lower().lstrip(".")
    if ext in ("tif", "tiff"):
        img = tiff.imread(str(path))
        if getattr(img, "ndim", 0) == 3:
            img = img[0]
    else:
        img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if img is None:
            raise RuntimeError("Could not read " + str(path))
        if img.ndim == 3:
            img = img[:, :, 0]
    if img.ndim != 2:
        raise RuntimeError("Expected a 2D section image")
    if img.dtype == np.uint16:
        img = (img / 256).astype(np.uint8)
    elif img.dtype == np.float32 or img.dtype == np.float64:
        img = (img * 255).astype(np.uint8)
    elif img.dtype != np.uint8:
        img = np.clip(img, 0, 255).astype(np.uint8)
    img = equalize_adapthist(img, clip_limit=0.01)
    img = (img * 255).astype(np.uint8)
    gray = img.copy()
    bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    height, width = gray.shape[:2]
    return bgr, gray, int(height), int(width)


def display_image_path(cache_path: str) -> Path:
    """Full-resolution PNG written beside the raw JSON cache."""
    cache = Path(cache_path)
    return cache.with_name(cache.stem + "_display.png")


def _write_gray_png(gray, dest: Path) -> None:
    import cv2

    dest.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(dest), gray, [cv2.IMWRITE_PNG_COMPRESSION, 1]):
        raise RuntimeError("Could not write " + str(dest))


def _scale_gray(gray, max_side: int):
    """Shrink a display image so the browser can decode it. Scale is display/full."""
    import cv2

    height, width = gray.shape[:2]
    long_side = max(int(height), int(width))
    limit = int(max_side or 0)
    if limit <= 0 or long_side <= limit:
        return gray, 1.0
    scale = float(limit) / float(long_side)
    resized = cv2.resize(
        gray,
        (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
        interpolation=cv2.INTER_AREA,
    )
    return resized, scale


def _emit_progress(pct: int, message: str) -> None:
    print(f"PROGRESS:{int(pct)}:{message}", flush=True)


def run_estimate(cache_path: str, confidence: float, area: float, eccentricity: float) -> None:
    from detect_qc_analysis import estimate_intensity_threshold

    with open(cache_path, encoding="utf-8") as handle:
        cache = json.load(handle)
    kept = filter_records(cache.get("boxes") or [], confidence, area, eccentricity, 0)
    intensities = []
    for row in kept:
        inten = _json_number(row.get("intensity_p90"))
        if inten is not None:
            intensities.append(inten)
    estimate = estimate_intensity_threshold(intensities)
    payload = {"ok": True}
    payload.update(estimate)
    print("RESULT:" + json.dumps(payload), flush=True)


def run_raw(args) -> None:
    import pipeline_io_bootstrap  # noqa: F401
    from find_neurons import load_detection_model, run_sliced_detection

    image_path = str(args.image or "").strip()
    model_path = str(args.model or "").strip()
    cache_path = str(args.cache or "").strip()
    if not image_path or not model_path or not cache_path:
        raise SystemExit("raw detection needs --image, --model, and --cache")
    _emit_progress(5, "Loading section…")
    bgr, gray, height, width = prepare_detection_image(image_path)
    _emit_progress(20, "Loading detection model…")
    model = load_detection_model(model_path, RAW_CONFIDENCE)
    _emit_progress(35, "Running raw detection…")
    result = run_sliced_detection(bgr, model, int(args.tile), Path(image_path).name)
    _emit_progress(85, "Measuring detections…")
    records = records_from_objects(result.object_prediction_list, bgr, gray)
    display_path = display_image_path(cache_path)
    _emit_progress(92, "Writing full-resolution section...")
    _write_gray_png(gray, display_path)
    mtime_s = int(Path(image_path).stat().st_mtime)
    payload = {
        "ok": True,
        "image": str(Path(image_path).resolve()),
        "mtimeS": mtime_s,
        "method": str(args.method or "somata"),
        "customModel": str(args.custom_model or ""),
        "model": model_path,
        "tile": int(args.tile),
        "sliceId": str(args.slice_id or ""),
        "width": width,
        "height": height,
        "confidence_floor": RAW_CONFIDENCE,
        "count": len(records),
        "displayPath": str(display_path.resolve()),
        "boxes": records,
    }
    cache = Path(cache_path)
    cache.parent.mkdir(parents=True, exist_ok=True)
    with open(cache, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    _emit_progress(100, "Raw detection finished")
    summary = {
        "ok": True,
        "cachePath": str(cache),
        "count": len(records),
        "width": width,
        "height": height,
        "sliceId": payload["sliceId"],
        "displayPath": payload["displayPath"],
    }
    print("RAW_DETECT_JSON:" + json.dumps(summary), flush=True)


def run_write_display(args) -> None:
    """Write the detection image PNG for an existing raw cache. Does not run the model."""
    image_path = str(args.image or "").strip()
    cache_path = str(args.cache or "").strip()
    if not image_path or not cache_path:
        raise SystemExit("display image needs --image and --cache")
    _emit_progress(15, "Loading full-resolution section...")
    _bgr, gray, full_height, full_width = prepare_detection_image(image_path)
    gray, scale = _scale_gray(gray, int(args.max_side or 0))
    height, width = gray.shape[:2]
    dest = display_image_path(cache_path)
    if scale < 1:
        dest = dest.with_name(dest.stem + "_fit.png")
    _emit_progress(70, "Writing full-resolution section...")
    _write_gray_png(gray, dest)
    _emit_progress(100, "Full-resolution section ready")
    summary = {
        "ok": True,
        "cachePath": str(Path(cache_path).resolve()),
        "displayPath": str(dest.resolve()),
        "width": int(width),
        "height": int(height),
        "fullWidth": int(full_width),
        "fullHeight": int(full_height),
        "displayScale": scale,
    }
    print("RAW_DETECT_JSON:" + json.dumps(summary), flush=True)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Detection parameterization helpers")
    parser.add_argument("--image", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--method", default="somata")
    parser.add_argument("--custom-model", default="")
    parser.add_argument("--tile", type=int, default=640)
    parser.add_argument("--cache", default="")
    parser.add_argument("--slice-id", default="")
    parser.add_argument("--estimate", action="store_true")
    parser.add_argument("--write-display", action="store_true")
    parser.add_argument("--max-side", type=int, default=0)
    parser.add_argument("--confidence", type=float, default=0.5)
    parser.add_argument("--area", type=float, default=200)
    parser.add_argument("--eccentricity", type=float, default=0.2)
    args = parser.parse_args()
    if args.estimate:
        run_estimate(str(args.cache), args.confidence, args.area, args.eccentricity)
        return
    if args.write_display:
        run_write_display(args)
        return
    run_raw(args)


if __name__ == "__main__":
    main()
