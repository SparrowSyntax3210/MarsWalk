# Jezero vision and route prototype

This package covers the footprint of the cached Jezero CTX stereo DTM. It is not a complete mosaic of the entire Jezero region.

## Files

- `jezero_full_scene_features_20m.tif`: co-registered CTX image and local DTM features on the 20.16 m CTX grid. Bands are image DN, elevation, 3x3 slope, downslope aspect, plane-residual roughness, and 3x3 relief range.
- `jezero_context_1km.parquet`: 3,990 source rows with 43 fields from the global feature tile, kept at its nominal approximately 1 km scale. It includes geology, dune/crater distances, TES and MCD fields. These values are not measurements at 20 m.
- `jezero_visual_hazard_probability_multimodal_experimental.tif`: the U-Net probability raster consumed by the optional A* vision cost.
- `model/jezero_multimodal_unet.pt`, `model/multimodal_metrics.json`: checkpoint and evaluation report.
- `route_comparison_ctx.json`: baseline, 0.05-weight, and 0.25-weight A* outputs with GeoJSON routes.
- `route_comparison_ctx_warm.png`: warm-display route overlay on CTX imagery.

## Train and rerun

From PowerShell:

```powershell
cd C:\Users\Harsh Goel\Downloads\MarsWalk\python\mars_datasets\scripts
.\.venv\Scripts\python.exe build_jezero_full_features.py
.\.venv\Scripts\python.exe jezero_vision_prototype.py
.\.venv\Scripts\python.exe train_jezero_multimodal_vision.py
.\.venv\Scripts\python.exe evaluate_jezero_vision_route.py
.\.venv\Scripts\python.exe render_jezero_route_comparison.py
```

Training takes the six aligned raster bands and encodes aspect as east/north directional channels, producing seven model inputs. Training masks currently come from DTM slope and roughness thresholds; they are weak labels, not human-annotated image hazards.

## Current test

The route comparison starts at `18.506025, 77.339142` and ends at `18.500000, 77.502100`. The planner selects the cached CTX DTM and resamples it to approximately 30 m for A*. At vision weight 0.05, the route length remains 10.683 km; the path shifts an average 1.21 m and at most 30 m relative to A* without vision. The vision layer covers 64.6% of the search grid.

The model's held-out hazard-proxy recall is 59.5%; steep-slope recall is 0% on six spatial test patches. These are scores against DTM-derived proxy masks, not against rover outcomes or human visual labels. The run verifies data alignment and software integration; it does not establish route accuracy or NASA-route agreement.

A* remains the route engine. `use_vision_model: true` adds the probability raster as a soft cost; it does not hard-block a cell. The default is off. Geology, TES and MCD fields stay available as coarse context but are not calibrated mobility costs. The MCD values in this product represent one climatology scenario, not a live weather forecast.

The downloaded AI4Mars archive has rover-camera images and labels (including sand, rocks, and bedrock). Those images are ground-view and are not co-registered with this orbital CTX scene, so they cannot serve as pixel masks for the CTX route map. They may support a separate rover-camera perception model.

## What is needed for a stronger orbital vision model

Create human-reviewed masks on CTX/HiRISE imagery for at least traversable terrain, dune/sand, crater rim or steep scarps, boulder fields, and unknown. Keep entire geographic blocks out of training for validation. Then retrain and measure per-class precision/recall on those independent masks. Until those labels exist, keep vision weight low and preserve the deterministic DEM and mapped-vector checks in A*.
