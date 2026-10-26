"""Compare Jezero A* routes with the fused vision layer off and at several weights."""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import adaptive_route_planner as planner

START = {"lat": 18.506025, "lon": 77.339142}
END = {"lat": 18.500000, "lon": 77.502100}
WEIGHTS = (0.0, 0.05, 0.15, 0.25)
OUTPUT = planner.ROOT / "data/processed/vision_prototype/jezero_ctx/route_comparison_ctx.json"


def distance_m(a, b):
    return planner.mars_distance_km(a[1], a[0], b[1], b[0]) * 1000.0


def resample(coords, count=101):
    """Interpolate paths at equal distance fractions for a fair geometric comparison."""
    lengths = [distance_m(a, b) for a, b in zip(coords, coords[1:])]
    total = sum(lengths)
    if total <= 0 or len(coords) < 2:
        return [coords[0]] * count
    cumulative = [0.0]
    for length in lengths:
        cumulative.append(cumulative[-1] + length)
    points = []
    segment = 0
    for target in [total * i / (count - 1) for i in range(count)]:
        while segment < len(lengths) - 1 and cumulative[segment + 1] < target:
            segment += 1
        fraction = 0.0 if lengths[segment] == 0 else (target - cumulative[segment]) / lengths[segment]
        a, b = coords[segment], coords[segment + 1]
        delta_lon = (b[0] - a[0] + 180.0) % 360.0 - 180.0
        points.append([a[0] + fraction * delta_lon, a[1] + fraction * (b[1] - a[1])])
    return points


def main():
    results, features = [], []
    for weight in WEIGHTS:
        payload = {
            "start": START, "end": END, "mode": "balanced",
            "use_vision_model": weight > 0.0, "vision_weight": weight,
        }
        response = planner.plan(payload)
        if response.get("status") != "success":
            raise RuntimeError(response.get("error", f"route failed at vision weight {weight}"))
        if response.get("terrain_data", {}).get("instrument") != "CTX":
            raise RuntimeError("Comparison did not use the local Jezero CTX DTM.")
        coords = response["route"]["geometry"]["coordinates"]
        digest = hashlib.sha256(json.dumps(coords, separators=(",", ":")).encode()).hexdigest()[:16]
        results.append({
            "vision_weight": weight,
            "planner": response.get("planner"),
            "metrics": response.get("metrics"),
            "vision_model": response.get("vision_model"),
            "terrain_assessment": response.get("terrain_assessment"),
            "route_node_count": len(coords),
            "route_sha256_16": digest,
        })
        features.append({
            "type": "Feature",
            "properties": {
                "profile": "A* baseline" if weight == 0 else f"A* plus fused image/terrain model ({weight:.2f})",
                "vision_weight": weight,
                "distance_km": response["metrics"]["distance_km"],
            },
            "geometry": response["route"]["geometry"],
        })
    baseline = resample(features[0]["geometry"]["coordinates"])
    for result, feature in zip(results[1:], features[1:]):
        candidate = resample(feature["geometry"]["coordinates"])
        shifts = [distance_m(a, b) for a, b in zip(baseline, candidate)]
        result["path_shift_vs_baseline_m"] = {
            "mean": round(sum(shifts) / len(shifts), 2),
            "max": round(max(shifts), 2),
            "samples": len(shifts),
        }
        result["route_changed"] = result["route_sha256_16"] != results[0]["route_sha256_16"]
    document = {
        "status": "prototype_route_comparison",
        "case": {
            "region": "Jezero crater", "start": START, "end": END,
            "source": "locally cached CTX stereo DTM", "mode": "balanced",
        },
        "interpretation": (
            "This compares the same A* terrain grid with vision cost disabled and enabled. "
            "It tests integration and path sensitivity only. Labels are weak DTM proxies; "
            "route change does not prove improved hazard avoidance."
        ),
        "runs": results,
        "route_geojson": {"type": "FeatureCollection", "features": features},
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(document, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({
        "saved": str(OUTPUT), "case": document["case"],
        "runs": [{k: r.get(k) for k in ("vision_weight", "metrics", "vision_model", "route_node_count", "path_shift_vs_baseline_m", "route_changed")} for r in results],
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Jezero route comparison failed: {error}", file=sys.stderr)
        raise
