"""Build a small georeferenced Jezero image/mask prototype for terrain vision.

The masks are weak labels derived from a stereo DTM and mapped dune polygons.
They are for alignment/QA and an initial experiment, not verified ground truth.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.vrt import WarpedVRT
from scipy.ndimage import maximum_filter, minimum_filter
from shapely.geometry import box

DATA_ROOT = Path(__file__).resolve().parent.parent / "data"
DEFAULT_DEM = DATA_ROOT / "raw" / "dem" / "local_dtms" / "ctx_jezero_P18_007925_1987_XN_18N282W__P19_008650_1987_XI_18N282W_dtm.tif"
DEFAULT_IMAGE = DATA_ROOT / "raw" / "imagery" / "ctx_jezero_P18_007925_1987_XN_18N282W__P19_008650_1987_XI_18N282W_orthoimage.tif"
DUNE_GPKG = DATA_ROOT / "processed" / "vectors" / "routing_layers.gpkg"
OUTPUT_DIR = DATA_ROOT / "processed" / "vision_prototype" / "jezero_ctx"
CTX_ORTHO_URL = "https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/P18_007925_1987_XN_18N282W__P19_008650_1987_XI_18N282W/P18_007925_1987_XN_18N282W__P19_008650_1987_XI_18N282W_orthoimage.tif"
MARS_RADIUS_M = 3_396_190.0
CLASS_NAMES = {
    "0": "terrain_not_flagged (not a safety label)",
    "1": "steep_slope_proxy",
    "2": "high_roughness_proxy",
    "3": "mapped_dune",
    "255": "ignore_or_nodata",
}
CLASS_RGB = {
    0: (55, 185, 140),
    1: (235, 65, 65),
    2: (255, 145, 40),
    3: (250, 205, 55),
}


def download_with_progress(url: str, destination: Path, attempts: int = 3) -> None:
    """Download an orthoimage with a resumable .part file and a compact progress bar."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    for attempt in range(1, attempts + 1):
        offset = partial.stat().st_size if partial.exists() else 0
        headers = {"User-Agent": "MarsWalk-Jezero-vision-prototype/1.0"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                append = offset > 0 and getattr(response, "status", 200) == 206
                if offset and not append:
                    offset = 0
                total = response.headers.get("Content-Length")
                total_bytes = (int(total) + offset) if total and total.isdigit() else 0
                mode = "ab" if append else "wb"
                received = offset
                last_update = 0.0
                with partial.open(mode) as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        output.write(chunk)
                        received += len(chunk)
                        now = time.monotonic()
                        if now - last_update >= 0.5:
                            if total_bytes:
                                pct = min(100.0, received * 100.0 / total_bytes)
                                print(f"\rCTX orthoimage: {pct:5.1f}%  {received/1e6:,.0f}/{total_bytes/1e6:,.0f} MB", end="", flush=True)
                            else:
                                print(f"\rCTX orthoimage: {received/1e6:,.0f} MB", end="", flush=True)
                            last_update = now
                print()
            partial.replace(destination)
            print(f"Saved CTX orthoimage: {destination} ({destination.stat().st_size/1e6:,.1f} MB)")
            return
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"\nDownload attempt {attempt}/{attempts} failed: {exc}")
            if attempt == attempts:
                raise RuntimeError(f"Could not download the CTX orthoimage. Partial data, if any, remains at {partial}") from exc
            time.sleep(2 * attempt)


def image_indexes(band_count: int) -> list[int]:
    return [1, 2, 3] if band_count >= 3 else [1]


def stretch_parameters(vrt: WarpedVRT, indexes: list[int]) -> list[tuple[float, float]]:
    height = min(vrt.height, 1024)
    width = min(vrt.width, 1024)
    sample = vrt.read(indexes, out_shape=(len(indexes), height, width), masked=True, resampling=Resampling.average)
    params = []
    for band in sample:
        values = band.compressed()
        if values.size == 0:
            params.append((0.0, 1.0))
            continue
        low, high = np.percentile(values, [2, 98])
        if not np.isfinite(low) or not np.isfinite(high) or high <= low:
            high = low + 1.0
        params.append((float(low), float(high)))
    return params


def to_rgb(image: np.ma.MaskedArray, stretches: list[tuple[float, float]]) -> np.ndarray:
    bands = []
    for band, (low, high) in zip(image, stretches):
        values = np.asarray(band.filled(low), dtype=np.float32)
        scaled = np.clip((values - low) / (high - low), 0.0, 1.0)
        bands.append(np.round(scaled * 255).astype(np.uint8))
    if len(bands) == 1:
        return np.repeat(bands[0][..., None], 3, axis=2)
    return np.stack(bands[:3], axis=2)


def make_dune_mask(dem: rasterio.io.DatasetReader) -> tuple[np.ndarray, int]:
    mask = np.zeros((dem.height, dem.width), dtype=np.uint8)
    if not DUNE_GPKG.is_file():
        print(f"Dune layer not found; continuing without it: {DUNE_GPKG}")
        return mask, 0
    try:
        dunes = gpd.read_file(DUNE_GPKG, layer="dunes_equatorial")
        if dunes.crs is None:
            raise ValueError("dunes_equatorial layer has no CRS")
        dunes = dunes.to_crs(dem.crs)
        footprint = box(*dem.bounds)
        geometries = [geom for geom in dunes.geometry if geom is not None and not geom.is_empty and geom.intersects(footprint)]
        if geometries:
            mask = rasterize(
                ((geom, 1) for geom in geometries),
                out_shape=(dem.height, dem.width),
                transform=dem.transform,
                fill=0,
                all_touched=True,
                dtype="uint8",
            )
        print(f"Mapped equatorial dune polygons intersecting this CTX DTM: {len(geometries)}")
        return mask, len(geometries)
    except Exception as exc:
        print(f"Warning: could not rasterize mapped dunes ({exc}); proceeding without dune labels.")
        return mask, 0


def make_preview(rgb: np.ndarray, labels: np.ndarray, path: Path) -> None:
    base = Image.fromarray(rgb, mode="RGB").convert("RGBA")
    overlay = np.zeros((labels.shape[0], labels.shape[1], 4), dtype=np.uint8)
    for class_id, color in CLASS_RGB.items():
        selected = labels == class_id
        overlay[selected, :3] = color
        overlay[selected, 3] = 115 if class_id else 0
    blended = Image.alpha_composite(base, Image.fromarray(overlay, mode="RGBA")).convert("RGB")
    blended.save(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a small Jezero CTX image/mask dataset and QA overlays.")
    parser.add_argument("--dem", type=Path, default=DEFAULT_DEM, help="Local georeferenced CTX stereo DTM.")
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE, help="Matching orthorectified CTX image GeoTIFF.")
    parser.add_argument("--fetch-image", action="store_true", help="Download the matching USGS CTX orthoimage if absent.")
    parser.add_argument("--output", type=Path, default=OUTPUT_DIR, help="Output directory for patches, labels, and previews.")
    parser.add_argument("--patch-size", type=int, default=256, help="Patch edge in pixels on the CTX DTM grid.")
    parser.add_argument("--slope-threshold-deg", type=float, default=15.0, help="Weak-label threshold for steep-slope proxy.")
    parser.add_argument("--roughness-threshold-m", type=float, default=8.0, help="Weak-label threshold for 3x3 elevation range.")
    parser.add_argument("--min-valid-fraction", type=float, default=0.75, help="Skip patches with less valid image/DTM overlap.")
    args = parser.parse_args()

    if args.patch_size < 32:
        parser.error("--patch-size must be at least 32 pixels")
    if not 0.0 < args.min_valid_fraction <= 1.0:
        parser.error("--min-valid-fraction must be in (0, 1]")
    if not args.dem.is_file():
        raise FileNotFoundError(f"CTX DTM not found: {args.dem}")
    if args.fetch_image and not args.image.is_file():
        print("Downloading the matching USGS CTX orthoimage; this may be a large file.")
        download_with_progress(CTX_ORTHO_URL, args.image)
    if not args.image.is_file():
        print("The local CTX DTM is present, but its matching orthoimage is not downloaded yet.")
        print(f"Run with --fetch-image, or save the asset from this URL as {args.image}:")
        print(CTX_ORTHO_URL)
        return 2

    args.output.mkdir(parents=True, exist_ok=True)
    image_dir = args.output / "images"
    mask_dir = args.output / "masks"
    preview_dir = args.output / "qa_overlays"
    for directory in (image_dir, mask_dir, preview_dir):
        directory.mkdir(parents=True, exist_ok=True)

    with rasterio.open(args.dem) as dem, rasterio.open(args.image) as image:
        if dem.crs is None or image.crs is None:
            raise ValueError("Both the DTM and orthoimage must have georeferencing/CRS metadata.")
        if dem.width == 0 or dem.height == 0:
            raise ValueError("DTM has an empty raster grid.")
        print(f"DTM: {dem.width} x {dem.height}, posting {dem.res[0]:.2f} x {dem.res[1]:.2f} map m")
        print(f"Orthoimage: {image.width} x {image.height}, {image.count} band(s), CRS {image.crs}")
        indexes = image_indexes(image.count)
        with WarpedVRT(
            image,
            crs=dem.crs,
            transform=dem.transform,
            width=dem.width,
            height=dem.height,
            resampling=Resampling.bilinear,
        ) as aligned:
            stretches = stretch_parameters(aligned, indexes)
            elevation = dem.read(1).astype(np.float32)
            valid = np.isfinite(elevation)
            if dem.nodata is not None:
                valid &= elevation != dem.nodata
            y = dem.transform.f + (np.arange(dem.height, dtype=np.float64) + 0.5) * dem.transform.e
            latitude = np.degrees(y / MARS_RADIUS_M)
            east_spacing = abs(dem.transform.a) * np.maximum(np.cos(np.radians(latitude)), 1e-3)
            north_spacing = abs(dem.transform.e)
            filled = np.where(valid, elevation, 0.0)
            dz_drow, dz_dcol = np.gradient(filled)
            dz_east = dz_dcol / east_spacing[:, None]
            dz_north = dz_drow / north_spacing
            slope = np.degrees(np.arctan(np.hypot(dz_east, dz_north)))
            valid_3x3 = minimum_filter(valid.astype(np.uint8), size=3, mode="constant", cval=0) == 1
            roughness = maximum_filter(filled, size=3, mode="nearest") - minimum_filter(filled, size=3, mode="nearest")
            dune_mask, dune_polygon_count = make_dune_mask(dem)

            labels = np.zeros((dem.height, dem.width), dtype=np.uint8)
            labels[roughness >= args.roughness_threshold_m] = 2
            labels[slope >= args.slope_threshold_deg] = 1
            labels[dune_mask > 0] = 3
            labels[~valid_3x3] = 255

            manifest_path = args.output / "manifest.csv"
            fields = [
                "patch_id", "image_path", "mask_path", "row_off", "col_off", "height", "width",
                "projected_left_m", "projected_bottom_m", "projected_right_m", "projected_top_m",
                "valid_fraction", "steep_fraction", "rough_fraction", "dune_fraction",
            ]
            rows: list[dict[str, object]] = []
            preview_count = 0
            patch_size = args.patch_size
            total = math.ceil(dem.height / patch_size) * math.ceil(dem.width / patch_size)
            done = 0
            for row_off in range(0, dem.height, patch_size):
                for col_off in range(0, dem.width, patch_size):
                    height = min(patch_size, dem.height - row_off)
                    width = min(patch_size, dem.width - col_off)
                    window = rasterio.windows.Window(col_off, row_off, width, height)
                    window_labels = labels[row_off:row_off + height, col_off:col_off + width].copy()
                    image_patch = aligned.read(indexes, window=window, masked=True, out_dtype="float32")
                    image_valid = ~np.any(np.ma.getmaskarray(image_patch), axis=0)
                    terrain_valid = window_labels != 255
                    patch_valid = image_valid & terrain_valid
                    valid_fraction = float(patch_valid.mean())
                    done += 1
                    if valid_fraction < args.min_valid_fraction:
                        continue
                    window_labels[~image_valid] = 255
                    rgb = to_rgb(image_patch, stretches)
                    patch_id = f"r{row_off:05d}_c{col_off:05d}"
                    image_path = image_dir / f"{patch_id}.png"
                    mask_path = mask_dir / f"{patch_id}.png"
                    Image.fromarray(rgb, mode="RGB").save(image_path)
                    Image.fromarray(window_labels, mode="L").save(mask_path)
                    transform = rasterio.windows.transform(window, dem.transform)
                    left = transform.c
                    top = transform.f
                    right = left + transform.a * width
                    bottom = top + transform.e * height
                    denominator = max(1, int(patch_valid.sum()))
                    rows.append({
                        "patch_id": patch_id,
                        "image_path": image_path.relative_to(args.output).as_posix(),
                        "mask_path": mask_path.relative_to(args.output).as_posix(),
                        "row_off": row_off,
                        "col_off": col_off,
                        "height": height,
                        "width": width,
                        "projected_left_m": left,
                        "projected_bottom_m": bottom,
                        "projected_right_m": right,
                        "projected_top_m": top,
                        "valid_fraction": valid_fraction,
                        "steep_fraction": float(np.count_nonzero((window_labels == 1) & patch_valid) / denominator),
                        "rough_fraction": float(np.count_nonzero((window_labels == 2) & patch_valid) / denominator),
                        "dune_fraction": float(np.count_nonzero((window_labels == 3) & patch_valid) / denominator),
                    })
                    if preview_count < 12:
                        make_preview(rgb, window_labels, preview_dir / f"{patch_id}_overlay.png")
                        preview_count += 1
                    if done % 20 == 0 or done == total:
                        print(f"Patch windows inspected: {done}/{total}; retained {len(rows)}", flush=True)

            if not rows:
                raise RuntimeError("No patches passed the overlap threshold; check that this orthoimage covers the DTM.")
            with manifest_path.open("w", newline="", encoding="utf-8") as stream:
                writer = csv.DictWriter(stream, fieldnames=fields)
                writer.writeheader()
                writer.writerows(rows)
            metadata = {
                "region": "Jezero crater",
                "image_source": CTX_ORTHO_URL,
                "image_path": str(args.image.resolve()),
                "dem_path": str(args.dem.resolve()),
                "dem_crs_wkt": dem.crs.to_wkt(),
                "dem_transform": list(dem.transform)[:6],
                "dem_resolution_map_m": list(dem.res),
                "patch_size_pixels": patch_size,
                "patch_grid_is_aligned_to": "local CTX stereo DTM; approximately 20 m posting",
                "class_ids": CLASS_NAMES,
                "weak_label_rules": {
                    "steep_slope_proxy": f"derived slope >= {args.slope_threshold_deg} degrees",
                    "high_roughness_proxy": f"3x3 elevation max-min >= {args.roughness_threshold_m} m",
                    "mapped_dune": "rasterized dunes_equatorial polygons from routing_layers.gpkg",
                    "priority_when_labels_overlap": "mapped dune, then steep slope, then roughness",
                },
                "mapped_dune_polygons_intersecting_dtm": dune_polygon_count,
                "label_warning": "These are weak labels from existing map/DTM rules. Class 0 means not flagged by those rules, not proven safe. Inspect QA overlays and add human-reviewed labels before training/evaluating a model.",
                "training_warning": "This CTX/DTM-aligned prototype does not include AI4Mars rover-camera labels; those images have a different camera scale and viewpoint.",
                "patch_count": len(rows),
                "qa_overlay_count": preview_count,
            }
            (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            print(f"Created {len(rows)} aligned patches at: {args.output.resolve()}")
            print(f"Review overlays first: {preview_dir.resolve()}")
            print(f"Manifest: {manifest_path.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Prototype failed: {exc}", file=sys.stderr)
        raise
