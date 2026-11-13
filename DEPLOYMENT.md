# MarsWalk website deployment

The website is a static frontend on Vercel. A small Node/Python service on Render serves the same pages and provides `/api/*`. The Vercel rewrite sends browser API requests to Render, so the site uses one origin. Keep the Render service name `marswalk-api` to match `vercel.json`; if Render assigns a different hostname, update that rewrite destination.

## Included for this first hosted release

- Six regional A* route grids: Jezero, Gale, Olympus Mons, Valles Marineris, Hellas Planitia, and Elysium Planitia. The compact package is under 10 MB, derived from the local Mars global elevation grid, and uses nominal approximately 1 km cells.
- Route requests are limited to endpoints inside the same supported region and to 100 km per request. These are exploratory terrain-cost routes, not rover-safety certification.
- Ruby text/data endpoints and the map's public NASA/USGS data lookups.
- Jezero 3D preview asset used by the website.

The 25+ GB all-Mars tile store, raw imagery/DTMs, Unity project, and Ruby's local voice model are not part of the hosted release. The `/api/ruby/speak` endpoint remains a local voice-server integration and will report unavailable on Render until hosted speech is added. Ruby text answers and route narration do not require that voice model. An OpenRouter API key is optional; without one, Ruby still uses the built-in Mars facts and retrieved map data.

## Deploy Render first

1. In Render, create a Blueprint from this GitHub repository and select `render.yaml`.
2. Wait for `https://marswalk-api.onrender.com/api/health` to return `{"status":"ok"}`.
3. Check `/api/route/status`. It should report `complete` and list six regions.
4. Optional: set `OPENROUTER_API_KEY` in the Render service environment to enable Ruby's general AI answers. Keep the key in Render's secret environment settings, never in Git or Vercel.

The free Render web service can sleep when idle and then take time to wake. That affects the first request after inactivity. For always-on response times, choose a paid instance later.

## Deploy Vercel

1. Import the same GitHub repository into Vercel, using the repository root as the project root.
2. Keep the included `vercel.json`; it selects the **Other** preset, skips frontend package installation/building, publishes `frontend/public`, and forwards `/api/*` to Render.
3. Deploy, then open the Vercel URL and check Ruby text, map data, and route status.

If the Render hostname differs from `marswalk-api.onrender.com`, replace the host in `vercel.json` and push that small change. The frontend remains a static site; route planning and Ruby text run on Render.

## Local run

```sh
npm ci
python -m pip install -r python/mars_datasets/scripts/requirements-hosted-route.txt
npm start
```

The route grids can be regenerated from the ignored local 10-degree Parquet store with:

```sh
python python/mars_datasets/scripts/build_hosted_region_tiles.py
```
