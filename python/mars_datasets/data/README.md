# Data inventory

Small CSV/JSON catalogs in `catalog/` are source metadata and are tracked in Git. Large source and derived science products remain on this machine and are ignored.

- `raw/dem/local_dtms/`: cached local Jezero CTX and HiRISE stereo elevation products.
- `raw/imagery/`: local CTX image source for the Jezero prototype.
- `raw/route_validation/`: small Curiosity traverse reference used by the validation script.
- `processed/feature_store/global_tiles/10deg/`: the 648 global terrain Parquet tiles used by global A* routing.
- `processed/vectors/routing_layers.gpkg`: local mapped dune layers used when regenerating Jezero weak-label patches.
- `processed/vision_prototype/jezero_ctx/`: local multimodal raster, compact train patches, experimental output raster, and model artifacts.

The tile catalog describes 648 globally indexed tile products. Each checkout reports only the tiles physically present under `feature_store/global_tiles/10deg/` as locally available.
