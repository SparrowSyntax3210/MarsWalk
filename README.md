# MarsWalk

MarsWalk is a Mars surface map and route-planning prototype. The current route API combines an explainable A* cost planner with the best available terrain source for the selected area.

## What currently runs

- The frontend displays Mars imagery and lets a user choose route endpoints.
- `POST /api/route` prefers a cached or catalogued local HiRISE/CTX stereo DTM. When no suitable local DTM is available, it uses the local global 10-degree Parquet terrain grid.
- The Jezero prototype uses an image/terrain gated-fusion model on one CTX scene. It can add an optional soft A* cost, while A* separately scores DTM elevation, slope, roughness, downslope aspect, and available coarse dune/crater factors. The model is trained on weak terrain-derived labels and is not a validated rover safety classifier.
- `GET /api/route/status` reports how many catalogued Parquet tiles are present on this machine.

The planners return route geometry, costs, and terrain metrics. They do not currently predict validated travel time, energy, wheel slip, radiation dose, or survival probability.

## Jezero vision and route review

The route planner and Jezero vision experiment are kept as one optional prototype. The normal route still works from terrain data alone; within the Jezero CTX/DTM footprint, `use_vision_model` can add the experimental model as a soft cost. The model is trained from terrain-derived weak labels, so its output is a comparison signal rather than verified hazard truth.

While the app is running, open `/vision-review.html` (or select **Jezero visual review** in the sidebar). Draw polygons for visually identified hazards, visually clear ground, or uncertain areas, then save or export the annotations. The page intentionally does not display model predictions. The review API stores saved labels at `python/mars_datasets/data/processed/vision_prototype/jezero_ctx/human_labels/jezero_visual_review.geojson`; use `python/mars_datasets/scripts/evaluate_jezero_human_labels.py` to compare reviewed areas with the model and terrain-only baseline. Evaluation requires human-marked hazard and clear polygons; no human labels or validation scores are included by default.

The route comparison and its inputs are grouped under `python/mars_datasets/data/processed/vision_prototype/jezero_ctx/`. The review page assets are under `frontend/public/vision-review.html`, `frontend/public/js/vision-review.js`, `frontend/public/css/vision-review.css`, and `frontend/public/data/vision-review/`.

## Mission Planner

Choose **Mission Planner** in the sidebar to enter endpoints, select robotic or crewed planning assumptions, set slope/distance/schedule/energy limits, and compare safest, balanced, and fastest A* routes. Mission duration and energy are calculated from the entered average speed, driving hours per sol, and energy per kilometre. Crew oxygen is an editable allowance estimate. The planner flags route metrics that exceed entered limits, lets you switch among successful route options on the map, and can export a JSON or print report. The custom-traverse panel accepts a GeoJSON LineString and samples up to 20 locations from the global MDEM point API; it is coarse screening, not a high-resolution hazard audit. Radiation, wheel slip, power variation, daylight/season windows, and certified life-support estimates are not modeled.

## Run locally

1. Install Node dependencies with `npm install`.
2. Create `.env` from `.env.example` if you need to change the host or port.
3. Start the app with `npm start`.
4. The route API uses `python/mars_datasets/scripts/.venv/Scripts/python.exe` when it exists. Create that environment and install `requirements-route.txt` there if needed. Install `requirements-vision.txt` for model training.

The local Python environment and downloaded data are intentionally excluded from Git.

## Data layout

See [`python/mars_datasets/README.md`](python/mars_datasets/README.md) for the data inventory, route selection flow, scripts, and local-data requirements. Small source catalogs and schemas live in `python/mars_datasets/data/catalog/`; the 648 global Parquet tiles, local stereo DTMs, and Jezero raster artifacts remain local because they are large.

A clone of this repository contains the code and catalogs, but cannot calculate routes until the local Parquet tiles are copied into `python/mars_datasets/data/processed/feature_store/global_tiles/10deg/`. Jezero stereo DTM and optional vision behavior also require the corresponding local files described in the package README.
