"""A* route planner over completed 10-degree Mars Parquet tiles.

This is an explainable terrain-cost planner, not a learned model or rover-certified safety system.
"""
from __future__ import annotations

import csv
import heapq
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
TILE_DIR = ROOT / "data" / "processed" / "feature_store" / "global_tiles" / "10deg"
CATALOG = TILE_DIR.parent / "tiles_catalog.csv"
MARS_RADIUS_M = 3_389_500.0
CORRIDOR_MARGIN_KM = 20.0
MAX_ROUTE_KM = 500.0
MAX_TILES_PER_REQUEST = 12
MAX_SNAP_KM = 5.0
CRATER_AVOID_BUFFER_KM = 0.5
ROUTE_COLUMNS = [
    "row", "col", "latitude_deg", "longitude_east_deg", "elevation_m",
    "slope_deg", "aspect_deg", "roughness_3x3_range_m", "cell_width_m",
    "cell_height_m", "geology_unit_code", "dune_hit", "dune_distance_km",
    "crater_edge_distance_km",
]
MODE_SETTINGS = {
    "fastest": {"risk_weight": 0.35, "max_slope_deg": 25.0},
    "balanced": {"risk_weight": 1.5, "max_slope_deg": 20.0},
    "safest": {"risk_weight": 3.0, "max_slope_deg": 15.0},
}


def normalize_lon(lon: float) -> float:
    return (lon + 180.0) % 360.0 - 180.0


def mars_distance_km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians((lon2 - lon1 + 180.0) % 360.0 - 180.0)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * MARS_RADIUS_M * math.asin(min(1.0, math.sqrt(h))) / 1000.0


def read_catalog():
    if not CATALOG.is_file():
        raise ValueError(f"Global tile catalog is missing: {CATALOG}")
    with CATALOG.open(newline="", encoding="utf-8-sig") as stream:
        return list(csv.DictReader(stream))


def longitude_intervals(start_lon, end_lon, mean_lat, margin_km):
    # Follow the shorter longitude arc; split the query at the date line if needed.
    delta = (end_lon - start_lon + 180.0) % 360.0 - 180.0
    center = normalize_lon(start_lon + delta / 2.0)
    half_width = abs(delta) / 2.0 + margin_km / (111.2 * max(abs(math.cos(math.radians(mean_lat))), 0.05))
    if half_width >= 180.0:
        return [(-180.0, 180.0)]
    west, east = center - half_width, center + half_width
    if west < -180.0:
        return [(-180.0, east), (west + 360.0, 180.0)]
    if east > 180.0:
        return [(-180.0, east - 360.0), (west, 180.0)]
    return [(west, east)]


def intersects_tile(tile, south, north, lon_intervals):
    tw, ts, te, tn = (float(tile[k]) for k in ("west", "south", "east", "north"))
    if tn <= south or ts >= north:
        return False
    return any(te > west and tw < east for west, east in lon_intervals)


def validate_point(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"Provide {name} as {{lat, lon}}.")
    try:
        lat, lon = float(value["lat"]), float(value["lon"])
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"{name} needs numeric lat and lon values.")
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        raise ValueError(f"{name} is outside valid Mars latitude/longitude ranges.")
    return lat, normalize_lon(lon)


def load_route_corridor(payload):
    start = validate_point(payload.get("start"), "start")
    end = validate_point(payload.get("end"), "end")
    requested_distance = mars_distance_km(*start, *end)
    if requested_distance < 0.01:
        raise ValueError("Start and end must be at least 10 metres apart.")
    if requested_distance > MAX_ROUTE_KM:
        raise ValueError(f"This route planner currently limits a single request to {MAX_ROUTE_KM:.0f} km; requested distance is {requested_distance:.1f} km.")

    mean_lat = (start[0] + end[0]) / 2.0
    lat_margin = CORRIDOR_MARGIN_KM / 111.2
    south = max(-90.0, min(start[0], end[0]) - lat_margin)
    north = min(90.0, max(start[0], end[0]) + lat_margin)
    lon_intervals = longitude_intervals(start[1], end[1], mean_lat, CORRIDOR_MARGIN_KM)
    catalog = read_catalog()
    expected = [t for t in catalog if intersects_tile(t, south, north, lon_intervals)]
    available = []
    missing = []
    for tile in expected:
        parquet = ROOT / tile["parquet_path"]
        manifest = ROOT / tile["manifest_path"]
        if tile.get("status") == "complete" and parquet.is_file() and manifest.is_file():
            available.append(parquet)
        else:
            missing.append(tile["tile_id"])
    if missing:
        preview = ", ".join(missing[:6])
        more = f" and {len(missing)-6} more" if len(missing) > 6 else ""
        raise ValueError(f"Route corridor includes {len(missing)} tile(s) that are not complete ({preview}{more}). Build those global tiles before routing.")
    if not available:
        raise ValueError("No completed global Parquet tiles cover this route area yet.")
    if len(available) > MAX_TILES_PER_REQUEST:
        raise ValueError(f"This route corridor touches {len(available)} tiles; the current request limit is {MAX_TILES_PER_REQUEST}. Shorten the route or reduce the corridor margin.")

    frames = []
    for path in available:
        frame = pd.read_parquet(path, columns=ROUTE_COLUMNS)
        # Tile-edge pixels can be present in two neighboring files; retain one copy.
        frames.append(frame)
    frame = pd.concat(frames, ignore_index=True).drop_duplicates(["row", "col"], keep="first")
    lat_ok = frame.latitude_deg.between(south, north)
    lon_ok = np.zeros(len(frame), dtype=bool)
    for west, east in lon_intervals:
        lon_ok |= frame.longitude_east_deg.between(west, east).to_numpy()
    frame = frame.loc[lat_ok.to_numpy() & lon_ok].copy().reset_index(drop=True)
    frame = frame.replace([np.inf, -np.inf], np.nan)
    frame = frame.dropna(subset=["row", "col", "latitude_deg", "longitude_east_deg", "elevation_m", "cell_width_m", "cell_height_m"])
    if len(frame) < 2:
        raise ValueError("Completed tiles do not contain enough valid terrain cells in the route corridor.")
    return start, end, requested_distance, frame, len(available)


def tta_geometry(frame):
    """Fit a 3x3 local plane per DEM cell and derive TTA geometry features.

    x points east and y points north in local metres. At the global DEM scale,
    each 3x3 window is roughly 3 km across, so this is a regional proxy rather
    than the paper's rover-local 2 m perception window.
    """
    rows = frame.row.to_numpy(dtype=np.int64)
    cols = frame.col.to_numpy(dtype=np.int64)
    z = frame.elevation_m.to_numpy(dtype=float)
    width = frame.cell_width_m.to_numpy(dtype=float)
    height = frame.cell_height_m.to_numpy(dtype=float)
    n = len(frame)
    index = pd.MultiIndex.from_arrays([rows, cols], names=["row", "col"])
    sum_z = np.zeros(n, dtype=float)
    sum_xz = np.zeros(n, dtype=float)
    sum_yz = np.zeros(n, dtype=float)
    max_z = np.full(n, -np.inf, dtype=float)
    min_z = np.full(n, np.inf, dtype=float)
    count = np.zeros(n, dtype=np.uint8)

    def neighbor_values(dr, dc):
        target = pd.MultiIndex.from_arrays([rows + dr, cols + dc])
        positions = index.get_indexer(target)
        values = np.full(n, np.nan, dtype=float)
        present = positions >= 0
        values[present] = z[positions[present]]
        return values, np.isfinite(values)

    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            values, valid = neighbor_values(dr, dc)
            x = dc * width
            y = -dr * height
            count += valid.astype(np.uint8)
            sum_z += np.where(valid, values, 0.0)
            sum_xz += np.where(valid, x * values, 0.0)
            sum_yz += np.where(valid, y * values, 0.0)
            max_z = np.where(valid, np.maximum(max_z, values), max_z)
            min_z = np.where(valid, np.minimum(min_z, values), min_z)

    valid_window = (count == 9) & np.isfinite(width) & np.isfinite(height) & (width > 0) & (height > 0)
    a0 = np.full(n, np.nan, dtype=float)
    a1 = np.full(n, np.nan, dtype=float)
    a2 = np.full(n, np.nan, dtype=float)
    a0[valid_window] = sum_xz[valid_window] / (6.0 * width[valid_window] ** 2)
    a1[valid_window] = sum_yz[valid_window] / (6.0 * height[valid_window] ** 2)
    a2[valid_window] = sum_z[valid_window] / 9.0

    residual_sq = np.zeros(n, dtype=float)
    normal_scale = np.sqrt(a0 * a0 + a1 * a1 + 1.0)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            values, valid = neighbor_values(dr, dc)
            fitted = a0 * (dc * width) + a1 * (-dr * height) + a2
            residual_sq += np.where(valid, (fitted - values) ** 2, 0.0)

    slope = np.full(n, np.nan, dtype=float)
    roughness = np.full(n, np.nan, dtype=float)
    height_difference = np.full(n, np.nan, dtype=float)
    aspect = np.full(n, np.nan, dtype=float)
    slope[valid_window] = np.degrees(np.arctan(np.sqrt(a0[valid_window] ** 2 + a1[valid_window] ** 2)))
    roughness[valid_window] = np.sqrt(residual_sq[valid_window] / 9.0) / normal_scale[valid_window]
    height_difference[valid_window] = max_z[valid_window] - min_z[valid_window]
    aspect[valid_window] = np.degrees(np.arctan2(-a0[valid_window], -a1[valid_window])) % 360.0
    return {
        "valid": valid_window,
        "slope_deg": slope,
        "aspect_deg": aspect,
        "roughness_rms_m": roughness,
        "height_difference_m": height_difference,
    }


def row_risk(frame, geometry):
    """TTA-GEP-inspired 0..1 cost using global DEM-scale normalizers.

    The geology code is nominal, not a calibrated mobility score. Its semantic
    weight is omitted and the available dune/crater weights are renormalized.
    """
    slope = np.clip(geometry["slope_deg"] / 25.0, 0.0, 1.0)
    height = np.clip(geometry["height_difference_m"] / 200.0, 0.0, 1.0)
    roughness = np.clip(geometry["roughness_rms_m"] / 50.0, 0.0, 1.0)
    dune_distance = frame.dune_distance_km.fillna(3.0).to_numpy(dtype=float)
    crater_distance = frame.crater_edge_distance_km.fillna(10.0).to_numpy(dtype=float)
    dune_hazard = np.clip((3.0 - dune_distance) / 3.0, 0.0, 1.0)
    dune_hazard = np.maximum(dune_hazard, frame.dune_hit.fillna(0).to_numpy(dtype=float))
    crater_hazard = np.clip((5.0 - crater_distance) / 5.0, 0.0, 1.0)
    semantic = (0.40 * dune_hazard + 0.35 * crater_hazard) / 0.75
    cost = 0.50 * slope + 0.25 * height + 0.15 * roughness + 0.10 * semantic
    cost[~geometry["valid"]] = np.nan
    return np.clip(cost, 0.0, 1.0)


def classify_cells(frame, geometry, costs, max_slope):
    classes = np.full(len(frame), "unknown", dtype=object)
    dune_hit = frame.dune_hit.fillna(0).to_numpy(dtype=int) == 1
    crater_distance = frame.crater_edge_distance_km.fillna(10.0).to_numpy(dtype=float)
    crater_blocked = crater_distance <= CRATER_AVOID_BUFFER_KM
    hard_block = geometry["valid"] & (dune_hit | crater_blocked | (geometry["slope_deg"] > max_slope))
    classes[hard_block] = "impassable"
    candidates = geometry["valid"] & ~hard_block & np.isfinite(costs)
    classes[candidates & (costs >= 0.67)] = "high"
    classes[candidates & (costs >= 0.33) & (costs < 0.67)] = "caution"
    classes[candidates & (costs < 0.33)] = "safe"
    return classes

def nearest_cell(lat, lon, latitudes, longitudes, allowed=None):
    """Return the closest cell, optionally restricted to a boolean allowed mask."""
    candidates = np.arange(len(latitudes)) if allowed is None else np.flatnonzero(allowed)
    if candidates.size == 0:
        return None, math.inf

    lat1 = math.radians(lat)
    p = np.radians(latitudes[candidates])
    dlat = p - lat1
    dlon = np.radians((longitudes[candidates] - lon + 180.0) % 360.0 - 180.0)
    h = np.sin(dlat / 2) ** 2 + math.cos(lat1) * np.cos(p) * np.sin(dlon / 2) ** 2
    distances = (2 * MARS_RADIUS_M * np.arcsin(np.sqrt(np.clip(h, 0, 1)))) / 1000.0
    candidate_offset = int(np.argmin(distances))
    return int(candidates[candidate_offset]), float(distances[candidate_offset])

def plan(payload):
    start, end, requested_distance, frame, tile_count = load_route_corridor(payload)
    mode = str(payload.get("mode", "balanced")).lower()
    if mode not in MODE_SETTINGS:
        raise ValueError("mode must be one of: fastest, balanced, safest.")
    settings = MODE_SETTINGS[mode]
    try:
        max_slope = float(payload.get("max_slope_deg", settings["max_slope_deg"]))
    except (TypeError, ValueError):
        raise ValueError("max_slope_deg must be a number between 0 and 45.")
    if not 0.0 < max_slope <= 45.0:
        raise ValueError("max_slope_deg must be greater than 0 and at most 45.")

    latitudes = frame.latitude_deg.to_numpy(dtype=float)
    longitudes = frame.longitude_east_deg.to_numpy(dtype=float)
    rows = frame.row.to_numpy(dtype=np.int64)
    cols = frame.col.to_numpy(dtype=np.int64)
    geometry = tta_geometry(frame)
    slopes = geometry["slope_deg"]
    roughness = geometry["roughness_rms_m"]
    height_difference = geometry["height_difference_m"]
    risks = row_risk(frame, geometry)
    cell_classes = classify_cells(frame, geometry, risks, max_slope)
    passable = np.isin(cell_classes, ["safe", "caution", "high"])

    # Prefer the nearest traversable cell; the nearest DEM cell may be blocked
    # even when an accessible neighboring cell is available.
    start_ix, start_snap = nearest_cell(*start, latitudes, longitudes, passable)
    end_ix, end_snap = nearest_cell(*end, latitudes, longitudes, passable)
    if start_ix is None or start_snap > MAX_SNAP_KM:
        raise ValueError(f"No passable terrain cell is within {MAX_SNAP_KM:.0f} km of the start point; choose another start point or a less restrictive route mode.")
    if end_ix is None or end_snap > MAX_SNAP_KM:
        raise ValueError(f"No passable terrain cell is within {MAX_SNAP_KM:.0f} km of the destination; choose another destination or a less restrictive route mode.")

    # Sparse lookup over only the local corridor; neighbors are 8-connected raster cells.
    lookup = {(int(r), int(c)): i for i, (r, c) in enumerate(zip(rows, cols))}
    goal_lat, goal_lon = latitudes[end_ix], longitudes[end_ix]
    best = {start_ix: 0.0}
    previous = {}
    queue = [(mars_distance_km(latitudes[start_ix], longitudes[start_ix], goal_lat, goal_lon), 0.0, start_ix)]
    closed = set()
    while queue:
        _, cost, node = heapq.heappop(queue)
        if node in closed or cost > best.get(node, math.inf):
            continue
        if node == end_ix:
            break
        closed.add(node)
        r, c = rows[node], cols[node]
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nxt = lookup.get((int(r + dr), int(c + dc)))
                if nxt is None or nxt in closed or not passable[nxt]:
                    continue
                # Keep a diagonal from cutting across a blocked or missing
                # orthogonal cell, including at a stitched tile seam.
                if dr and dc:
                    side_a = lookup.get((int(r + dr), int(c)))
                    side_b = lookup.get((int(r), int(c + dc)))
                    if (side_a is None or side_b is None
                            or not passable[side_a] or not passable[side_b]):
                        continue
                distance = mars_distance_km(latitudes[node], longitudes[node], latitudes[nxt], longitudes[nxt])
                edge = distance * (1.0 + settings["risk_weight"] * (risks[node] + risks[nxt]) / 2.0)
                candidate = cost + edge
                if candidate < best.get(nxt, math.inf):
                    best[nxt] = candidate
                    previous[nxt] = node
                    heuristic = mars_distance_km(latitudes[nxt], longitudes[nxt], goal_lat, goal_lon)
                    heapq.heappush(queue, (candidate + heuristic, candidate, nxt))

    if end_ix != start_ix and end_ix not in previous:
        raise ValueError("No connected path was found. Tiles may be missing inside the corridor, or terrain constraints may block all paths.")
    path = [end_ix]
    while path[-1] != start_ix:
        path.append(previous[path[-1]])
    path.reverse()
    distance_km = sum(mars_distance_km(latitudes[a], longitudes[a], latitudes[b], longitudes[b]) for a, b in zip(path, path[1:]))
    path_slopes = slopes[path]
    path_roughness = roughness[path]
    path_height_difference = height_difference[path]
    path_classes = cell_classes[path]
    path_risk = risks[path]
    coordinates = [[round(float(longitudes[i]), 6), round(float(latitudes[i]), 6)] for i in path]
    route_cell_details = [
        {
            "lat": round(float(latitudes[i]), 6),
            "lon": round(float(longitudes[i]), 6),
            "class": str(cell_classes[i]),
            "cost_0_to_1": round(float(risks[i]), 4),
            "slope_deg": round(float(slopes[i]), 3),
            "aspect_deg": round(float(geometry["aspect_deg"][i]), 2),
            "height_difference_m": round(float(height_difference[i]), 2),
            "roughness_rms_m": round(float(roughness[i]), 2),
        }
        for i in path
    ]
    class_counts = {name: int(np.sum(path_classes == name)) for name in ("impassable", "high", "caution", "safe", "unknown")}
    return {
        "status": "success",
        "planner": "A* over completed global 10-degree Parquet tiles",
        "mode": mode,
        "data_resolution_m": "nominally about 1 km; varies by source raster and latitude",
        "tile_count_used": tile_count,
        "endpoints": {
            "start": {"lat": float(latitudes[start_ix]), "lon": float(longitudes[start_ix]), "snap_distance_km": round(start_snap, 3)},
            "end": {"lat": float(latitudes[end_ix]), "lon": float(longitudes[end_ix]), "snap_distance_km": round(end_snap, 3)},
        },
        "route": {"type": "Feature", "properties": {"cost_model": "edge distance × (1 + mode risk weight × mean TTA-GEP-inspired cell cost)"},
                  "geometry": {"type": "LineString", "coordinates": coordinates}},
        "route_cell_details": route_cell_details,
        "terrain_assessment": {
            "method": "TTA-GEP-inspired 3x3 DEM plane fit",
            "weights": {"slope": 0.50, "height_difference": 0.25, "plane_roughness": 0.15, "terrain_semantics": 0.10},
            "global_normalizers": {"slope_deg": 25.0, "height_difference_m": 200.0, "roughness_rms_m": 50.0, "dune_proximity_km": 3.0, "crater_proximity_km": 5.0},
            "class_counts_on_route": class_counts,
            "class_thresholds": {"safe_max_exclusive": 0.33, "caution_min": 0.33, "high_min": 0.67, "impassable": f"mapped dune, crater footprint/near-edge zone (≤{CRATER_AVOID_BUFFER_KM:.1f} km), or slope above selected mode limit", "unknown": "incomplete 3x3 DEM neighborhood"},
            "semantic_factors_used": ["mapped dune proximity", "approximate crater-edge proximity"],
            "semantic_factors_not_scored": ["geology unit code has no calibrated mobility-risk lookup"],
        },
        "metrics": {
            "requested_straight_distance_km": round(requested_distance, 2),
            "distance_km": round(distance_km, 2),
            "max_slope_deg": round(float(np.max(path_slopes)), 2),
            "mean_slope_deg": round(float(np.mean(path_slopes)), 2),
            "max_roughness_rms_m": round(float(np.max(path_roughness)), 2),
            "max_height_difference_m": round(float(np.max(path_height_difference)), 2),
            "mean_terrain_risk_0_to_1": round(float(np.mean(path_risk)), 3),
            "route_cells": len(path),
            "search_cells": len(frame),
            "weighted_cost_km_equivalent": round(float(best[end_ix]), 2),
        },
        "cost_factors": ["least-squares plane slope", "3x3 plane residual RMS roughness", "3x3 elevation height difference", "mapped dune proximity and exclusion", "approximate crater-edge proximity and exclusion"],
        "limitations": [
            "Only completed tiles are routable; the catalog currently represents partial global coverage.",
            "Mapped dune-hit cells and cells above the selected mode slope limit are impassable.",
            "The 3x3 fit spans about 3 km at this global DEM resolution, not the published rover-local 2 m window.",
            "The published 10 degree slope, 0.15 m height, and 0.03 m roughness thresholds are not applied to roughly 1 km cells.",
            "Global normalizers and 0.33/0.67 risk bands are provisional planning values and need calibration.",
            "Geology unit codes are nominal; no geology risk is scored without a material lookup.",
            "Crater distance is an approximate nearest-center-minus-radius estimate; a crater is not automatically impassable.",
            "The route does not predict wheel slip, travel time, energy, radiation dose, or a probability of safety.",
            "The result is a planning aid and needs higher-resolution local hazard data before operational use.",
        ],
    }


def main():
    try:
        result = plan(json.load(sys.stdin))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        raise SystemExit(1)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
