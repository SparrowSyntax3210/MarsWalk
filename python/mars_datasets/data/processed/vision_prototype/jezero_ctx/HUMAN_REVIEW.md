# Jezero visual review protocol

Open /vision-review.html in the local MarsWalk app. This page displays the warm-tone CTX orthomosaic with no model predictions, terrain masks, or weak-label overlays. Draw polygons for loose sand/dune-like deposits, dense rock fields, crater rims or scarps, other visible hazards, visually clear surface, or uncertain areas. Use the note field when a class needs context.

The browser saves GeoJSON locally through /api/vision-review/labels to data/processed/vision_prototype/jezero_ctx/human_labels/jezero_visual_review.geojson. It can also download a GeoJSON copy. Labels are not sent to an external service.

Once the annotations include both hazard and visually-clear polygons, run from the MarsWalk repository root:

    python\mars_datasets\scripts\.venv\Scripts\python.exe python\mars_datasets\scripts\evaluate_jezero_human_labels.py

The evaluator compares the model hazard score at threshold 0.5 and across descriptive thresholds with a terrain-only baseline matching the weak-label rule (slope >= 15 degrees or 3x3 elevation range >= 8 metres). It scores only reviewed polygons, excludes uncertain and conflicting pixels, and saves model/human_label_evaluation.json.

Annotate without looking at the model output or weak terrain mask. This reduces direct visual confirmation bias, but a small manually drawn set is still exploratory review, not an independently certified safety dataset. Reserve separated parts of the scene as a final holdout; do not tune and report a best threshold on the same polygons.