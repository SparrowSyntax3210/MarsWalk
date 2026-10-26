# MarsWalk data and Python planners

This folder contains the Python route planners, data catalogs, local route data, and the Jezero vision prototype.

## Folder layout

```text
python/mars_datasets/
├── config/                         # Planner and dataset configuration
├── docs/                           # Project and route-planning references
├── data/
│   ├── catalog/                    # Small tracked CSV/JSON inventories and lookup tables
│   ├── raw/
│   │   ├── dem/local_dtms/         # Local Jezero CTX and HiRISE stereo DTMs
│   │   ├── imagery/                # Jezero CTX source scene
│   │   └── route_validation/       # Small Curiosity traverse validation sample
│   └── processed/
│       ├── feature_store/global_tiles/10deg/  # 648 local global-route Parquet tiles
│       └── vision_prototype/jezero_ctx/       # Jezero model inputs, patches, metrics, outputs
└── scripts/                        # Route, preprocessing, vision, and validation code
```

`data/raw` and large parts of `data/processed` are local-only and ignored by Git. Keep a backup of `feature_store/global_tiles/10deg/` if you need offline global routing; the repository contains the tile catalog, but not the 25+ GB Parquet payloads.

## Route request flow

1. The backend starts `scripts/adaptive_route_planner.py`.
2. It looks for a local stereo DTM covering the requested route, using `data/catalog/local_dtm_products.json` and files under `data/raw/dem/local_dtms/`.
3. If a local DTM is unavailable or cannot support the requested corridor, it calls `scripts/global_tile_route_planner.py`, which reads only the relevant local Parquet tile(s) and runs A* on their grid.
4. If `use_vision_model` is enabled and the route lies within the Jezero raster footprint, the planner may add the experimental probability surface as a low-weight cost. Outside that one scene, global Parquet routes remain terrain-only.

The global grid has nominal approximately 1 km cells; the local CTX DTM is about 20 m posting and the local HiRISE DTM is about 1 m posting. Posting is not the same as guaranteed hazard-detection resolution. The Jezero model currently uses weak DTM-derived labels and should remain an optional experiment until better labels and evaluation are available.

## Data kept locally

- `data/processed/feature_store/global_tiles/10deg/`: global route grid; required for the fallback planner.
- `data/raw/dem/local_dtms/`: cached stereo terrain; required for offline high-resolution Jezero routes.
- `data/catalog/local_dtm_products.json`: local DTM footprint and file catalog.
- `data/processed/vision_prototype/jezero_ctx/jezero_full_scene_features_20m.tif`: multimodal training/inference stack.
- `data/processed/vision_prototype/jezero_ctx/images/` and `masks/`: compact model patches and labels.
- `data/processed/vision_prototype/jezero_ctx/model/`: small baseline weights, metrics, and training normalization ranges.
- `data/processed/vision_prototype/jezero_ctx/jezero_visual_hazard_probability_multimodal_experimental.tif`: optional raster read by the adaptive planner.
- `data/raw/imagery/`: CTX source imagery; retained for provenance and future patch regeneration.

Raw AI4Mars, global MOLA/HRSC source DEM, MCD archives, dune/geology/crater/TES source copies, and their large intermediate rasters/vectors have been removed from this working copy. Their small source catalogs remain under `data/catalog/`. These source inputs can be downloaded again if the global tile-generation pipeline needs to be rebuilt.

## Script guide

- Routing: `adaptive_route_planner.py`, `global_tile_route_planner.py`
- Global feature preparation: `build_global_tiles.py`, `build_route_grid.py`, `build_jezero_full_features.py`
- Jezero vision: `jezero_vision_prototype.py`, `train_jezero_vision_model.py`, `train_jezero_multimodal_vision.py`, `evaluate_jezero_vision_route.py`, `render_jezero_route_comparison.py`
- Data preparation: `preprocess_stage1.py`, `preprocess_stage2.py`, `preprocess_tes_archive.py`, `preprocess_meda_sample.py`, `mcd_sampler.py`, `prepare_ai4mars.py`, `summarize_ai4mars_masks.py`
- Validation and catalogs: `validate_nasa_traverse.py`, `update_catalog_after_stage2.py`
- Source downloads: `download_mcd_addons.py`

The scripts remain together because they share package-relative paths and generated artifacts. `scripts/README.md` records their current inputs and outputs.

## Local setup

The backend automatically selects `scripts/.venv/Scripts/python.exe` when present. From the repository root:

```powershell
python -m venv python/mars_datasets/scripts/.venv
python/mars_datasets/scripts/.venv/Scripts/python.exe -m pip install -r python/mars_datasets/scripts/requirements-route.txt
```

For Jezero model work, install the extra dependencies from `requirements-vision.txt` into that environment. The repository does not contain the global Parquet tiles or the large Jezero raster stack, so copying the local data backup is required for the matching feature to run.
