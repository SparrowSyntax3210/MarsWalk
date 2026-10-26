# Python scripts

| Purpose | Scripts |
|---|---|
| Route planning | `adaptive_route_planner.py`, `global_tile_route_planner.py` |
| Global/grid feature generation | `build_global_tiles.py`, `build_route_grid.py`, `build_jezero_full_features.py` |
| Jezero vision prototype | `jezero_vision_prototype.py`, `train_jezero_vision_model.py`, `train_jezero_multimodal_vision.py`, `evaluate_jezero_vision_route.py`, `render_jezero_route_comparison.py` |
| Data preparation | `preprocess_stage1.py`, `preprocess_stage2.py`, `preprocess_tes_archive.py`, `preprocess_meda_sample.py`, `mcd_sampler.py`, `prepare_ai4mars.py`, `summarize_ai4mars_masks.py` |
| Catalogs and validation | `update_catalog_after_stage2.py`, `validate_nasa_traverse.py` |
| Downloads | `download_mcd_addons.py` |

Large source data required by some rebuild/preprocessing scripts has been removed from this working copy. Those scripts are retained as reproducible source code; fetch their source datasets again before using them. The route and Jezero vision scripts use the local inputs documented in the package README.
