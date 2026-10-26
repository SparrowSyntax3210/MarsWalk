"""Build a full-coverage, multi-resolution Jezero image/terrain feature package.

High-resolution image and DTM-derived geometry stay on the local CTX grid.
The existing 1 km global Parquet rows are clipped separately so coarse TES,
MCD, geology, dune, and crater fields retain their true source resolution.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds
from rasterio.windows import Window

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
DATA = ROOT / "data"
VISION_DIR = DATA / "processed" / "vision_prototype" / "jezero_ctx"
DTM_PATH = DATA / "raw" / "dem" / "local_dtms" / "ctx_jezero_P18_007925_1987_XN_18N282W__P19_008650_1987_XI_18N282W_dtm.tif"
IMAGE_PATH = DATA / "raw" / "imagery" / "ctx_jezero_P18_007925_1987_XN_18N282W__P19_008650_1987_XI_18N282W_orthoimage.tif"
TILE_ROOT = DATA / "processed" / "feature_store" / "global_tiles" / "10deg"
CONTEXT_OUT = VISION_DIR / "jezero_context_1km.parquet"
STACK_OUT = VISION_DIR / "jezero_full_scene_features_20m.tif"
METADATA_OUT = VISION_DIR / "full_scene_metadata.json"
NODATA = -9999.0
MARS_RADIUS_M = 3_396_190.0
BLOCK_ROWS = 256


def build_local_stack() -> dict:
    """Write image + DTM + A*-matching local terrain metrics in row blocks."""
    if not DTM_PATH.is_file() or not IMAGE_PATH.is_file():
        raise FileNotFoundError("Both the Jezero CTX DTM and matching orthoimage are required.")
    # Keep the same TTA-style 3x3 plane geometry implementation as local A*.
    sys.path.insert(0, str(SCRIPT_DIR))
    from adaptive_route_planner import local_geometry

    with rasterio.open(DTM_PATH) as dem, rasterio.open(IMAGE_PATH) as image:
        if dem.crs is None or image.crs is None:
            raise ValueError("The DTM and orthoimage must both have a CRS.")
        if image.crs != dem.crs:
            aligned = WarpedVRT(image, crs=dem.crs, transform=dem.transform,
                                width=dem.width, height=dem.height,
                                resampling=Resampling.bilinear)
        else:
            aligned = image
        profile = dem.profile.copy()
        profile.update(driver="GTiff", count=6, dtype="float32", nodata=NODATA,
                       compress="deflate", predictor=3, tiled=True,
                       blockxsize=256, blockysize=256)
        with rasterio.open(STACK_OUT, "w", **profile) as dst:
            descriptions = [
                "ctx_orthoimage_dn", "elevation_m", "slope_deg",
                "aspect_downslope_deg", "roughness_3x3_plane_rms_m",
                "relief_3x3_max_minus_min_m",
            ]
            for band, description in enumerate(descriptions, start=1):
                dst.set_band_description(band, description)
            dst.update_tags(
                region="Jezero crater CTX stereo product footprint",
                source_image=str(IMAGE_PATH), source_dtm=str(DTM_PATH),
                formula="A* local_geometry(): least-squares 3x3 plane slope/aspect, RMS plane residual, and 3x3 elevation range",
                note="This high-resolution stack does not upsample the 1 km TES/MCD/vector context fields.",
            )
            for row0 in range(0, dem.height, BLOCK_ROWS):
                rows = min(BLOCK_ROWS, dem.height - row0)
                row1 = row0 + rows
                halo0 = max(0, row0 - 1)
                halo1 = min(dem.height, row1 + 1)
                halo_window = Window(0, halo0, dem.width, halo1 - halo0)
                elevation_halo = dem.read(1, window=halo_window, masked=True)
                width_m = abs(float(dem.res[0]))
                height_m = abs(float(dem.res[1]))
                geom_valid, slope, roughness, relief, aspect = local_geometry(
                    elevation_halo, width_m, height_m
                )
                cut0 = row0 - halo0
                cut1 = cut0 + rows
                selection = slice(cut0, cut1)
                target_window = Window(0, row0, dem.width, rows)
                image_values = aligned.read(1, window=target_window, masked=True).astype(np.float32)
                elevation = dem.read(1, window=target_window, masked=True).astype(np.float32)
                valid_geom = geom_valid[selection]
                feature_arrays = [
                    image_values.filled(NODATA),
                    elevation.filled(NODATA),
                    np.where(valid_geom, slope[selection], NODATA),
                    np.where(valid_geom, aspect[selection], NODATA),
                    np.where(valid_geom, roughness[selection], NODATA),
                    np.where(valid_geom, relief[selection], NODATA),
                ]
                dst.write(np.stack(feature_arrays).astype(np.float32), window=target_window)
                print(f"Wrote local feature rows {row1:,}/{dem.height:,}", flush=True)
        bbox = transform_bounds(dem.crs, dem.crs.geodetic_crs, *dem.bounds, densify_pts=41)
        return {
            "crs_wkt": dem.crs.to_wkt(),
            "transform": list(dem.transform)[:6],
            "width": dem.width,
            "height": dem.height,
            "resolution_map_m": list(dem.res),
            "bbox_lonlat_west_south_east_north": list(bbox),
            "band_descriptions": descriptions,
            "footprint_rows_written": dem.height,
        }


def crop_context(bounds: list[float]) -> dict:
    west, south, east, north = bounds
    center_lon = (west + east) / 2.0
    center_lat = (south + north) / 2.0
    tile_west = math.floor(center_lon / 10.0) * 10
    tile_south = math.floor(center_lat / 10.0) * 10
    tile_name = f"tile_10deg_w{tile_west}_s{tile_south}.parquet"
    tile_path = TILE_ROOT / tile_name
    manifest_path = tile_path.with_suffix(".manifest.json")
    if not tile_path.is_file():
        raise FileNotFoundError(f"Expected coarse context tile is missing: {tile_path}")
    frame = pd.read_parquet(tile_path)
    # Include neighboring source cells so routes near the footprint edge can snap/sample.
    margin_deg = 0.02
    subset = frame.loc[
        frame.latitude_deg.between(south - margin_deg, north + margin_deg)
        & frame.longitude_east_deg.between(west - margin_deg, east + margin_deg)
    ].copy().reset_index(drop=True)
    if subset.empty:
        raise ValueError("No global Parquet context cells intersect the Jezero CTX footprint.")
    subset.to_parquet(CONTEXT_OUT, index=False, compression="zstd")
    source_manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    return {
        "source_tile": str(tile_path),
        "source_manifest": str(manifest_path),
        "tile_resolution_note": source_manifest.get("terrain_resolution", "nominal 1 km terrain grid"),
        "rows": len(subset),
        "columns": list(subset.columns),
        "bounds_lonlat_with_margin": [west - margin_deg, south - margin_deg, east + margin_deg, north + margin_deg],
        "mcd_metadata": source_manifest.get("mcd", {}),
        "semantic_metadata": {
            "dune_hit": source_manifest.get("dune_semantics"),
            "dune_distance_km": source_manifest.get("dune_distance_semantics"),
            "crater_edge_distance_km": source_manifest.get("crater_distance_semantics"),
            "mcd_spatial_resolution": source_manifest.get("mcd_spatial_resolution_note"),
        },
    }


def main() -> int:
    VISION_DIR.mkdir(parents=True, exist_ok=True)
    highres = build_local_stack()
    context = crop_context(highres["bbox_lonlat_west_south_east_north"])
    metadata = {
        "region": "Jezero crater local CTX stereo footprint",
        "high_resolution_stack": str(STACK_OUT),
        "high_resolution_stack_m": highres,
        "coarse_context_parquet": str(CONTEXT_OUT),
        "coarse_context": context,
        "usage": {
            "vision_model": "Use ctx_orthoimage_dn as image input; DTM-derived bands are terrain context and weak-label sources, not proof of image-classifier accuracy.",
            "A_star": "Use local elevation/slope/aspect/roughness at DTM scale; sample vector/TES/MCD context at its native nominal 1 km scale.",
            "resolution_warning": "The high-resolution DTM does not make the coarse TES, MCD, geology, crater, or dune fields 20 m measurements.",
        },
    }
    METADATA_OUT.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"High-resolution stack: {STACK_OUT} ({STACK_OUT.stat().st_size/1e6:,.1f} MB)")
    print(f"1 km all-factor context: {CONTEXT_OUT} ({context['rows']:,} rows, {len(context['columns'])} columns)")
    print(f"Metadata: {METADATA_OUT}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Jezero full-feature build failed: {exc}", file=sys.stderr)
        raise
