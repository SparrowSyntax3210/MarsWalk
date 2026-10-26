# MarsWalk

MarsWalk is a Mars surface map and route-planning prototype. The current route API combines an explainable A* cost planner with the best available terrain source for the selected area.

## What currently runs

- The frontend displays Mars imagery and lets a user choose route endpoints.
- `POST /api/route` prefers a cached or catalogued local HiRISE/CTX stereo DTM. When no suitable local DTM is available, it uses the local global 10-degree Parquet terrain grid.
- The Jezero vision prototype can optionally add a small visual-hazard cost to a route within its single CTX scene. It is experimental and trained against weak terrain-derived labels; it is not a validated rover safety classifier.
- `GET /api/route/status` reports how many catalogued Parquet tiles are present on this machine.

The planners return route geometry, costs, and terrain metrics. They do not currently predict validated travel time, energy, wheel slip, radiation dose, or survival probability.

## Run locally

1. Install Node dependencies with `npm install`.
2. Create `.env` from `.env.example` if you need to change the host or port.
3. Start the app with `npm start`.
4. The route API uses `python/mars_datasets/scripts/.venv/Scripts/python.exe` when it exists. Create that environment and install `requirements-route.txt` there if needed. Install `requirements-vision.txt` for model training.

The local Python environment and downloaded data are intentionally excluded from Git.

## Data layout

See [`python/mars_datasets/README.md`](python/mars_datasets/README.md) for the data inventory, route selection flow, scripts, and local-data requirements. Small source catalogs and schemas live in `python/mars_datasets/data/catalog/`; the 648 global Parquet tiles, local stereo DTMs, and Jezero raster artifacts remain local because they are large.

A clone of this repository contains the code and catalogs, but cannot calculate routes until the local Parquet tiles are copied into `python/mars_datasets/data/processed/feature_store/global_tiles/10deg/`. Jezero stereo DTM and optional vision behavior also require the corresponding local files described in the package README.
