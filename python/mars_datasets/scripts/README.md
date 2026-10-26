# Python scripts

| Purpose | Scripts |
|---|---|
| Route planning | adaptive_route_planner.py, global_tile_route_planner.py |
| Global/grid feature generation | build_global_tiles.py, build_route_grid.py, build_jezero_full_features.py |
| Jezero vision | jezero_vision_prototype.py, train_jezero_fusion_model.py, train_jezero_vision_model.py, train_jezero_multimodal_vision.py, evaluate_jezero_vision_route.py, render_jezero_route_comparison.py, evaluate_jezero_human_labels.py |
| Data preparation | preprocess_stage1.py, preprocess_stage2.py, preprocess_tes_archive.py, preprocess_meda_sample.py, mcd_sampler.py, prepare_ai4mars.py, summarize_ai4mars_masks.py |
| Validation and catalogs | validate_nasa_traverse.py, update_catalog_after_stage2.py |
| Source downloads | download_mcd_addons.py |

Run train_jezero_fusion_model.py --ablation to train the fused, image-only, and terrain-only variants on an identical spatial holdout. The script writes a full-scene proxy-probability raster for local A* use and saves comparisons in the model metrics report. These remain weak-label experiments, not independently validated hazard predictions.

Large source data needed by some rebuild/preprocessing scripts has been removed from this working copy. Those scripts remain as reproducible source code; download the corresponding inputs again before rebuilding the data products.

`evaluate_jezero_human_labels.py` reads the independent polygons saved by `/api/vision-review/labels` and compares hazard/clear regions against the multimodal output and a terrain-only threshold baseline. It stops with a clear message until both hazard and clear-ground areas have been labeled. Review instructions and known limitations are in `../data/processed/vision_prototype/jezero_ctx/HUMAN_REVIEW.md`.
