"""Return the nearest global feature-store cell for one Mars coordinate.

Usage: python point_cell_lookup.py <lat> <lon_east>

Reads the matching 10-degree Parquet tile listed in
data/catalog/global_tile_catalog.csv and prints one JSON object to stdout.
Values are the precomputed cell attributes (nominal ~1 km terrain grid,
TES thermal inertia, mapped dunes/craters, and Mars Climate Database
context). Nothing is interpolated or estimated here.
"""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data" / "catalog" / "global_tile_catalog.csv"
GEOLOGY_CODEBOOK = ROOT / "data" / "catalog" / "geology_unit_codebook.csv"
MAX_CELL_DISTANCE_KM = 5.0
MARS_RADIUS_KM = 3389.5


def fail(message: str, code: int = 1) -> None:
    print(json.dumps({"error": message}))
    sys.exit(code)


def find_tile(lat: float, lon: float) -> dict | None:
    with CATALOG.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            west, south = float(row["west"]), float(row["south"])
            east, north = float(row["east"]), float(row["north"])
            # Half-open bounds, closed on the global east/north edges.
            in_lon = west <= lon < east or (east == 180 and lon == 180)
            in_lat = south <= lat < north or (north == 90 and lat == 90)
            if in_lon and in_lat:
                return row
    return None


def load_geology_codebook() -> dict[int, dict]:
    if not GEOLOGY_CODEBOOK.exists():
        return {}
    with GEOLOGY_CODEBOOK.open(newline="", encoding="utf-8") as handle:
        return {
            int(row["geology_unit_code"]): {
                "code": row["source_unit_code"],
                "description": row["description"],
            }
            for row in csv.DictReader(handle)
            if row.get("geology_unit_code", "").strip().lstrip("-").isdigit()
        }


def clean(value):
    """Convert numpy/pyarrow scalars to JSON-safe values; NaN becomes None."""
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (np.floating,)):
        value = float(value)
        return value if math.isfinite(value) else None
    if isinstance(value, (np.integer,)):
        return int(value)
    return value


def main() -> None:
    if len(sys.argv) != 3:
        fail("Expected latitude and longitude arguments.", 2)
    try:
        lat = float(sys.argv[1])
        lon = float(sys.argv[2])
    except ValueError:
        fail("Latitude and longitude must be numbers.", 2)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        fail("Coordinates are out of range.", 2)
    if not CATALOG.exists():
        fail("Global tile catalog is missing.")

    tile = find_tile(lat, lon)
    if not tile:
        fail("No feature-store tile covers this coordinate.")
    parquet_path = ROOT / tile["parquet_path"].replace("\\", "/")
    if tile["status"] != "complete" or not parquet_path.exists():
        fail(f"Feature-store tile {tile['tile_id']} is not available locally.")

    table = pq.read_table(parquet_path)
    lats = table["latitude_deg"].to_numpy()
    lons = table["longitude_east_deg"].to_numpy()
    # Equirectangular distance is accurate enough for a nearest-cell pick
    # inside a 10-degree tile.
    cos_lat = math.cos(math.radians(lat))
    d2 = (lats - lat) ** 2 + ((lons - lon) * cos_lat) ** 2
    index = int(np.argmin(d2))
    distance_km = math.radians(math.sqrt(float(d2[index]))) * MARS_RADIUS_KM
    if distance_km > MAX_CELL_DISTANCE_KM:
        fail("No feature-store cell lies near this coordinate.")

    record = {key: clean(value) for key, value in table.slice(index, 1).to_pylist()[0].items()}
    geology = load_geology_codebook().get(record.get("geology_unit_code"))

    manifest = {}
    manifest_path = ROOT / (tile.get("manifest_path") or "").replace("\\", "/")
    if not tile.get("manifest_path") or not manifest_path.exists():
        manifest_path = parquet_path.with_suffix(".manifest.json")
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            manifest = {}
    mcd = manifest.get("mcd", {})

    print(json.dumps({
        "tileId": tile["tile_id"],
        "cellDistanceKm": distance_km,
        "cell": record,
        "geology": geology,
        "terrainResolution": manifest.get("terrain_resolution", "nominal 1 km at equator"),
        "mcdContext": {
            "scenario": mcd.get("scenario"),
            "solarLongitudeDeg": mcd.get("ls_deg"),
            "localTimeHours": mcd.get("local_true_solar_time_hours"),
            "gridResolution": mcd.get("grid_resolution"),
        },
    }))


if __name__ == "__main__":
    main()
