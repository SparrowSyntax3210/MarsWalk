"""Adaptive local stereo-DTM and global Parquet route planning.

Prefer a cached or catalogued HiRISE/CTX stereo DTM when it covers the route.
Use the global 10-degree Parquet A* grid when local stereo coverage is absent
or rejects an endpoint; this fallback has nominal approximately 1 km cells.
"""
from __future__ import annotations

import heapq
import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from rasterio.warp import reproject
from scipy.spatial import cKDTree

import global_tile_route_planner as global_planner

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "raw" / "dem" / "local_dtms"
DTM_CATALOG = ROOT / "data" / "catalog" / "local_dtm_products.json"
VISION_HAZARD_RASTER = ROOT / "data" / "processed" / "vision_prototype" / "jezero_ctx" / "jezero_visual_hazard_probability_multimodal_experimental.tif"
VISION_MODEL_METRICS = ROOT / "data" / "processed" / "vision_prototype" / "jezero_ctx" / "model" / "multimodal_metrics.json"
MARS_RADIUS_M = 3_396_190.0
STAC_ROOT = "https://stac.astrogeology.usgs.gov/api"
COLLECTIONS = (
    ("mro_hirise_socet_dtms", "HiRISE"),
    ("mro_ctx_controlled_usgs_dtms", "CTX"),
)
MAX_LOCAL_ROUTE_KM = 100.0
MAX_LOCAL_SNAP_M = 500.0
MAX_CORRIDOR_MARGIN_M = 20_000.0
MIN_CORRIDOR_MARGIN_M = 10_000.0
CRATER_AVOID_BUFFER_KM = 0.5
MAX_GRID_CELLS = 2_500_000


class LocalDTMSourceError(Exception):
    """A remote/local DTM could not be opened or did not cover the requested window."""


MODE_SETTINGS = {
    "fastest": {"risk_weight": 0.35, "max_slope_deg": 25.0},
    "balanced": {"risk_weight": 1.5, "max_slope_deg": 20.0},
    "safest": {"risk_weight": 3.0, "max_slope_deg": 15.0},
}


def mars_distance_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians((lon2 - lon1 + 180.0) % 360.0 - 180.0)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * MARS_RADIUS_M * math.asin(min(1.0, math.sqrt(h))) / 1000.0


def lonlat_to_xy(lon, lat, x_scale=1.0):
    return (
        MARS_RADIUS_M * math.radians(lon) * x_scale,
        MARS_RADIUS_M * math.radians(lat),
    )


def validate_route(payload):
    start = global_planner.validate_point(payload.get("start"), "start")
    end = global_planner.validate_point(payload.get("end"), "end")
    distance = mars_distance_km(*start, *end)
    if distance < 0.01:
        raise ValueError("Start and end must be at least 10 metres apart.")
    return start, end, distance


def corridor_bbox(start, end, distance_km):
    if abs(start[1] - end[1]) > 180.0:
        return None
    mean_lat = (start[0] + end[0]) / 2.0
    margin_m = min(MAX_CORRIDOR_MARGIN_M, max(MIN_CORRIDOR_MARGIN_M, distance_km * 250.0))
    lat_margin = math.degrees(margin_m / MARS_RADIUS_M)
    cos_lat = max(0.05, abs(math.cos(math.radians(mean_lat))))
    lon_margin = math.degrees(margin_m / (MARS_RADIUS_M * cos_lat))
    west = min(start[1], end[1]) - lon_margin
    east = max(start[1], end[1]) + lon_margin
    south = max(-89.9, min(start[0], end[0]) - lat_margin)
    north = min(89.9, max(start[0], end[0]) + lat_margin)
    if west < -180 or east > 180:
        return None
    return west, south, east, north, margin_m


def stac_get(url):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/geo+json, application/json", "User-Agent": "MarsWalk/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def covering_products(bbox):
    west, south, east, north, _margin = bbox
    # Use downloaded stereo DTMs first so known local coverage works offline.
    local_catalog = DTM_CATALOG
    if local_catalog.is_file():
        try:
            catalog = json.loads(local_catalog.read_text(encoding="utf-8"))
            local_products = []
            for item in catalog.get("products", []):
                bounds = item.get("bbox_lonlat")
                filename = item.get("local_file")
                instrument = item.get("instrument")
                local_path = CACHE_DIR / filename if filename else None
                if not bounds or len(bounds) < 4 or not local_path or not local_path.is_file():
                    continue
                west_i, south_i, east_i, north_i = map(float, bounds[:4])
                if west_i <= west and south_i <= south and east_i >= east and north_i >= north:
                    local_products.append({
                        "collection": item.get("collection", "cached_local_dtm"),
                        "instrument": instrument,
                        "id": item.get("id", local_path.stem),
                        "bbox": [west_i, south_i, east_i, north_i],
                        "gsd_m": float(item.get("native_posting_m", 1_000_000.0)),
                        "local_path": str(local_path),
                        "source": "Locally cached USGS analysis-ready stereo DTM",
                        "title": item.get("id", local_path.stem),
                    })
            for preferred in ("HiRISE", "CTX"):
                candidates = [p for p in local_products if p["instrument"] == preferred]
                if candidates:
                    return sorted(candidates, key=lambda p: p["gsd_m"])
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
    query = urllib.parse.urlencode(
        {"bbox": f"{west:.7f},{south:.7f},{east:.7f},{north:.7f}", "limit": "100"}
    )
    products = []
    for collection, instrument in COLLECTIONS:
        url = f"{STAC_ROOT}/collections/{collection}/items?{query}"
        document = stac_get(url)
        for item in document.get("features", []):
            bounds = item.get("bbox")
            assets = item.get("assets", {})
            dtm_asset = assets.get("dtm")
            if not bounds or len(bounds) < 4 or not dtm_asset or not dtm_asset.get("href"):
                continue
            asset_url = urllib.parse.urlparse(dtm_asset["href"])
            if asset_url.scheme != "https" or asset_url.hostname != "astrogeo-ard.s3-us-west-2.amazonaws.com":
                continue
            west_i, south_i, east_i, north_i = map(float, bounds[:4])
            if west_i <= west and south_i <= south and east_i >= east and north_i >= north:
                gsd = item.get("properties", {}).get("gsd")
                try:
                    gsd = float(gsd)
                except (TypeError, ValueError):
                    gsd = 1_000_000.0
                products.append({
                    "collection": collection,
                    "instrument": instrument,
                    "id": item.get("id", "unknown"),
                    "bbox": [west_i, south_i, east_i, north_i],
                    "gsd_m": gsd,
                    "href": dtm_asset["href"],
                    "title": item.get("properties", {}).get("title", item.get("id", "DTM")),
                })
        if products:
            # HiRISE is preferred if it covers the whole corridor; CTX is next.
            # Within a collection, use an already-cached product first to avoid
            # delaying the route with a nearly equivalent multi-GB download.
            return sorted(
                [p for p in products if p["instrument"] == instrument],
                key=lambda p: (not cache_path(p).is_file(), p["gsd_m"]),
            )
    return []


def cache_path(product):
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", product["id"])
    candidates = list(CACHE_DIR.glob(f"*{safe_id}*dtm.tif"))
    if candidates:
        return candidates[0]
    collection = re.sub(r"[^A-Za-z0-9_.-]+", "_", product["collection"])
    return CACHE_DIR / f"{collection}__{safe_id}_dtm.tif"


def dtm_source(product):
    if product.get("local_path"):
        local_path = Path(product["local_path"])
        if local_path.is_file():
            return str(local_path), False
    local_file = cache_path(product)
    if local_file.is_file():
        return str(local_file), False
    # USGS STAC assets are Cloud Optimized GeoTIFFs. GDAL reads only the
    # requested raster window using HTTP range requests instead of fetching
    # the entire scene before planning.
    return f"/vsicurl/{product['href']}", True


def is_traversal_block_error(error):
    message = str(error)
    return message.startswith((
        "No passable local-DTM cell",
        "The local DTM has no passable cells",
        "The local DTM route is blocked or disconnected",
    ))


def annotate_degraded_fallback(result, reason):
    warning = (
        "A higher-resolution terrain source could not produce a route for the requested endpoints. "
        "This route uses coarser elevation data and may not resolve local hazards in the detailed source."
    )
    result.setdefault("terrain_data", {})["fallback_reason"] = reason
    result["terrain_data"]["quality"] = "coarse_fallback_after_higher_resolution_rejection"
    result.setdefault("terrain_assessment", {})["fallback_warning"] = warning
    result.setdefault("limitations", []).insert(0, warning)
    return result


def choose_product(start, end, distance_km):
    bbox = corridor_bbox(start, end, distance_km)
    if bbox is None:
        return None, "Local DTM lookup does not cross the longitude wrap."
    if distance_km > MAX_LOCAL_ROUTE_KM:
        return None, f"Local DTM refinement is limited to routes up to {MAX_LOCAL_ROUTE_KM:.0f} km."
    products = covering_products(bbox)
    return (products[0], None) if products else (None, "No single HiRISE or CTX stereo DTM covers the full buffered route corridor.")


def local_geometry(elevation, pixel_width_m, pixel_height_m):
    """TTA-style 3x3 least-squares plane slope, local relief, and RMS roughness."""
    z = np.ma.asarray(elevation, dtype=np.float64).filled(np.nan)
    valid = np.isfinite(z)
    height, width = z.shape
    z_pad = np.pad(np.nan_to_num(z, nan=0.0), 1, mode="edge")
    valid_pad = np.pad(valid.astype(np.uint8), 1, mode="constant")
    sum_z = np.zeros((height, width), dtype=np.float64)
    sum_xz = np.zeros_like(sum_z)
    sum_yz = np.zeros_like(sum_z)
    z_min = np.full_like(sum_z, np.inf)
    z_max = np.full_like(sum_z, -np.inf)
    count = np.zeros((height, width), dtype=np.uint8)

    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            values = z_pad[1 + dr:1 + dr + height, 1 + dc:1 + dc + width]
            neighbor_valid = valid_pad[1 + dr:1 + dr + height, 1 + dc:1 + dc + width] > 0
            count += neighbor_valid.astype(np.uint8)
            sum_z += np.where(neighbor_valid, values, 0.0)
            sum_xz += np.where(neighbor_valid, dc * pixel_width_m * values, 0.0)
            sum_yz += np.where(neighbor_valid, -dr * pixel_height_m * values, 0.0)
            z_min = np.where(neighbor_valid, np.minimum(z_min, values), z_min)
            z_max = np.where(neighbor_valid, np.maximum(z_max, values), z_max)

    window_ok = (count == 9) & valid
    a0 = np.zeros_like(sum_z)
    a1 = np.zeros_like(sum_z)
    a2 = np.zeros_like(sum_z)
    a0[window_ok] = sum_xz[window_ok] / (6.0 * pixel_width_m**2)
    a1[window_ok] = sum_yz[window_ok] / (6.0 * pixel_height_m**2)
    a2[window_ok] = sum_z[window_ok] / 9.0

    residual_sq = np.zeros_like(sum_z)
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            values = z_pad[1 + dr:1 + dr + height, 1 + dc:1 + dc + width]
            neighbor_valid = valid_pad[1 + dr:1 + dr + height, 1 + dc:1 + dc + width] > 0
            fitted = a0 * (dc * pixel_width_m) + a1 * (-dr * pixel_height_m) + a2
            residual_sq += np.where(neighbor_valid, (fitted - values) ** 2, 0.0)

    slope = np.full_like(sum_z, np.nan)
    roughness = np.full_like(sum_z, np.nan)
    relief = np.full_like(sum_z, np.nan)
    aspect = np.full_like(sum_z, np.nan)
    norm = np.sqrt(a0 * a0 + a1 * a1 + 1.0)
    slope[window_ok] = np.degrees(np.arctan(np.sqrt(a0[window_ok]**2 + a1[window_ok]**2)))
    roughness[window_ok] = np.sqrt(residual_sq[window_ok] / 9.0) / norm[window_ok]
    relief[window_ok] = z_max[window_ok] - z_min[window_ok]
    aspect[window_ok] = np.degrees(np.arctan2(-a0[window_ok], -a1[window_ok])) % 360.0
    return window_ok, slope, roughness, relief, aspect



def sample_global_semantics(payload, longitudes, latitudes):
    """Project coarse mapped dune/crater factors onto the local DTM grid."""
    try:
        _start, _end, _distance, frame, _tile_count = global_planner.load_route_corridor(payload)
        valid = (
            np.isfinite(frame["latitude_deg"].to_numpy(dtype=float))
            & np.isfinite(frame["longitude_east_deg"].to_numpy(dtype=float))
        )
        frame = frame.loc[valid]
        if frame.empty:
            return None
        mean_lat = float(np.mean(latitudes))
        x_scale = MARS_RADIUS_M * math.cos(math.radians(mean_lat))
        source_lon = ((frame["longitude_east_deg"].to_numpy(dtype=float) + 180.0) % 360.0) - 180.0
        source_lat = frame["latitude_deg"].to_numpy(dtype=float)
        source_xy = np.column_stack((
            np.radians(source_lon) * x_scale,
            np.radians(source_lat) * MARS_RADIUS_M,
        ))
        tree = cKDTree(source_xy)
        target_xy = np.column_stack((
            np.radians(longitudes.ravel()) * x_scale,
            np.radians(latitudes.ravel()) * MARS_RADIUS_M,
        ))
        _distance, nearest = tree.query(target_xy, k=1, workers=1)
        dune_hit = frame["dune_hit"].fillna(0).to_numpy(dtype=float)[nearest].reshape(longitudes.shape)
        dune_distance = frame["dune_distance_km"].fillna(3.0).to_numpy(dtype=float)[nearest].reshape(longitudes.shape)
        crater_distance = frame["crater_edge_distance_km"].fillna(10.0).to_numpy(dtype=float)[nearest].reshape(longitudes.shape)
        dune_hazard = np.maximum(
            np.clip(dune_hit, 0.0, 1.0),
            np.clip((3.0 - dune_distance) / 3.0, 0.0, 1.0),
        )
        crater_hazard = np.clip((5.0 - crater_distance) / 5.0, 0.0, 1.0)
        semantic = (0.40 * dune_hazard + 0.35 * crater_hazard) / 0.75
        return {
            "dune_hit": dune_hit >= 1.0,
            "crater_blocked": crater_distance <= CRATER_AVOID_BUFFER_KM,
            "semantic_risk": semantic,
            "used": True,
        }
    except Exception:
        return None


def sample_vision_risk(transform, width, height, dst_crs, x_scale=1.0, global_blend_grid=False):
    """Resample experimental Jezero risk onto a local or coarse fallback route grid."""
    if not VISION_HAZARD_RASTER.is_file():
        return None, 0.0
    sampled = np.full((height, width), np.nan, dtype=np.float32)
    with rasterio.open(VISION_HAZARD_RASTER) as source:
        if source.count < 4 or source.crs is None:
            return None, 0.0
        destination_transform = transform
        destination_crs = dst_crs
        if global_blend_grid:
            # plan_local expresses the coarse grid in a local equirectangular frame
            # whose x coordinate is scaled by cos(mean latitude); undo that scale
            # to align it with the source Mars equirectangular CTX raster.
            destination_transform = rasterio.Affine(
                transform.a / x_scale, transform.b / x_scale, transform.c / x_scale,
                transform.d, transform.e, transform.f,
            )
            destination_crs = source.crs
        if destination_crs is None:
            return None, 0.0
        reproject(
            source=rasterio.band(source, 4),
            destination=sampled,
            src_transform=source.transform,
            src_crs=source.crs,
            src_nodata=source.nodata,
            dst_transform=destination_transform,
            dst_crs=destination_crs,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
    valid = np.isfinite(sampled) & (sampled >= 0.0) & (sampled <= 1.0)
    sampled[~valid] = np.nan
    return (sampled, float(valid.mean())) if np.any(valid) else (None, 0.0)



def load_vision_metrics():
    """Return the held-out weak-label report for transparent API metadata."""
    try:
        with VISION_MODEL_METRICS.open(encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, json.JSONDecodeError):
        return {}

def snap_to_passable(x, y, passable, transform, pixel_width_m, pixel_height_m):
    col = int(round((x - transform.c) / pixel_width_m - 0.5))
    row = int(round((transform.f - y) / pixel_height_m - 0.5))
    rows, cols = np.where(passable)
    if not len(rows):
        return None, math.inf
    centers_x = transform.c + (cols + 0.5) * pixel_width_m
    centers_y = transform.f - (rows + 0.5) * pixel_height_m
    distance = np.hypot(centers_x - x, centers_y - y)
    nearest = int(np.argmin(distance))
    return (int(rows[nearest]), int(cols[nearest])), float(distance[nearest])


def nearest_cell_coordinate(cell, transform, pixel_width_m, pixel_height_m, x_scale):
    row, col = cell
    x = transform.c + (col + 0.5) * pixel_width_m
    y = transform.f - (row + 0.5) * pixel_height_m
    lon = ((math.degrees(x / (MARS_RADIUS_M * x_scale)) + 180.0) % 360.0) - 180.0
    lat = math.degrees(y / MARS_RADIUS_M)
    return lat, lon


def transition_cross_slope_risk(slopes, aspects, row, col, next_row, next_col,
                                pixel_width_m, pixel_height_m, slope_limit):
    """Estimate cross-slope traversability from segment bearing and downslope aspect."""
    dx = (next_col - col) * pixel_width_m
    dy_north = -(next_row - row) * pixel_height_m
    bearing = math.atan2(dx, dy_north)
    normalizer = max(float(slope_limit), 1e-6)
    risks = []
    for r, c in ((row, col), (next_row, next_col)):
        slope = float(slopes[r, c])
        aspect = float(aspects[r, c])
        if not math.isfinite(slope) or not math.isfinite(aspect):
            continue
        delta = bearing - math.radians(aspect)
        cross_gradient = math.tan(math.radians(min(max(slope, 0.0), 89.0))) * abs(math.sin(delta))
        cross_slope_deg = math.degrees(math.atan(cross_gradient))
        risks.append(float(np.clip(cross_slope_deg / normalizer, 0.0, 1.0)))
    return float(np.mean(risks)) if risks else 0.0


def run_astar(passable, risk, start_rc, end_rc, pixel_width_m, pixel_height_m,
              risk_weight, slopes=None, aspects=None, slope_limit=20.0,
              aspect_edge_weight=0.10):
    height, width = passable.shape
    start_id = start_rc[0] * width + start_rc[1]
    end_id = end_rc[0] * width + end_rc[1]
    best = np.full(height * width, np.inf, dtype=np.float64)
    previous = np.full(height * width, -1, dtype=np.int32)
    closed = np.zeros(height * width, dtype=bool)
    best[start_id] = 0.0
    goal_r, goal_c = end_rc
    queue = [(math.hypot((goal_c - start_rc[1]) * pixel_width_m,
                         (goal_r - start_rc[0]) * pixel_height_m), 0.0, start_id)]

    while queue:
        _estimate, cost, node = heapq.heappop(queue)
        if closed[node] or cost > best[node]:
            continue
        if node == end_id:
            break
        closed[node] = True
        row, col = divmod(node, width)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = row + dr, col + dc
                if nr < 0 or nc < 0 or nr >= height or nc >= width:
                    continue
                if not passable[nr, nc] or closed[nr * width + nc]:
                    continue
                if dr and dc and (not passable[row, nc] or not passable[nr, col]):
                    continue
                nxt = nr * width + nc
                step = math.hypot(dc * pixel_width_m, dr * pixel_height_m)
                edge_risk = (risk[row, col] + risk[nr, nc]) / 2.0
                if slopes is not None and aspects is not None:
                    aspect_risk = transition_cross_slope_risk(
                        slopes, aspects, row, col, nr, nc,
                        pixel_width_m, pixel_height_m, slope_limit)
                    edge_risk = (edge_risk + aspect_edge_weight * aspect_risk) / (1.0 + aspect_edge_weight)
                edge = step * (1.0 + risk_weight * edge_risk)
                candidate = cost + edge
                if candidate >= best[nxt]:
                    continue
                best[nxt] = candidate
                previous[nxt] = node
                heuristic = math.hypot((goal_c - nc) * pixel_width_m,
                                       (goal_r - nr) * pixel_height_m)
                heapq.heappush(queue, (candidate + heuristic, candidate, nxt))

    if start_id != end_id and previous[end_id] < 0:
        raise ValueError("The local DTM route is blocked or disconnected; this high-resolution result was not replaced with a coarser route.")
    path = [end_id]
    while path[-1] != start_id:
        prior = int(previous[path[-1]])
        if prior < 0:
            raise ValueError("Could not reconstruct the local DTM route.")
        path.append(prior)
    path.reverse()
    return [(node // width, node % width) for node in path], float(best[end_id])


def plan_local(payload, product, start, end, requested_distance, mode, max_slope):
    path, is_remote = dtm_source(product)
    vision_requested = bool(payload.get("use_vision_model", False))
    vision_weight_requested = float(payload.get("vision_weight", 0.05))
    if not 0.0 <= vision_weight_requested <= 0.25:
        raise ValueError("vision_weight must be between 0 and 0.25 for this experimental layer.")

    is_global_blend = product.get("coordinate_system") == "mars_lonlat"
    bbox = corridor_bbox(start, end, requested_distance)
    mean_lat_rad = math.radians((start[0] + end[0]) / 2.0)
    x_scale = max(0.05, abs(math.cos(mean_lat_rad))) if is_global_blend else 1.0
    start_x, start_y = lonlat_to_xy(start[1], start[0], x_scale)
    end_x, end_y = lonlat_to_xy(end[1], end[0], x_scale)
    if bbox is None:
        raise LocalDTMSourceError("A local DTM window cannot cross the longitude wrap.")
    west, south, east, north, margin_m = bbox
    lon_margin = math.degrees(margin_m / (MARS_RADIUS_M * max(0.05, abs(math.cos(mean_lat_rad)))))
    lat_margin = math.degrees(margin_m / MARS_RADIUS_M)
    xmin = min(start_x, end_x) - MARS_RADIUS_M * math.radians(lon_margin)
    xmax = max(start_x, end_x) + MARS_RADIUS_M * math.radians(lon_margin)
    ymin = min(start_y, end_y) - MARS_RADIUS_M * math.radians(lat_margin)
    ymax = max(start_y, end_y) + MARS_RADIUS_M * math.radians(lat_margin)

    route_crs = None
    try:
        with rasterio.Env(
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
            CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
            GDAL_HTTP_TIMEOUT="30",
            GDAL_HTTP_MAX_RETRY="2",
            GDAL_CACHEMAX=128_000_000,
        ):
            with rasterio.open(path) as dataset:
                route_crs = dataset.crs
                bounds = dataset.bounds
                if is_global_blend:
                    if west < bounds.left or east > bounds.right or south < bounds.bottom or north > bounds.top:
                        raise LocalDTMSourceError("The global blend DEM does not cover the complete buffered route corridor.")
                    window = from_bounds(west, south, east, north, dataset.transform).round_offsets().round_lengths()
                else:
                    if xmin < bounds.left or xmax > bounds.right or ymin < bounds.bottom or ymax > bounds.top:
                        raise LocalDTMSourceError("The selected DTM does not contain the complete buffered route corridor.")
                    window = from_bounds(xmin, ymin, xmax, ymax, dataset.transform).round_offsets().round_lengths()
                source_width, source_height = int(window.width), int(window.height)
                if source_width < 3 or source_height < 3:
                    raise LocalDTMSourceError("The selected DTM has too few cells around this route.")
                if is_global_blend:
                    source_pixel_width_m = MARS_RADIUS_M * math.radians(abs(dataset.res[0])) * x_scale
                    source_pixel_height_m = MARS_RADIUS_M * math.radians(abs(dataset.res[1]))
                    source_gsd = max(source_pixel_width_m, source_pixel_height_m)
                    target_spacing = max(50.0, min(250.0, source_gsd))
                    area_m2 = source_width * source_pixel_width_m * source_height * source_pixel_height_m
                else:
                    source_gsd = float(product.get("gsd_m") or max(abs(dataset.res[0]), abs(dataset.res[1])))
                    target_spacing = max(5.0, min(30.0, source_gsd * 2.0))
                    area_m2 = source_width * abs(dataset.res[0]) * source_height * abs(dataset.res[1])
                estimated_cells = area_m2 / (target_spacing * target_spacing)
                if estimated_cells > MAX_GRID_CELLS:
                    target_spacing *= math.sqrt(estimated_cells / MAX_GRID_CELLS)
                if is_global_blend:
                    out_width = max(3, int(math.ceil(source_width * source_pixel_width_m / target_spacing)))
                    out_height = max(3, int(math.ceil(source_height * source_pixel_height_m / target_spacing)))
                else:
                    out_width = max(3, int(math.ceil(source_width * abs(dataset.res[0]) / target_spacing)))
                    out_height = max(3, int(math.ceil(source_height * abs(dataset.res[1]) / target_spacing)))
                if out_width * out_height > MAX_GRID_CELLS:
                    scale = math.sqrt((out_width * out_height) / MAX_GRID_CELLS)
                    out_width = max(3, int(out_width / scale))
                    out_height = max(3, int(out_height / scale))
                elevation = dataset.read(
                    1,
                    window=window,
                    out_shape=(out_height, out_width),
                    resampling=Resampling.average,
                    masked=True,
                )
                source_transform = dataset.window_transform(window) * rasterio.Affine.scale(
                    source_width / out_width, source_height / out_height
                )
                if is_global_blend:
                    pixel_width_m = MARS_RADIUS_M * math.radians(abs(float(source_transform.a))) * x_scale
                    pixel_height_m = MARS_RADIUS_M * math.radians(abs(float(source_transform.e)))
                    out_transform = rasterio.Affine(
                        pixel_width_m, 0.0, MARS_RADIUS_M * math.radians(source_transform.c) * x_scale,
                        0.0, -pixel_height_m, MARS_RADIUS_M * math.radians(source_transform.f),
                    )
                else:
                    out_transform = source_transform
                    pixel_width_m = abs(float(out_transform.a))
                    pixel_height_m = abs(float(out_transform.e))
                if pixel_width_m <= 0 or pixel_height_m <= 0:
                    raise LocalDTMSourceError("The selected DTM has an invalid pixel transform.")
    except LocalDTMSourceError:
        raise
    except Exception as error:
        if is_remote:
            raise LocalDTMSourceError(f"Could not stream the USGS DTM window: {error}") from error
        raise

    valid_window, slopes, roughness, relief, aspects = local_geometry(
        elevation, pixel_width_m, pixel_height_m
    )
    height, width = slopes.shape
    cols_grid, rows_grid = np.meshgrid(np.arange(width), np.arange(height))
    x_grid = out_transform.c + (cols_grid + 0.5) * out_transform.a
    y_grid = out_transform.f + (rows_grid + 0.5) * out_transform.e
    longitudes_grid = ((np.degrees(x_grid / (MARS_RADIUS_M * x_scale)) + 180.0) % 360.0) - 180.0
    latitudes_grid = np.degrees(y_grid / MARS_RADIUS_M)
    semantics = sample_global_semantics(payload, longitudes_grid, latitudes_grid)
    vision_risk = None
    vision_coverage_fraction = 0.0
    vision_status = "not_requested"
    vision_error = None
    if vision_requested:
        try:
            vision_risk, vision_coverage_fraction = sample_vision_risk(
                out_transform, width, height, route_crs, x_scale=x_scale,
                global_blend_grid=is_global_blend,
            )
            vision_status = "used_experimental_layer" if vision_risk is not None else "no_image_coverage"
        except Exception as error:
            vision_status = "unavailable_error"
            vision_error = str(error)[:300]

    slope_limit = max_slope
    slope_normalized = np.clip(slopes / slope_limit, 0.0, 1.0)
    if is_global_blend:
        # Keep the same global terrain-cost scales as the Parquet fallback.
        roughness_limit, relief_limit = 50.0, 200.0
    else:
        roughness_limit = max(3.0, source_gsd * 5.0)
        relief_limit = max(5.0, source_gsd * 10.0)
    rough_normalized = np.clip(roughness / roughness_limit, 0.0, 1.0)
    relief_normalized = np.clip(relief / relief_limit, 0.0, 1.0)
    risk_components = {
        "slope": slope_normalized,
        "height_difference": relief_normalized,
        "roughness": rough_normalized,
    }
    if semantics:
        semantic_risk = semantics["semantic_risk"]
        dune_hit = semantics["dune_hit"]
        crater_blocked = semantics["crater_blocked"]
        base_weights = {"slope": 0.50, "height_difference": 0.25, "roughness": 0.15, "terrain_semantics": 0.10}
        risk_components["terrain_semantics"] = semantic_risk
    else:
        semantic_risk = np.zeros_like(slopes)
        dune_hit = np.zeros_like(slopes, dtype=bool)
        crater_blocked = np.zeros_like(slopes, dtype=bool)
        base_weights = {"slope": 0.50, "height_difference": 0.25, "roughness": 0.15}
    base_total = sum(base_weights.values())
    base_weights = {key: value / base_total for key, value in base_weights.items()}
    if vision_requested and vision_risk is not None:
        # A deliberately small, opt-in cost influence: this model has weak labels and low hazard recall.
        risk_weights = {key: value * (1.0 - vision_weight_requested) for key, value in base_weights.items()}
        risk_weights["vision_model_hazard_probability"] = vision_weight_requested
        risk_components["vision_model_hazard_probability"] = np.where(
            np.isfinite(vision_risk), vision_risk, 0.5
        )
        vision_status = "used_experimental_layer_with_unknown_cells_penalized"
    else:
        risk_weights = base_weights
    risk_total = sum(risk_weights.values())
    risks = np.clip(
        sum(risk_weights[key] * risk_components[key] for key in risk_weights) / risk_total,
        0.0,
        1.0,
    )
    classes = np.full(slopes.shape, "unknown", dtype=object)
    hard_block = valid_window & ((slopes > slope_limit) | dune_hit | crater_blocked)
    classes[hard_block] = "impassable"
    candidates = valid_window & ~hard_block & np.isfinite(risks)
    classes[candidates & (risks >= 0.67)] = "high"
    classes[candidates & (risks >= 0.33) & (risks < 0.67)] = "caution"
    classes[candidates & (risks < 0.33)] = "safe"
    passable = np.isin(classes, ["safe", "caution", "high"])

    start_cell, start_snap_m = snap_to_passable(
        start_x, start_y, passable, out_transform, pixel_width_m, pixel_height_m
    )
    end_cell, end_snap_m = snap_to_passable(
        end_x, end_y, passable, out_transform, pixel_width_m, pixel_height_m
    )
    for label, cell, snap_m in (
        ("start", start_cell, start_snap_m),
        ("destination", end_cell, end_snap_m),
    ):
        if cell is None or not math.isfinite(snap_m):
            raise ValueError(f"The local DTM has no passable cells in the route window near the {label}.")
        if snap_m > MAX_LOCAL_SNAP_M:
            nearest_lat, nearest_lon = nearest_cell_coordinate(
                cell, out_transform, pixel_width_m, pixel_height_m, x_scale
            )
            raise ValueError(
                f"No passable local-DTM cell is within {MAX_LOCAL_SNAP_M:.0f} m of the {label}; "
                f"the nearest is {snap_m / 1000.0:.2f} km away at "
                f"{nearest_lat:.6f}, {nearest_lon:.6f}. Move the {label} toward that point or choose another location."
            )

    settings = MODE_SETTINGS[mode]
    aspect_edge_weight = 0.10
    path_cells, weighted_cost_m = run_astar(
        passable, risks, start_cell, end_cell, pixel_width_m, pixel_height_m,
        settings["risk_weight"], slopes=slopes, aspects=aspects,
        slope_limit=slope_limit, aspect_edge_weight=aspect_edge_weight,
    )
    height, width = slopes.shape
    rows = np.array([point[0] for point in path_cells], dtype=int)
    cols = np.array([point[1] for point in path_cells], dtype=int)
    x_centers = out_transform.c + (cols + 0.5) * out_transform.a
    y_centers = out_transform.f + (rows + 0.5) * out_transform.e
    longitudes = ((np.degrees(x_centers / (MARS_RADIUS_M * x_scale)) + 180.0) % 360.0) - 180.0
    latitudes = np.degrees(y_centers / MARS_RADIUS_M)
    coordinates = [
        [round(float(lon), 7), round(float(lat), 7)]
        for lon, lat in zip(longitudes, latitudes)
    ]
    path_slopes = slopes[rows, cols]
    path_roughness = roughness[rows, cols]
    path_relief = relief[rows, cols]
    path_risks = risks[rows, cols]
    path_classes = classes[rows, cols]
    path_aspect_risk = np.zeros(len(path_cells), dtype=np.float64)
    for i in range(1, len(path_cells)):
        previous_row, previous_col = path_cells[i - 1]
        row, col = path_cells[i]
        path_aspect_risk[i] = transition_cross_slope_risk(
            slopes, aspects, previous_row, previous_col, row, col,
            pixel_width_m, pixel_height_m, slope_limit,
        )
    distance_m = sum(
        math.hypot((cols[i] - cols[i - 1]) * pixel_width_m, (rows[i] - rows[i - 1]) * pixel_height_m)
        for i in range(1, len(path_cells))
    )
    details = []
    for i in range(len(path_cells)):
        row, col = path_cells[i]
        detail = {
            "lat": round(float(latitudes[i]), 7),
            "lon": round(float(longitudes[i]), 7),
            "class": str(path_classes[i]),
            "cost_0_to_1": round(float(path_risks[i]), 4),
            "slope_deg": round(float(path_slopes[i]), 3),
            "aspect_deg": round(float(aspects[row, col]), 2),
            "height_difference_m": round(float(path_relief[i]), 2),
            "roughness_rms_m": round(float(path_roughness[i]), 2),
            "aspect_cross_slope_risk_0_to_1": round(float(path_aspect_risk[i]), 4),
        }
        if vision_requested and vision_risk is not None:
            probability = vision_risk[row, col]
            detail["vision_hazard_probability"] = round(float(probability), 4) if np.isfinite(probability) else None
        details.append(detail)
    class_counts = {
        name: int(np.sum(path_classes == name))
        for name in ("impassable", "high", "caution", "safe", "unknown")
    }
    return {
        "status": "success",
        "planner": (
            "A* over a local window of the global HRSC/MOLA blend DEM"
            if is_global_blend
            else f"A* over a local {product['instrument']} stereo DTM"
        ),
        "mode": mode,
        "data_resolution_m": f"{source_gsd:.2f} m DTM posting; {pixel_width_m:.1f} m route grid",
        "terrain_data": {
            "status": "global_dem_window" if is_global_blend else "local_dtm",
            "instrument": product["instrument"],
            "product_id": product["id"],
            "product_title": product["title"],
            "native_posting_m": round(source_gsd, 3),
            "route_grid_m": round(pixel_width_m, 2),
            "coverage_bbox_lonlat": product["bbox"],
            "source": product.get("source", "USGS Astrogeology analysis-ready STAC DTM"),
        },
        "imagery": {
            "source": "NASA MRO HiRISE mosaic where available, with CTX underneath",
            "note": "Image and DTM footprints are separate; imagery may not be perfectly co-registered. Route metrics come only from the selected DTM.",
        },
        "endpoints": {
            "start": {
                "lat": float(math.degrees(y_centers[0] / MARS_RADIUS_M)),
                "lon": float(longitudes[0]),
                "snap_distance_km": round(start_snap_m / 1000.0, 4),
            },
            "end": {
                "lat": float(latitudes[-1]),
                "lon": float(longitudes[-1]),
                "snap_distance_km": round(end_snap_m / 1000.0, 4),
            },
        },
        "route": {
            "type": "Feature",
            "properties": {
                "cost_model": "distance × (1 + mode risk weight × mean local TTA terrain cost)"
            },
            "geometry": {"type": "LineString", "coordinates": coordinates},
        },
        "route_cell_details": details,
        "vision_model": {
            "status": vision_status,
            "requested": vision_requested,
            "source": str(VISION_HAZARD_RASTER) if vision_risk is not None else None,
            "weight": vision_weight_requested if vision_risk is not None else 0.0,
            "coverage_fraction_of_route_search_grid": round(vision_coverage_fraction, 4),
            "test_hazard_proxy_recall": load_vision_metrics().get("test_metrics_vs_weak_labels", {}).get("hazard_proxy_recall_vs_weak_labels_classes_1_2"),
            "test_metric_basis": "weak DTM-derived labels; not independent visual ground truth",
            "model": "dual-stream gated-fusion U-Net: CTX image plus TTA terrain geometry",
            "warning": "Experimental model trained on weak DTM-derived labels; no human-reviewed visual hazard labels are available and scores are not calibrated safety probabilities.",
            "error": vision_error,
        },
        "terrain_assessment": {
            "method": "3×3 least-squares DEM plane slope, relief, plane-residual roughness, direction-aware downslope-aspect cross-slope edge penalty, plus optional image risk",
            "weights": risk_weights,
            "edge_penalties": {"downslope_aspect_cross_slope": aspect_edge_weight},
            "normalizers": {
                "slope_deg": slope_limit,
                "height_difference_m": round(relief_limit, 2),
                "roughness_rms_m": round(roughness_limit, 2),
            },
            "class_counts_on_route": class_counts,
            "class_thresholds": {
                "safe_max_exclusive": 0.33,
                "caution_min": 0.33,
                "high_min": 0.67,
                "impassable": f"mapped dune, crater footprint/near-edge zone (≤{CRATER_AVOID_BUFFER_KM:.1f} km), or slope above {slope_limit:.1f}°",
                "unknown": "incomplete 3×3 DTM neighborhood",
            },
            "semantic_factors_used": ["coarse mapped dune cells", "approximate crater footprint and edge avoidance"] if semantics else [],
            "semantic_factors_not_scored": [
                "geology, wheel slip, travel time, energy, and safety probability are not modeled",
                "the result is a terrain-cost route, not a rover-certified safety prediction",
            ],
        },
        "metrics": {
            "requested_straight_distance_km": round(requested_distance, 3),
            "distance_km": round(distance_m / 1000.0, 3),
            "max_slope_deg": round(float(np.nanmax(path_slopes)), 2),
            "mean_slope_deg": round(float(np.nanmean(path_slopes)), 2),
            "max_roughness_rms_m": round(float(np.nanmax(path_roughness)), 2),
            "max_height_difference_m": round(float(np.nanmax(path_relief)), 2),
            "mean_terrain_risk_0_to_1": round(float(np.mean(path_risks)), 3),
            "mean_aspect_cross_slope_risk_0_to_1": round(float(np.mean(path_aspect_risk)), 4),
            "max_aspect_cross_slope_risk_0_to_1": round(float(np.max(path_aspect_risk)), 4),
            "mean_vision_hazard_probability": (
                round(float(np.nanmean(vision_risk[rows, cols])), 4)
                if vision_requested and vision_risk is not None and np.any(np.isfinite(vision_risk[rows, cols])) else None
            ),
            "route_cells": len(path_cells),
            "search_cells": int(slopes.size),
            "weighted_cost_km_equivalent": round(weighted_cost_m / 1000.0, 3),
        },
        "cost_factors": [
            "local 3×3 least-squares slope",
            "local 3×3 elevation range",
            "local 3×3 plane-residual roughness",
            "downslope aspect relative to each route segment (cross-slope edge penalty)",
            "mapped dunes and crater footprint/near-edge avoidance",
        ] + (["experimental U-Net image hazard probability (soft cost only)"] if vision_requested and vision_risk is not None else []),
        "limitations": [
            "Local DEM posting is not the same as effective terrain resolution; small features and DTM artifacts may be unresolved.",
            "Mapped dune and crater factors are sampled from the coarser global grid when its tile is available; they are not HiRISE-scale.",
            "Geology, wheel slip, travel time, energy, and safety probability are not scored.",
            "The route grid is resampled to bound memory and computation; its spacing is reported in terrain_data.",
            "The mode weights and normalizers are planning proxies and need rover-specific calibration.",
        ] + (["The optional vision layer is trained on weak DTM-derived labels; it is not an independently validated no-go map."] if vision_requested and vision_risk is not None else []),
    }


def plan(payload):
    start, end, requested_distance = validate_route(payload)
    mode = str(payload.get("mode", "balanced")).lower()
    if mode not in MODE_SETTINGS:
        raise ValueError("mode must be one of: fastest, balanced, safest.")
    default_slope = MODE_SETTINGS[mode]["max_slope_deg"]
    try:
        max_slope = float(payload.get("max_slope_deg", default_slope))
    except (TypeError, ValueError):
        raise ValueError("max_slope_deg must be a number between 0 and 45.")
    if not 0.0 < max_slope <= 45.0:
        raise ValueError("max_slope_deg must be greater than 0 and at most 45.")

    product = None
    lookup_note = None
    try:
        product, lookup_note = choose_product(start, end, requested_distance)
    except (OSError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
        lookup_note = f"USGS DTM catalog lookup failed: {error}"

    stereo_route_issue = None
    if product:
        try:
            # A cached local DTM is opened from disk; other COGs are read by
            # HTTP range requests for just the route window.
            return plan_local(payload, product, start, end, requested_distance, mode, max_slope)
        except LocalDTMSourceError as error:
            lookup_note = str(error)
        except ValueError as error:
            if not is_traversal_block_error(error):
                raise
            stereo_route_issue = str(error)

    result = global_planner.plan(payload)
    if payload.get("use_vision_model"):
        result["vision_model"] = {
            "status": "unavailable_for_global_parquet_route",
            "requested": True,
            "source": str(VISION_HAZARD_RASTER),
            "weight": 0.0,
            "coverage_fraction_of_route_search_grid": 0.0,
            "warning": "The experimental vision raster covers only the Jezero CTX scene; it was not applied to this global Parquet route.",
        }
    result["terrain_data"] = {
        "status": "global_fallback",
        "instrument": "global Parquet terrain grid",
        "source": "MarsWalk global 10-degree Parquet tiles",
        "native_resolution_note": "nominal approximately 1 km terrain cells",
        "note": lookup_note or "No local stereo DTM covers the route; using the global Parquet grid.",
    }
    result["imagery"] = {
        "source": "NASA MRO HiRISE mosaic where available, with CTX underneath",
        "note": "A detailed image background does not imply matching high-resolution elevation coverage.",
    }
    result["planner"] = "Global A* over 10-degree Parquet tiles"
    result["limitations"].append(
        "No covering local stereo DTM was used; the route used global Parquet features at nominal approximately 1 km resolution."
    )
    if stereo_route_issue:
        result = annotate_degraded_fallback(result, stereo_route_issue)
    return result


def main():
    try:
        result = plan(json.load(sys.stdin))
    except Exception as exc:
        result = {"error": str(exc)}
        print(json.dumps(result, allow_nan=False))
        raise SystemExit(1)
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()




