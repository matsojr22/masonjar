import cv2
import pipeline_io_bootstrap  # noqa: F401
import pickle
import os
import json
from datetime import datetime, timezone
from skimage.measure import label, regionprops
from skimage.filters import threshold_otsu
import numpy as np
import argparse
import inspect
from pathlib import Path
from skimage.exposure import equalize_adapthist
from sahi import AutoDetectionModel
from sahi.predict import get_sliced_prediction
import tifffile as tiff
import torch


class DetectionResult:
    def __init__(self, boxes, scores, image_dimensions):
        self.boxes = boxes
        self.scores = scores
        self.image_dimensions = image_dimensions


def export_bboxes(image, boxes, output_path):
    for box in boxes:
        x1, y1, x2, y2 = [int(b) for b in box]
        cv2.rectangle(image, (x1, y1), (x2, y2), (0, 0, 255), 2)

    cv2.imwrite(str(output_path), image)


def check_eccentricity(box, threshold, image):
    # psuedo code
    # for each box, segment the cell in the center with SAM
    # compute the eccentricity of the mask
    # if eccentricity > threshold, remove the box 
    try:
        box = [int(b) for b in box]
        cell_image = image[box[1]-5:box[3]+5, box[0]-5:box[2]+5, :]
        if len(cell_image.shape) > 2:
            cell_image = cv2.cvtColor(cell_image, cv2.COLOR_BGR2GRAY)
        mask = cell_image > threshold_otsu(cell_image)

        labeled_mask = label(mask)
        # Get all region properties
        regions = regionprops(labeled_mask)
        
        if not regions:
            return False  # Return False if no regions are detected
        
        # Find the region with the largest area
        largest_region = max(regions, key=lambda r: r.area)
        
        # Compute the eccentricity of the largest region
        eccentricity = largest_region.eccentricity
        
        # Return True if the eccentricity is greater than the threshold, otherwise False
        return eccentricity > threshold

    except Exception as e:
        print("Failed to check eccentricity. Error: ", e)
        return True

def xyxy_to_area(box):
    return (box[2] - box[0]) * (box[3] - box[1])


def make_tile_progress_printer(label):
    """Emit stdout lines so Mason Jar's progress bar updates during SAHI tiling."""
    state = {"last": 0}

    def progress_callback(current, total):
        if not total:
            return
        step = max(1, total // 25)
        if current == 1 or current == total or current - state["last"] >= step:
            print(f"{label}: tile {current}/{total}", flush=True)
            state["last"] = current

    return progress_callback


def _call_get_sliced_prediction(image, detection_model, tile_size, label):
    """Call SAHI sliced prediction; only pass kwargs supported by installed sahi."""
    kwargs = {
        "slice_height": tile_size,
        "slice_width": tile_size,
        "overlap_height_ratio": 0.1,
        "overlap_width_ratio": 0.1,
        "verbose": 1,
    }
    params = inspect.signature(get_sliced_prediction).parameters
    if "progress_bar" in params:
        kwargs["progress_bar"] = False
    if "progress_callback" in params:
        kwargs["progress_callback"] = make_tile_progress_printer(label)
    return get_sliced_prediction(image, detection_model, **kwargs)


def run_sliced_detection(image, detection_model, tile_size, label):
    print(
        f"{label}: starting tiled detection ({image.shape[1]}×{image.shape[0]} px, "
        f"tile {tile_size})…",
        flush=True,
    )
    return _call_get_sliced_prediction(image, detection_model, tile_size, label)


def screen_predictions(prediction_objects, area_threshold, eccentricity_threshold=None, image=None, sam_model_path=None):
    """Screen predictions for objects below a certain area"""
    first_pass = [
        obj
        for obj in prediction_objects
        if xyxy_to_area(obj.bbox.to_xyxy()) > area_threshold
    ]
    
    if len(first_pass) < 3:
        return first_pass
    
    # get average area of first pass
    avg_area = sum([xyxy_to_area(obj.bbox.to_xyxy()) for obj in first_pass]) / len( first_pass)
    std_area = np.std([xyxy_to_area(obj.bbox.to_xyxy()) for obj in first_pass])
    
    # second pass. remove objects that are too big
    second_pass = [
        obj
        for obj in first_pass
        if xyxy_to_area(obj.bbox.to_xyxy()) < avg_area + 2 * std_area
    ]

    if eccentricity_threshold is not None:
        try:
            assert image is not None
            second_pass = [
                obj
                for obj in second_pass
                if check_eccentricity(obj.bbox.to_xyxy(), eccentricity_threshold, image)
            ]
        except AssertionError:
            print("Image not provided. Eccentricity screening not performed.")

    return second_pass

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Find neurons in images")
    parser.add_argument(
        "-o",
        "--output",
        help="output directory, only use if graphical false",
        default="",
    )
    parser.add_argument(
        "-i", "--input", help="input directory, only use if graphical false", default=""
    )
    parser.add_argument("-t", "--tile", help="tile size", default=640)
    parser.add_argument(
        "-c", "--confidence", help="confidence level for detections", default=0.85
    )
    parser.add_argument(
        "-m", "--model", help="specify model file", default="../models/ancientwizard.pt"
    )
    parser.add_argument("-s", "--sam", default="~/.belljar/models/sam_vit_b.pth")
    parser.add_argument("-e", "--eccentricity", help="eccentricity threshold", default=0.5)
    parser.add_argument(
        "-n",
        "--multichannel",
        help="specify if multichannel",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "-a",
        "--area",
        help="area threshold for screening",
        default=200,
    )
    parser.add_argument(
        "--slice-list",
        help="JSON file with slice ids to process (filters input images)",
        default="",
    )
    args = parser.parse_args()

    input_dir = Path(args.input.strip())
    output_dir = Path(args.output.strip())
    output_dir.mkdir(parents=True, exist_ok=True)
    tile_size = int(args.tile)
    model_path = args.model.strip()

    from slice_index import load_slice_list, slice_id_allowed

    # add mps device if available (MASONJAR_DETECT_CPU=1 forces CPU on Mac when MPS hangs)
    force_cpu = os.environ.get("MASONJAR_DETECT_CPU", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if force_cpu:
        device = "cpu"
    elif torch.cuda.is_available():
        device = "cuda:0"
    elif torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"

    # Pruning
    endings = ["png", "jpg", "jpeg", "tif", "tiff"]
    files = os.listdir(input_dir)
    files = [f for f in files if f.split(".")[-1].lower() in endings]
    files.sort()

    def _image_slice_id(fname: str) -> str:
        stem = Path(fname).stem
        if stem.lower().endswith(".ome"):
            stem = Path(stem).stem
        dot = stem.find(".")
        return stem[:dot] if dot >= 0 else stem

    allowed = load_slice_list(args.slice_list.strip() or None)
    if allowed is not None:
        files = [f for f in files if slice_id_allowed(_image_slice_id(f), allowed)]

    manifest = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "model": model_path,
        "confidence": args.confidence,
        "tile": args.tile,
        "area": args.area,
        "eccentricity": args.eccentricity,
        "multichannel": bool(args.multichannel),
        "sam": args.sam,
        "slice_list": args.slice_list.strip() or None,
        "input_files": sorted(files),
    }
    with open(output_dir / "run_manifest.json", "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2)

    # Extra headroom in step count for per-tile progress lines (IPC progress bar).
    print(5 + len(files) * 40, flush=True)
    print(f"Using device: {device}", flush=True)
    print(f"Using model: {model_path}", flush=True)
    print(f"Using confidence level {float(args.confidence)}", flush=True)
    print(f"Found {len(files)} images", flush=True)
    
    detection_model = AutoDetectionModel.from_pretrained(
        model_type="yolov8",
        model_path=model_path,
        confidence_threshold=float(args.confidence),
        device=device,
    )

    written = 0
    failed_reads = 0
    for file in files:
        file_path = os.path.join(input_dir, file)
        stripped, ext = file.split(".")[0], file.split(".")[-1]

        print(f"Running detection on {file}...", flush=True)
        # Try and load the image
        index_order = "F"
        try:
            if ext in ["tif", "tiff"]:
                img = tiff.imread(file_path)
                if len(img.shape) == 3:
                    channels, height, width = img.shape
                    index_order = "C"
                elif len(img.shape) == 2:
                    height, width = img.shape
                    channels = 1
                else:
                    raise Exception("Image has more than 3 dimensions!")
            else:
                img = cv2.imread(file_path)
                width, height, channels = img.shape
        except Exception as e:
            print(f"Error reading {file}!", flush=True)
            print(e, flush=True)
            failed_reads += 1
            continue

        # If multichannel, split into individual channels
        split_channels = []
        if args.multichannel:
            for i in range(channels):
                if index_order == "F":
                    split_channels.append(img[:, :, i])
                else:
                    split_channels.append(img[i, :, :])

        predictions = []
        if len(split_channels) > 0:
            for i, chan_img in enumerate(split_channels):
                # Check data type
                if chan_img.dtype == np.uint16:
                    chan_img = (chan_img / 256).astype(np.uint8)
                elif chan_img.dtype == np.float32 or chan_img.dtype == np.float64:
                    chan_img = (chan_img * 255).astype(np.uint8)

                # equalize
                chan_img = equalize_adapthist(chan_img, clip_limit=0.01)
                chan_img = (chan_img * 255).astype(np.uint8)
                # convert to BGR
                chan_img = cv2.cvtColor(chan_img, cv2.COLOR_GRAY2BGR)
                result = run_sliced_detection(
                    chan_img,
                    detection_model,
                    tile_size,
                    f"{file} ch{i + 1}",
                )

                print(
                    f"Screening {len(result.object_prediction_list)} detections on {file} ch{i + 1}…",
                    flush=True,
                )
                predicted_objects = screen_predictions(
                    result.object_prediction_list, 
                    float(args.area.strip()),
                    eccentricity_threshold=float(args.eccentricity.strip()),
                    image=chan_img,
                    sam_model_path=Path(args.sam.strip()).expanduser(),
                    )
                bboxes = [obj.bbox.to_xyxy() for obj in predicted_objects]
                scores = [obj.score.value for obj in predicted_objects]

                predictions.append(
                    DetectionResult(
                        boxes=bboxes,
                        scores=scores,
                        image_dimensions=(height, width),
                    )
                )
                bbox_path = Path(output_dir) / f"BBoxes_{stripped}_{i}.png"
                export_bboxes(chan_img, bboxes, bbox_path)
        else:
            # Check data type
            if img.dtype == np.uint16:
                img = (img / 256).astype(np.uint8)
            elif img.dtype == np.float32 or img.dtype == np.float64:
                img = (img * 255).astype(np.uint8)
            
            img = equalize_adapthist(img, clip_limit=0.01)
            img = (img * 255).astype(np.uint8)

            # convert to BGR
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

            result = run_sliced_detection(
                img,
                detection_model,
                tile_size,
                file,
            )

            print(
                f"Screening {len(result.object_prediction_list)} detections on {file}…",
                flush=True,
            )
            predicted_objects = screen_predictions(result.object_prediction_list, 
                                                   float(args.area.strip()), 
                                                   image=img, 
                                                   sam_model_path=Path(args.sam.strip()).expanduser(), 
                                                   eccentricity_threshold=float(args.eccentricity.strip())
                                                   )

            bboxes = [obj.bbox.to_xyxy() for obj in predicted_objects]
            scores = [obj.score.value for obj in predicted_objects]

            predictions = [
                DetectionResult(
                    boxes=bboxes,
                    scores=scores,
                    image_dimensions=(height, width),
                )
            ]
            bbox_path = Path(output_dir) / f"BBoxes_{stripped}.png"
            export_bboxes(img, bboxes, bbox_path)

        with open(output_dir / f"Predictions_{stripped}.pkl", "wb") as f:
            pickle.dump(predictions, f)
        written += 1

    if files and written == 0:
        # Inputs existed but nothing was detected/written: a failed run, not a
        # silent success (downstream Count would otherwise fail opaquely).
        print(
            f"DETECTION_NO_OUTPUT: 0 of {len(files)} images produced a "
            f"Predictions PKL ({failed_reads} read failure(s)).",
            flush=True,
        )
        print("Done!", flush=True)
        raise SystemExit(1)

    print("Done!", flush=True)
