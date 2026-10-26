# Jezero CTX image and terrain prototype

This local prototype aligns the CTX orthorectified image with the approximately 20 m CTX stereo DTM. jezero_full_scene_features_20m.tif stores CTX intensity plus elevation, 3x3 least-squares plane slope, downslope aspect, plane-residual roughness, and 3x3 local relief. The trainer converts aspect to east/north sine-cosine channels and adds a validity mask.

## Model

train_jezero_fusion_model.py trains a compact dual-stream residual U-Net. One branch reads CTX intensity; the other reads aligned terrain geometry. Cross-modal gates fuse both branches at three scales. The model is sized for a 4 GB GPU and uses mixed precision when CUDA-enabled PyTorch is available.

Run from the repository root:

    python\mars_datasets\scripts\.venv\Scripts\python.exe python\mars_datasets\scripts\train_jezero_fusion_model.py --ablation

The ablation run uses the same spatially separated train, validation, and test blocks for fused, image-only, and terrain-only models. It saves held-out weak-label metrics in model/multimodal_metrics.json, a split manifest in model/spatial_split.csv, the fused checkpoint in model/jezero_multimodal_unet.pt, and a full-scene prediction raster in jezero_visual_hazard_probability_multimodal_experimental.tif.

## Route use and limits

The adaptive A* planner calculates deterministic slope, relief, and roughness costs from the DTM, adds a direction-aware cross-slope penalty from aspect, and optionally adds the model's soft hazard score. Dunes and crater proximity remain separate coarse semantic factors. The image model never hard-blocks a route.

The masks are weak labels made from terrain thresholds, not human-annotated image hazards. Since the inputs include the same geometry as the labeling rules, the model may learn the formula rather than identify visual hazards. There are no mapped dune positives in this scene, and the small spatial holdout does not establish generalization. Use the model to compare route sensitivity and guide label collection; do not interpret its scores as calibrated safety probabilities.
