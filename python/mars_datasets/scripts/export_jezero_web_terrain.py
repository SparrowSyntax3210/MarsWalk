"""Export a compact, browser-ready Jezero height field and warm CTX texture."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "python/mars_datasets/data/processed/vision_prototype/jezero_ctx/jezero_full_scene_features_20m.tif"
OUTPUT = ROOT / "frontend/public/data/jezero3d"
MAX_WIDTH = 1024


def warm_lut() -> np.ndarray:
    stops = [(0, (49, 31, 28)), (72, (105, 62, 47)), (150, (166, 98, 64)), (220, (211, 144, 99)), (255, (243, 193, 145))]
    result = np.zeros((256, 3), dtype=np.uint8)
    for value in range(256):
        for idx in range(len(stops) - 1):
            low, c0 = stops[idx]
            high, c1 = stops[idx + 1]
            if low <= value <= high:
                fraction = (value - low) / (high - low)
                result[value] = [round(a + fraction * (b - a)) for a, b in zip(c0, c1)]
                break
    return result


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing aligned Jezero image/DTM raster: {SOURCE}")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with rasterio.open(SOURCE) as src:
        height = max(1, round(src.height * MAX_WIDTH / src.width))
        image = src.read(1, out_shape=(height, MAX_WIDTH), resampling=Resampling.average)
        dem = src.read(2, out_shape=(height, MAX_WIDTH), masked=True, resampling=Resampling.bilinear)
        validity = src.read_masks(2, out_shape=(height, MAX_WIDTH), resampling=Resampling.nearest) > 0
        source_width_m = src.width * abs(src.transform.a)
        source_height_m = src.height * abs(src.transform.e)
        bounds = [src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top]
        source_resolution = [abs(float(src.transform.a)), abs(float(src.transform.e))]
        source_nodata = src.nodata

    image = np.asarray(image, dtype=np.float32)
    finite_image = np.isfinite(image)
    image_valid = finite_image & (image != source_nodata if source_nodata is not None else finite_image)
    if not image_valid.any():
        raise SystemExit("The source image band contains no valid pixels.")
    low, high = np.percentile(image[image_valid], [1, 99])
    gray = np.clip((image - low) * (255.0 / max(float(high - low), 1e-9)), 0, 255).astype(np.uint8)
    rgb = warm_lut()[gray]
    rgb[~image_valid] = (77, 48, 39)
    Image.fromarray(rgb, mode="RGB").save(OUTPUT / "jezero-surface.jpg", quality=84, optimize=True, progressive=True)

    elevations = np.asarray(dem.filled(np.nan), dtype=np.float32)
    validity &= np.isfinite(elevations)
    if not validity.any():
        raise SystemExit("The DTM band contains no valid pixels.")
    minimum = float(elevations[validity].min())
    maximum = float(elevations[validity].max())
    normalized = np.zeros(elevations.shape, dtype=np.uint16)
    if maximum > minimum:
        normalized[validity] = np.clip((elevations[validity] - minimum) * (65535.0 / (maximum - minimum)), 0, 65535).astype(np.uint16)
    packed = np.empty((*normalized.shape, 3), dtype=np.uint8)
    packed[..., 0] = (normalized >> 8).astype(np.uint8)
    packed[..., 1] = (normalized & 255).astype(np.uint8)
    packed[..., 2] = validity.astype(np.uint8) * 255
    Image.fromarray(packed, mode="RGB").save(OUTPUT / "jezero-height.png", optimize=True)

    manifest = {
        "name": "Jezero Crater — CTX stereo terrain preview",
        "source": "Aligned CTX orthoimage and CTX stereo DTM, approximately 20 m posting",
        "attribution": "USGS Astrogeology Science Center / Mars CTX stereo products",
        "bbox_projected_m_west_south_east_north": bounds,
        "width_m": source_width_m,
        "height_m": source_height_m,
        "raster_width": MAX_WIDTH,
        "raster_height": height,
        "elevation_min_m": minimum,
        "elevation_max_m": maximum,
        "texture": "./data/jezero3d/jezero-surface.jpg",
        "heightmap": "./data/jezero3d/jezero-height.png",
        "heightmap_encoding": "R and G store normalized 16-bit elevation; B=255 means valid DTM sample",
        "horizontal_scene_scale": 0.1,
        "vertical_exaggeration": 2.0,
        "source_resolution_m": source_resolution,
    }
    (OUTPUT / "scene.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Exported {MAX_WIDTH}×{height} Jezero scene assets to {OUTPUT}")
    for filename in ("jezero-surface.jpg", "jezero-height.png", "scene.json"):
        path = OUTPUT / filename
        print(f"  {filename}: {path.stat().st_size / (1024 * 1024):.2f} MB")


if __name__ == "__main__":
    main()
