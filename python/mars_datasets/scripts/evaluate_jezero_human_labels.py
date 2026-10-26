"""Compare Jezero model scores and terrain-only thresholds with visual-review polygons.

The review GeoJSON is created in the browser without model or weak-label overlays.
Metrics describe reviewed pixels only and are not rover-safety certification.
"""
from __future__ import annotations
import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from shapely.geometry import shape
from shapely.ops import transform as transform_geometry

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
DEFAULT_DATA = ROOT / "data/processed/vision_prototype/jezero_ctx"
LABEL_PATH = DEFAULT_DATA / "human_labels/jezero_visual_review.geojson"
PREDICTION_PATH = DEFAULT_DATA / "jezero_visual_hazard_probability_multimodal_experimental.tif"
STACK_PATH = DEFAULT_DATA / "jezero_full_scene_features_20m.tif"
MARS_RADIUS_M = 3_396_190.0
HAZARD_LABELS = {"loose_sand", "rock_field", "crater_rim", "other_hazard"}
CLEAR_LABEL = "visually_clear"
UNCERTAIN_LABEL = "uncertain"


def project_lonlat_geometry(geometry):
    def project(x, y, z=None):
        east = MARS_RADIUS_M * math.radians(x)
        north = MARS_RADIUS_M * math.radians(y)
        return (east, north) if z is None else (east, north, z)
    return transform_geometry(project, geometry)


def metric_report(truth, probability, terrain_baseline, threshold=0.5):
    prediction = probability >= threshold
    tp = int(np.count_nonzero(prediction & truth))
    fp = int(np.count_nonzero(prediction & ~truth))
    fn = int(np.count_nonzero(~prediction & truth))
    tn = int(np.count_nonzero(~prediction & ~truth))
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f2 = 5 * precision * recall / max(1e-12, 4 * precision + recall)
    return {
        "threshold": threshold,
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / max(1e-12, precision + recall),
        "f2": f2,
        "iou": tp / max(1, tp + fp + fn),
        "specificity": tn / max(1, tn + fp),
        "brier_score": float(np.mean((probability.astype(np.float64) - truth.astype(np.float64)) ** 2)),
        "confusion": {"true_positive": tp, "false_positive": fp, "false_negative": fn, "true_negative": tn},
        "terrain_threshold_baseline": {
            "precision": int(np.count_nonzero(terrain_baseline & truth)) / max(1, int(np.count_nonzero(terrain_baseline))),
            "recall": int(np.count_nonzero(terrain_baseline & truth)) / max(1, int(np.count_nonzero(truth))),
            "predicted_hazard_pixels": int(np.count_nonzero(terrain_baseline)),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=LABEL_PATH)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--threshold", type=float, default=0.5)
    args = parser.parse_args()
    label_path = args.labels
    prediction_path = args.data / PREDICTION_PATH.name
    stack_path = args.data / STACK_PATH.name
    if not label_path.is_file():
        raise FileNotFoundError(
            f"No review set found at {label_path}. Draw and save visual-review polygons at /vision-review.html first."
        )
    if not prediction_path.is_file() or not stack_path.is_file():
        raise FileNotFoundError("The Jezero model prediction raster or aligned feature stack is missing.")
    if not 0.0 <= args.threshold <= 1.0:
        parser.error("--threshold must be between 0 and 1.")
    collection = json.loads(label_path.read_text(encoding="utf-8"))
    features = collection.get("features", [])
    if not features:
        raise ValueError("The saved visual-review set contains no polygons.")
    grouped = Counter((f.get("properties") or {}).get("label", "unknown") for f in features)
    hazard_shapes, clear_shapes, uncertain_shapes = [], [], []
    for feature in features:
        label = (feature.get("properties") or {}).get("label")
        geometry = feature.get("geometry")
        if not geometry:
            continue
        projected = project_lonlat_geometry(shape(geometry))
        if label in HAZARD_LABELS:
            hazard_shapes.append(projected)
        elif label == CLEAR_LABEL:
            clear_shapes.append(projected)
        elif label == UNCERTAIN_LABEL:
            uncertain_shapes.append(projected)
    if not hazard_shapes or not clear_shapes:
        raise ValueError("Add at least one hazard polygon and one visually-clear polygon before evaluation.")

    with rasterio.open(stack_path) as stack, rasterio.open(prediction_path) as prediction:
        if (stack.width, stack.height) != (prediction.width, prediction.height):
            raise ValueError("The prediction raster and feature stack do not share a pixel grid.")
        out_shape = (stack.height, stack.width)
        transform = stack.transform
        hazard_mask = rasterize(((geom, 1) for geom in hazard_shapes), out_shape=out_shape, transform=transform,
                                fill=0, all_touched=False, dtype="uint8").astype(bool)
        clear_mask = rasterize(((geom, 1) for geom in clear_shapes), out_shape=out_shape, transform=transform,
                               fill=0, all_touched=False, dtype="uint8").astype(bool)
        uncertain_mask = rasterize(((geom, 1) for geom in uncertain_shapes), out_shape=out_shape, transform=transform,
                                   fill=0, all_touched=False, dtype="uint8").astype(bool) if uncertain_shapes else np.zeros(out_shape, dtype=bool)
        conflicts = hazard_mask & clear_mask
        reviewed = (hazard_mask | clear_mask) & ~uncertain_mask & ~conflicts
        probability = prediction.read(4, masked=True).filled(np.nan).astype(np.float32)
        slope = stack.read(3, masked=True).filled(np.nan).astype(np.float32)
        roughness_range = stack.read(6, masked=True).filled(np.nan).astype(np.float32)
    valid = reviewed & np.isfinite(probability) & (probability >= 0.0) & (probability <= 1.0)
    if not np.any(valid):
        raise ValueError("No labeled pixels overlap the CTX scene and the model prediction coverage.")
    truth = hazard_mask[valid]
    scores = probability[valid]
    terrain_baseline = (slope[valid] >= 15.0) | (roughness_range[valid] >= 8.0)
    result = {
        "status": "human_visual_review_comparison",
        "review_metadata": collection.get("metadata", {}),
        "label_file": str(label_path),
        "feature_counts_by_label": dict(grouped),
        "evaluated_pixels": int(valid.sum()),
        "human_hazard_pixels": int(np.count_nonzero(truth)),
        "human_clear_pixels": int(truth.size - np.count_nonzero(truth)),
        "excluded_conflicting_pixels": int(np.count_nonzero(conflicts)),
        "excluded_uncertain_pixels": int(np.count_nonzero(uncertain_mask)),
        "model": {
            "name": "Jezero dual-stream CTX/terrain U-Net",
            "threshold_metrics": metric_report(truth, scores, terrain_baseline, args.threshold),
            "threshold_sweep": [
                {"threshold": round(float(t), 2), "metrics": metric_report(truth, scores, terrain_baseline, float(t))}
                for t in np.arange(0.1, 1.0, 0.1)
            ],
        },
        "interpretation": [
            "Only hand-drawn, explicitly reviewed polygons are evaluated; model and weak-label overlays are not inputs to this scoring script.",
            "The terrain-only comparator is the original weak-label rule: slope at least 15 degrees or 3x3 elevation range at least 8 metres.",
            "Polygons are coarse human interpretations at CTX scale; this is an exploratory review set, not ground truth or a rover-certified safety assessment.",
            "The displayed threshold sweep is descriptive; do not select and report a best threshold on these same pixels as an unbiased test result.",
        ],
    }
    output = args.data / "model" / "human_label_evaluation.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({
        "saved": str(output),
        "features_by_label": result["feature_counts_by_label"],
        "evaluated_pixels": result["evaluated_pixels"],
        "model_at_threshold": result["model"]["threshold_metrics"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Jezero human-label evaluation failed: {error}", file=sys.stderr)
        raise