"""A* route planner over the saved 2,128-cell local corridor feature grid."""
from __future__ import annotations

import heapq
import json
import math
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
GRID = ROOT / "data" / "processed" / "route_grid" / "sample_corridor_jezero.parquet"
MARS_RADIUS_M = 3_389_500.0
MAX_SNAP_KM = 2.0
MAX_SLOPE_DEG = 20.0
MAX_ROUGHNESS_M = 250.0


def haversine_km(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians((b_lon - a_lon + 180.0) % 360.0 - 180.0)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * MARS_RADIUS_M * math.asin(min(1.0, math.sqrt(h))) / 1000.0


def risk(row):
    # A deliberately simple, explainable terrain penalty; it is not calibrated rover physics.
    slope = min(max(float(row.slope_deg), 0.0) / MAX_SLOPE_DEG, 1.0)
    roughness = min(max(float(row.roughness_3x3_range_m), 0.0) / MAX_ROUGHNESS_M, 1.0)
    # Older corridor exports do not contain dune_distance_km; dune_hit remains a hard exclusion.
    dune_distance = float(row.get("dune_distance_km", 3.0))
    dune_near = max(0.0, (3.0 - dune_distance) / 3.0)
    return 0.65 * slope + 0.35 * roughness + 0.5 * dune_near


def plan(payload):
    if not GRID.is_file():
        raise ValueError(f"Corridor feature grid is missing: {GRID}")
    frame = pd.read_parquet(GRID)
    required = {"row", "col", "latitude_deg", "longitude_east_deg", "slope_deg",
                "roughness_3x3_range_m", "dune_hit"}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError("Pilot table is missing required routing fields: " + ", ".join(missing))
    if len(frame) < 2:
        raise ValueError(f"Expected a corridor grid with at least 2 cells; found {len(frame)}.")

    endpoints = {}
    for name in ("start", "end"):
        point = payload.get(name)
        if not isinstance(point, dict):
            raise ValueError(f"Provide {name} as {{lat, lon}}.")
        lat, lon = float(point["lat"]), float(point["lon"])
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError(f"{name} coordinates are outside valid latitude/longitude ranges.")
        # Keep the map demo honest: don't silently snap an arbitrary Mars location onto Jezero.
        if not (frame.latitude_deg.min() <= lat <= frame.latitude_deg.max()
                and frame.longitude_east_deg.min() <= lon <= frame.longitude_east_deg.max()):
            raise ValueError("Both endpoints must lie inside this saved corridor's coverage.")
        dists = frame.apply(lambda r: haversine_km(lat, lon, r.latitude_deg, r.longitude_east_deg), axis=1)
        ix = int(dists.idxmin())
        snap_km = float(dists.loc[ix])
        if snap_km > MAX_SNAP_KM:
            raise ValueError(f"{name} is {snap_km:.1f} km from the nearest corridor cell; maximum snap is {MAX_SNAP_KM:.0f} km.")
        endpoints[name] = {"index": ix, "snap_km": snap_km, "requested": {"lat": lat, "lon": lon}}

    # Connect adjacent cells in the saved raster window using row/column grid indices.
    rows = sorted(frame.row.unique())
    cols = sorted(frame.col.unique())
    row_pos = {v: i for i, v in enumerate(rows)}
    col_pos = {v: i for i, v in enumerate(cols)}
    lookup = {(int(r.row), int(r.col)): int(i) for i, r in frame.iterrows()}
    neighbors = [[] for _ in range(len(frame))]
    for i, cell in frame.iterrows():
        ri, ci = row_pos[cell.row], col_pos[cell.col]
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                other = lookup.get((int(rows[ri + dr]), int(cols[ci + dc]))) if 0 <= ri + dr < len(rows) and 0 <= ci + dc < len(cols) else None
                if other is None or int(frame.iloc[other].dune_hit) == 1:
                    continue
                a, b = frame.iloc[int(i)], frame.iloc[other]
                distance = haversine_km(a.latitude_deg, a.longitude_east_deg, b.latitude_deg, b.longitude_east_deg)
                edge_cost = distance * (1.0 + 1.5 * (risk(a) + risk(b)) / 2.0)
                neighbors[int(i)].append((other, distance, edge_cost))

    start_ix, end_ix = endpoints["start"]["index"], endpoints["end"]["index"]
    if int(frame.iloc[start_ix].dune_hit) == 1 or int(frame.iloc[end_ix].dune_hit) == 1:
        raise ValueError("A snapped endpoint lies inside a mapped dune polygon; choose a nearby clear point.")
    goal = frame.iloc[end_ix]
    queue = [(0.0, 0.0, start_ix)]
    previous = {start_ix: None}
    best = {start_ix: 0.0}
    while queue:
        _, cost, node = heapq.heappop(queue)
        if cost != best.get(node):
            continue
        if node == end_ix:
            break
        for nxt, distance, edge_cost in neighbors[node]:
            candidate = cost + edge_cost
            if candidate < best.get(nxt, math.inf):
                best[nxt] = candidate
                previous[nxt] = node
                cell = frame.iloc[nxt]
                heuristic = haversine_km(cell.latitude_deg, cell.longitude_east_deg,
                                         goal.latitude_deg, goal.longitude_east_deg)
                heapq.heappush(queue, (candidate + heuristic, candidate, nxt))
    if end_ix not in previous and end_ix != start_ix:
        raise ValueError("No connected path exists through the 20 pilot cells between these endpoints.")

    path = [end_ix]
    while path[-1] != start_ix:
        path.append(previous[path[-1]])
    path.reverse()
    cells = [frame.iloc[i] for i in path]
    points = [[float(c.longitude_east_deg), float(c.latitude_deg)] for c in cells]
    distance_km = sum(haversine_km(cells[i-1].latitude_deg, cells[i-1].longitude_east_deg,
                                   cells[i].latitude_deg, cells[i].longitude_east_deg)
                      for i in range(1, len(cells)))
    slopes = [float(c.slope_deg) for c in cells]
    roughness = [float(c.roughness_3x3_range_m) for c in cells]
    return {
        "status": "success",
        "planner": "A* over the local corridor feature grid",
        "mode": "balanced terrain proxy",
        "data_resolution_m": "about 1 km per cell in the source DEM",
        "endpoints": {
            "start": {"lat": float(frame.iloc[start_ix].latitude_deg), "lon": float(frame.iloc[start_ix].longitude_east_deg), "snap_distance_km": round(endpoints['start']['snap_km'], 2)},
            "end": {"lat": float(frame.iloc[end_ix].latitude_deg), "lon": float(frame.iloc[end_ix].longitude_east_deg), "snap_distance_km": round(endpoints['end']['snap_km'], 2)},
        },
        "route": {"type": "Feature", "properties": {"cost_model": "distance × (1 + 1.5 × mean terrain risk)"},
                  "geometry": {"type": "LineString", "coordinates": points}},
        "metrics": {"distance_km": round(distance_km, 2), "max_slope_deg": round(max(slopes), 2),
                    "mean_slope_deg": round(sum(slopes)/len(slopes), 2),
                    "max_roughness_3x3_range_m": round(max(roughness), 1), "route_cells": len(cells),
                    "grid_cells_total": len(frame), "weighted_cost_km_equivalent": round(best[end_ix], 2)},
        "limitations": [
            "This route is limited to the saved 2,128-cell corridor window near Gale Crater; it is not global coverage.",
            "The cost penalizes slope and 3x3 DEM roughness and avoids cells intersecting mapped dunes; weights are illustrative, not rover-calibrated.",
            "Thermal inertia and MCD climate are reported in the grid but are not treated as validated mobility hazards.",
            "Crater distance is zero for all cells in this corridor and cannot distinguish crater interiors from rim hazards, so it is excluded from route cost.",
            "No travel time, energy, slip probability, or safety probability is predicted.",
        ],
    }


def main():
    try:
        result = plan(json.load(sys.stdin))
    except Exception as exc:
        result = {"error": str(exc)}
        print(json.dumps(result))
        raise SystemExit(1)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
