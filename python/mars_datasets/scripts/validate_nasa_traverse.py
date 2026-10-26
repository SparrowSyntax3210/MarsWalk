"""Compare adaptive A* routes with NASA's published Curiosity traverse line.

The rover's driven path is a reference trajectory, not a ground-truth optimal
route. This reports path length and geometric deviation for inspection.
"""
from __future__ import annotations

import argparse
import json
import math
import urllib.request
from pathlib import Path

import numpy as np

import adaptive_route_planner

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "raw" / "route_validation" / "nasa_curiosity_traverse.geojson"
NASA_URL = (
    "https://trek.nasa.gov/mars/trekarcgis/rest/services/curiosity_path/"
    "MapServer/0/query?where=1%3D1&outFields=%2A&returnGeometry=true&f=geojson"
)
MARS_RADIUS_M = 3_389_500.0


def load_track(refresh: bool = False):
    if refresh or not CACHE.is_file():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(NASA_URL, headers={"User-Agent": "MarsWalk-route-validation/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            document = json.loads(response.read().decode("utf-8"))
        temporary = CACHE.with_suffix(".tmp")
        temporary.write_text(json.dumps(document), encoding="utf-8")
        temporary.replace(CACHE)
    else:
        document = json.loads(CACHE.read_text(encoding="utf-8"))

    features = document.get("features", [])
    if not features:
        raise ValueError("NASA's Curiosity traverse service returned no features.")
    geometry = features[0].get("geometry", {})
    if geometry.get("type") != "LineString":
        raise ValueError("Expected NASA's Curiosity traverse to be a GeoJSON LineString.")
    coordinates = np.asarray(geometry.get("coordinates", []), dtype=np.float64)
    if coordinates.ndim != 2 or coordinates.shape[0] < 2 or coordinates.shape[1] < 2:
        raise ValueError("NASA's Curiosity traverse contains too few coordinates.")
    return coordinates[:, :2]


def mars_distance_m(a, b):
    lon1, lat1 = map(math.radians, (float(a[0]), float(a[1])))
    lon2, lat2 = map(math.radians, (float(b[0]), float(b[1])))
    dlat = lat2 - lat1
    dlon = (lon2 - lon1 + math.pi) % (2.0 * math.pi) - math.pi
    haversine = math.sin(dlat / 2.0) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0) ** 2
    return 2.0 * MARS_RADIUS_M * math.asin(min(1.0, math.sqrt(haversine)))


def project_local(coordinates, lat0, lon0):
    coordinates = np.asarray(coordinates, dtype=np.float64)
    x = np.radians(coordinates[:, 0] - lon0) * MARS_RADIUS_M * math.cos(math.radians(lat0))
    y = np.radians(coordinates[:, 1] - lat0) * MARS_RADIUS_M
    return np.column_stack((x, y))


def point_to_polyline_distances(points, line):
    if len(line) == 1:
        return np.linalg.norm(points - line[0], axis=1)
    starts = line[:-1]
    vectors = line[1:] - starts
    lengths_squared = np.sum(vectors * vectors, axis=1)
    lengths_squared[lengths_squared == 0] = 1.0
    result = np.empty(len(points), dtype=np.float64)
    for index, point in enumerate(points):
        relative = point - starts
        fraction = np.clip(np.sum(relative * vectors, axis=1) / lengths_squared, 0.0, 1.0)
        nearest = starts + fraction[:, None] * vectors
        result[index] = float(np.min(np.linalg.norm(nearest - point, axis=1)))
    return result


def choose_chainage_indices(track, target_distances_km):
    step_m = np.asarray([mars_distance_m(a, b) for a, b in zip(track, track[1:])])
    cumulative_m = np.concatenate(([0.0], np.cumsum(step_m)))
    indices = {}
    for target_km in target_distances_km:
        target_m = target_km * 1000.0
        if target_m >= cumulative_m[-1]:
            index = len(track) - 1
        else:
            index = int(np.searchsorted(cumulative_m, target_m, side="left"))
        if index > 0:
            indices[target_km] = (index, float(cumulative_m[index] / 1000.0))
    return indices, float(cumulative_m[-1] / 1000.0)


def compare_segment(track_segment, plan_result):
    actual_length_km = sum(mars_distance_m(a, b) for a, b in zip(track_segment, track_segment[1:])) / 1000.0
    route_coordinates = plan_result["route"]["geometry"]["coordinates"]
    route_length_km = float(plan_result["metrics"]["distance_km"])
    lat0 = float(np.mean(track_segment[:, 1]))
    lon0 = float(np.mean(track_segment[:, 0]))
    actual_xy = project_local(track_segment, lat0, lon0)
    route_xy = project_local(route_coordinates, lat0, lon0)
    route_to_actual = point_to_polyline_distances(route_xy, actual_xy)
    actual_to_route = point_to_polyline_distances(actual_xy, route_xy)
    return {
        "actual_driven_distance_km": round(actual_length_km, 3),
        "planner_distance_km": round(route_length_km, 3),
        "planner_over_actual_length_ratio": round(route_length_km / actual_length_km, 3) if actual_length_km else None,
        "planner_to_nasa_track_cross_track_m": {
            "mean": round(float(np.mean(route_to_actual)), 1),
            "p95": round(float(np.percentile(route_to_actual, 95)), 1),
            "max": round(float(np.max(route_to_actual)), 1),
        },
        "nasa_track_to_planner_cross_track_m": {
            "mean": round(float(np.mean(actual_to_route)), 1),
            "p95": round(float(np.percentile(actual_to_route, 95)), 1),
            "max": round(float(np.max(actual_to_route)), 1),
        },
        "planner_cells": plan_result["metrics"]["route_cells"],
        "terrain_data": plan_result.get("terrain_data"),
        "endpoint_snaps_km": {
            "start": plan_result["endpoints"]["start"]["snap_distance_km"],
            "end": plan_result["endpoints"]["end"]["snap_distance_km"],
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--distances-km", nargs="+", type=float, default=[1.0, 5.0, 10.0, 15.0])
    parser.add_argument("--mode", choices=("fastest", "balanced", "safest"), default="balanced")
    parser.add_argument("--refresh", action="store_true", help="Download the latest traverse geometry from NASA Trek.")
    args = parser.parse_args()

    track = load_track(args.refresh)
    cases, total_km = choose_chainage_indices(track, args.distances_km)
    reports = []
    for target_km, (end_index, chainage_km) in cases.items():
        segment = track[:end_index + 1]
        payload = {
            "start": {"lat": float(segment[0, 1]), "lon": float(segment[0, 0])},
            "end": {"lat": float(segment[-1, 1]), "lon": float(segment[-1, 0])},
            "mode": args.mode,
        }
        case = {"target_chainage_km": target_km, "actual_chainage_km": round(chainage_km, 3), **payload}
        try:
            plan_result = adaptive_route_planner.plan(payload)
            case.update(compare_segment(segment, plan_result))
        except Exception as error:
            case["error"] = str(error)
        reports.append(case)

    print(json.dumps({
        "reference": "NASA Trek Curiosity traverse polyline, feature ID 0",
        "reference_url": NASA_URL,
        "reference_vertices": int(len(track)),
        "reference_total_distance_km": round(total_km, 3),
        "reference_is_rover_driven_track_not_an_optimal_route": True,
        "mode": args.mode,
        "cases": reports,
        "interpretation": "Compare length and cross-track distance as sanity checks. A driven traverse includes science stops, tactical constraints, and local hazards, so identical paths are not expected.",
    }, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
