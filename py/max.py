from tkinter import filedialog
import pipeline_io_bootstrap  # noqa: F401
import os
import tifffile as tiff
from skimage.filters import unsharp_mask
import tkinter as tk
import numpy as np
import argparse
import cv2

def process_file(file, outputDirectory, topHat=False, dendrite=False):
    # Update current file
    try:
        print(f"Processing {file}", flush=True)
        img = tiff.imread(file)
        # Get filename stem
        stem = file.split(".")[0]
        if img.ndim == 2:
            # Single-plane image (e.g. sparse-Z counterstain): nothing to
            # project. np.argmin over (H, W) would otherwise collapse a spatial
            # axis and produce a 1-D line.
            projected = img
        elif img.ndim == 3:
            # Project over the smallest axis (Z or channel), keeping H x W.
            channel_dim = int(np.argmin(img.shape))
            projected = np.max(img, axis=channel_dim)
        else:
            raise ValueError(
                f"Unsupported image with {img.ndim} dimensions (shape {img.shape})"
            )
        # Save the processed image
        cv2.imwrite(f"{outputDirectory}/{stem}.tif", projected)
        return True
    except Exception as e:
        print(f"Failed to process {file}. Error: {e}", flush=True)
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process z-stack images")
    parser.add_argument(
        "-o",
        "--output",
        help="output directory, only use if graphical false",
        default="",
    )
    parser.add_argument(
        "-i", "--input", help="input directory, only use if graphical false", default=""
    )
    parser.add_argument(
        "-g", "--graphical", help="provides prompts when true", default=True
    )
    parser.add_argument(
        "-d", "--dendrite", help="remove dendrites when true", default=False
    )
    parser.add_argument(
        "-t", "--tophat", help="apply tophat filter when true", default=False
    )
    args = parser.parse_args()

    if args.graphical == True:
        root = tk.Tk()
        root.withdraw()

        inputDirectory = filedialog.askdirectory(title="Select input directory")
        outputDirectory = filedialog.askdirectory(title="Select output directory")
    else:
        inputDirectory = args.input.strip()
        outputDirectory = args.output.strip()

    os.chdir(inputDirectory)
    # Only project real TIFF files; skip subdirectories (.masonjar meta, run
    # leaves), run_manifest.json, and any non-image entries.
    files = sorted(
        f
        for f in os.listdir(".")
        if os.path.isfile(f) and f.lower().endswith((".tif", ".tiff"))
    )
    if len(files) == 0:
        print(1, flush=True)
        print("No TIFF files found in input directory", flush=True)
        exit(1)
    # Pass number of files to electron
    print(len(files), flush=True)
    written = 0
    for file in files:
        if process_file(file, outputDirectory, args.tophat, args.dendrite):
            written += 1

    if written == 0:
        # Inputs existed but none projected: a failed run, not a silent success.
        print(f"MAX_NO_OUTPUT: 0 of {len(files)} files projected.", flush=True)
        print("Done!")
        exit(1)

    print("Done!")
    from run_manifest import write_run_manifest

    write_run_manifest(
        outputDirectory,
        {
            "step": "max",
            "input_dir": inputDirectory,
            "input_files": files,
            "dendrite": bool(args.dendrite),
            "tophat": bool(args.tophat),
        },
    )
