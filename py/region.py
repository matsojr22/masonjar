from __future__ import annotations

import os
import pickle
import argparse
import sys
from pathlib import Path
import tifffile
import numpy as np
from demons import resize_image_nearest_neighbor
import cv2


def reconstruct_region(intensity_data):
    """
    Reconstruct a region from its intensity data.

    Args:
        intensity_data (dict): Dictionary of intensity data. Keys are points, values are pixel intensity.

    Returns:
        numpy.ndarray: 2D numpy array of reconstructed region.
    """

    # Get the max x and y values
    max_x = max([point[0] for point in intensity_data.keys()])
    max_y = max([point[1] for point in intensity_data.keys()])
    # Create a blank image
    blank = np.zeros((max_x + 1, max_y + 1))
    # Fill in the image
    for point, intensity in intensity_data.items():
        blank[point] = intensity

    return blank


_DAPI_NAME_CANDIDATES = (
    "{stem}.png",
    "{stem}.PNG",
    "{stem}.tif",
    "{stem}.TIF",
    "{stem}.tiff",
    "{stem}.TIFF",
    "{stem}.jpg",
    "{stem}.JPG",
    "{stem}.jpeg",
    "{stem}.JPEG",
    "{stem}_dapi.png",
    "{stem}_dapi.PNG",
    "{stem}_dapi.tif",
    "{stem}_dapi.TIFF",
)


def _resolve_dapi_image_path(dapi_dir: Path, stem: str) -> Path | None:
    for pat in _DAPI_NAME_CANDIDATES:
        p = dapi_dir / pat.format(stem=stem)
        if p.is_file():
            return p
    return None


def _to_uint8_gray(img: np.ndarray) -> np.ndarray:
    """Normalize single-channel image to uint8 for sparse ROI storage."""
    arr = np.asarray(img)
    if arr.ndim > 2:
        arr = arr[..., 0]
    if arr.dtype == np.uint8:
        return arr
    arr = arr.astype(np.float64)
    mn, mx = float(np.min(arr)), float(np.max(arr))
    if mx <= mn:
        return np.zeros(arr.shape, dtype=np.uint8)
    arr = (arr - mn) / (mx - mn) * 255.0
    return np.clip(arr, 0, 255).astype(np.uint8)


def _load_dapi_grayscale(path: Path) -> np.ndarray | None:
    """Load 2D grayscale DAPI; supports PNG/JPEG via OpenCV and TIFF via tifffile."""
    suf = path.suffix.lower()
    if suf in (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"):
        bgr = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if bgr is not None:
            return _to_uint8_gray(bgr)
    try:
        raw = tifffile.imread(str(path))
    except Exception:
        return None
    if raw is None:
        return None
    if raw.ndim == 3:
        raw = raw[..., 0]
    if raw.ndim != 2:
        return None
    return _to_uint8_gray(raw)


def _is_candidate_intensity_filename(name: str) -> bool:
    """Ignore sidecars / OS junk so list order matches annotation PKLs by stem, not by index."""
    lower = name.lower()
    return lower.endswith(
        (".tif", ".tiff", ".png", ".jpg", ".jpeg", ".bmp", ".ome.tif", ".ome.tiff")
    )


def _intensity_slice_stem(filename: str) -> str:
    """Slice id shared with Align PKLs and ROI output names (M528_s061.ome.tiff -> M528_s061)."""
    return Path(filename).name.split(".", 1)[0]


def _align_stripped_basename(filename: str) -> str:
    """Basename with last extension removed — same rule as py/map.py Align output."""
    parts = Path(filename).name.split(".")
    if len(parts) <= 1:
        return parts[0]
    return ".".join(parts[:-1])


def _annotation_pkl_id_from_stem(pkl_stem: str) -> str:
    """Strip Align-style Annotation_ / annotations_ prefix from a PKL filename stem."""
    lower = pkl_stem.lower()
    for prefix in ("annotation_", "annotations_"):
        if lower.startswith(prefix):
            return pkl_stem[len(prefix) :]
    return pkl_stem


def _annotation_pkl_candidate_names(intensity_filename: str) -> list[str]:
    """PKL basenames to try for this intensity file (Align writes Annotation_<name>.pkl)."""
    name = Path(intensity_filename).name
    slice_stem = _intensity_slice_stem(name)
    align_stripped = _align_stripped_basename(name)
    ids: list[str] = []
    for piece in (slice_stem, align_stripped):
        if piece and piece not in ids:
            ids.append(piece)
    names: list[str] = []
    for piece in ids:
        for pat in (f"{piece}.pkl", f"Annotation_{piece}.pkl", f"annotations_{piece}.pkl"):
            if pat not in names:
                names.append(pat)
    return names


def _resolve_annotation_pkl(annotation_dir: Path, intensity_filename: str) -> Path | None:
    """Match Align output PKLs (Annotation_M528_s061.pkl, etc.) to the intensity slice."""
    for cand in _annotation_pkl_candidate_names(intensity_filename):
        path = annotation_dir / cand
        if path.is_file():
            return path

    slice_stem = _intensity_slice_stem(intensity_filename).lower()
    align_stripped = _align_stripped_basename(intensity_filename).lower()
    want_ids = {slice_stem, align_stripped}

    for path in annotation_dir.iterdir():
        if not path.is_file() or path.suffix.lower() != ".pkl":
            continue
        pkl_id = _annotation_pkl_id_from_stem(path.stem).lower()
        if pkl_id in want_ids or path.stem.lower() in want_ids:
            return path
    return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Calculate the average intensity of a region in normalized coordinates"
    )

    parser.add_argument(
        "-i", "--images", help="input directory for intensity images", default=""
    )
    parser.add_argument(
        "-o", "--output", help="output directory for average intensity pkl", default=""
    )
    parser.add_argument(
        "-a", "--annotations", help="input directory for annotation pkls", default=""
    )
    parser.add_argument(
        "-m", "--map", help="input directory for structure map", default=""
    )
    parser.add_argument(
        "-w",
        "--whole",
        help="Set True to process a whole brain slice (Default is False)",
        default=False,
    )
    parser.add_argument(
        "-d",
        "--dapi-dir",
        help="optional directory of low-res DAPI images (same stem as intensity files; "
        ".png/.tif/.jpg or stem_dapi.png/.tif)",
        default="",
    )
    args = parser.parse_args()

    # Intensity files: only image-like names so sort order is not thrown off by .DS_Store, etc.
    intensityPath = args.images.strip()
    intensityFiles = sorted(
        f for f in os.listdir(intensityPath) if _is_candidate_intensity_filename(f)
    )
    is_whole = eval(args.whole.strip())
    dapi_dir_raw = args.dapi_dir.strip()
    dapi_dir_path = Path(dapi_dir_raw) if dapi_dir_raw else None

    annotationPath = args.annotations.strip()
    annotation_dir = Path(annotationPath)

    print(2 + len(intensityFiles), flush=True)
    print("Setting up...", flush=True)

    structure_map = pickle.load(open(args.map.strip(), "rb"))

    for iName in intensityFiles:
        stem = _intensity_slice_stem(iName)
        anno_pkl = _resolve_annotation_pkl(annotation_dir, iName)
        if anno_pkl is None:
            tried = ", ".join(_annotation_pkl_candidate_names(iName)[:4])
            msg = (
                f"No annotation PKL for intensity '{iName}' (slice id {stem!r}). "
                f"Tried names like {tried} in {annotation_dir}."
            )
            print(msg, flush=True)
            print(msg, file=sys.stderr, flush=True)
            continue

        # load the image
        try:
            intensity = tifffile.imread(intensityPath + "/" + iName)
            if intensity.ndim != 2:
                print(
                    f"Erorr loading {iName}! Expected single-channel 2D image.", flush=True
                )
                continue
            # get the image width and height
            height, width = intensity.shape
        except Exception:
            print(f"Erorr loading {iName}! Channels > 1 or bad image.", flush=True)
            continue

        dapi_resized = None
        dapi_source_path_str = ""
        if dapi_dir_path is not None:
            dapi_img_path = _resolve_dapi_image_path(dapi_dir_path, stem)
            if dapi_img_path is None:
                msg = (
                    f"DAPI folder set but no matching DAPI file for intensity '{iName}' "
                    f"(stem {stem!r}). Tried names like {stem}.png, {stem}.tif, {stem}_dapi.png "
                    f"in {dapi_dir_path}. PKLs from this slice will NOT include dapi_roi."
                )
                print(msg, flush=True)
                print(msg, file=sys.stderr, flush=True)
            else:
                dapi_gray = _load_dapi_grayscale(dapi_img_path)
                if dapi_gray is None:
                    msg = f"Failed to read DAPI image: {dapi_img_path}"
                    print(msg, flush=True)
                    print(msg, file=sys.stderr, flush=True)
                else:
                    dapi_resized = cv2.resize(
                        dapi_gray, (width, height), interpolation=cv2.INTER_AREA
                    )
                    dapi_source_path_str = str(dapi_img_path.resolve())

        # load the annotation (matched by stem, not by sorted index)
        with open(anno_pkl, "rb") as f:
            print("Processing " + iName, flush=True)
            annotation = pickle.load(f)

            annotation_recaled = resize_image_nearest_neighbor(
                annotation, (width, height)
            )
            required_regions = [
                "VISa",
                "VISal",
                "VISam",
                "VISp",
                "VISl",
                "VISli",
                "VISpl",
                "VISpm",
                "VISpor",
                "VISrl",
                "RSPagl",
                "RSPd",
                "RSPv",
            ]

            required_ids = [
                atlas_id
                for atlas_id, data in structure_map.items()
                if data["acronym"] in required_regions
            ]

            intensities = {required_id: {} for required_id in required_ids}
            dapi_intensities = {required_id: {} for required_id in required_ids}

            # Get all children of the required regions in a dict
            # Dict helps us check which parent a child belongs to
            # Child == Parent in ID_PATH
            children_ids = {required_id: [] for required_id in required_ids}
            for required_id in required_ids:
                for atlas_id, data in structure_map.items():
                    if required_id in [
                        int(sub_id) for sub_id in data["id_path"].split("/")
                    ]:
                        children_ids[required_id].append(atlas_id)

            # Scan resized annotation for any child ids
            # If found, add its vertex and intensity to the parent
            for parent_id, children in children_ids.items():
                for child_id in children:
                    # Get the vertex of the child
                    verts = np.where(annotation_recaled == child_id)
                    if verts[0].size == 0:
                        continue
                    for point in zip(*verts):
                        # Integer tuple keys so sparse dicts match after pickle and in export_roi_dual_tif.
                        vkey = (int(point[0]), int(point[1]))
                        # check if whole
                        if not is_whole:
                            intensities[parent_id][vkey] = intensity[point]
                            if dapi_resized is not None:
                                dapi_intensities[parent_id][vkey] = int(
                                    dapi_resized[point]
                                )
                        else:
                            # take only points in the left half
                            if point[1] < width // 2:
                                intensities[parent_id][vkey] = intensity[point]
                                if dapi_resized is not None:
                                    dapi_intensities[parent_id][vkey] = int(
                                        dapi_resized[point]
                                    )

            # Save the intensity values and the verticies as ROI package pkls
            for region in intensities.keys():
                # reconstruct the region
                if intensities[region] == {}:  # skip empty regions
                    continue

                name = stem
                region_name = structure_map[region]["acronym"]

                # split file name
                outputPath = Path(
                    args.output.strip() + "/" + f"{name}_{region_name}" + ".pkl"
                )

                pkg = {
                    "roi": intensities[region],
                    "name": region_name,
                }
                if dapi_resized is not None and dapi_intensities[region]:
                    pkg["dapi_roi"] = dapi_intensities[region]
                    pkg["channel_order_tif"] = ["DAPI", "signal"]
                    pkg["intensity_source_name"] = iName
                    if dapi_source_path_str:
                        pkg["dapi_source_path"] = dapi_source_path_str

                with open(outputPath, "wb") as f:
                    pickle.dump(pkg, f)

    print("Done!", flush=True)
