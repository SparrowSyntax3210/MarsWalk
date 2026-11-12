"""Build compact, hosted route grids for six MarsWalk regions from local global tiles."""
from __future__ import annotations

import csv
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "processed" / "feature_store" / "global_tiles" / "10deg"
OUTPUT = ROOT / "data" / "processed" / "route_regions"
ROUTE_COLUMNS = [
    "row", "col", "latitude_deg", "longitude_east_deg", "elevation_m",
    "slope_deg", "aspect_deg", "roughness_3x3_range_m", "cell_width_m",
    "cell_height_m", "geology_unit_code", "dune_hit", "dune_distance_km",
    "crater_edge_distance_km",
]
REGIONS = [
    ("jezero", "Jezero Crater", 18.38, 77.58, "tile_10deg_w70_s10.parquet"),
    ("gale", "Gale Crater", -5.4, 137.8, "tile_10deg_w130_s-10.parquet"),
    ("olympus-mons", "Olympus Mons", 18.65, -133.8, "tile_10deg_w-140_s10.parquet"),
    ("valles-marineris", "Valles Marineris", -13.9, -59.2, "tile_10deg_w-60_s-20.parquet"),
    ("hellas-planitia", "Hellas Planitia", -42.4, 70.5, "tile_10deg_w70_s-50.parquet"),
    ("elysium-planitia", "Elysium Planitia", 4.5, 135.9, "tile_10deg_w130_s0.parquet"),
]
HALF_SPAN_DEGREES = 2.0


def build() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    catalog_rows = []
    for slug, name, latitude, longitude, source_name in REGIONS:
        source_path = SOURCE / source_name
        if not source_path.is_file():
            raise FileNotFoundError(f"Required local source tile is missing: {source_path}")
        west, east = longitude - HALF_SPAN_DEGREES, longitude + HALF_SPAN_DEGREES
        south, north = latitude - HALF_SPAN_DEGREES, latitude + HALF_SPAN_DEGREES
        frame = pd.read_parquet(source_path, columns=ROUTE_COLUMNS)
        keep = frame.latitude_deg.between(south, north) & frame.longitude_east_deg.between(west, east)
        crop = frame.loc[keep].dropna(subset=["row", "col", "latitude_deg", "longitude_east_deg", "elevation_m"])
        if crop.empty:
            raise ValueError(f"The selected source tile has no route cells for {name}.")
        data_path = OUTPUT / f"{slug}.parquet"
        manifest_path = OUTPUT / f"{slug}.manifest.json"
        crop.to_parquet(data_path, index=False, compression="zstd")
        manifest = {
            "region": name,
            "source": source_name,
            "bounds": {"west": west, "south": south, "east": east, "north": north},
            "rows": len(crop),
            "columns": ROUTE_COLUMNS,
            "resolution_note": "Derived from the MarsWalk global grid; nominal approximately 1 km cells.",
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        catalog_rows.append({
            "tile_id": f"region_{slug}", "region": name,
            "west": west, "south": south, "east": east, "north": north,
            "status": "complete",
            "parquet_path": f"data/processed/route_regions/{data_path.name}",
            "manifest_path": f"data/processed/route_regions/{manifest_path.name}",
            "rows": len(crop), "bytes": data_path.stat().st_size,
        })
        print(f"{name}: {len(crop):,} cells, {data_path.stat().st_size:,} bytes")
    with (OUTPUT / "catalog.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=catalog_rows[0].keys())
        writer.writeheader()
        writer.writerows(catalog_rows)


if __name__ == "__main__":
    build()
