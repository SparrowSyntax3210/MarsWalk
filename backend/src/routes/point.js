const express = require("express");
const Lerc = require("lerc");

const router = express.Router();
const DEM_SERVICE_URL =
  "https://astro.arcgis.com/arcgis/rest/services/OnMars/MDEM200M/ImageServer";
const REQUEST_TIMEOUT_MS = 15_000;
const MARS_SPATIAL_REFERENCE = 104971;
const MARS_RADIUS_METERS = 3_389_500;
const TILE_LEVEL = 7;
const TILE_EDGE = 512;
const DEGREE_RESOLUTION = 0.00274658203125;
const TILE_URL = `${DEM_SERVICE_URL}/tile/${TILE_LEVEL}`;
const GEOLOGY_SERVICE_URL = "https://services.arcgis.com/nzS0F0zdNLvs7nc8/ArcGIS/rest/services/Mars_Geology_feature_layer/FeatureServer/0/query";
const REMS_FEED_URL = "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json";
const GALE_CONTEXT = { lat: -5.4, lon: 137.8 };
const GALE_CONTEXT_RADIUS_KM = 200;
const decodedTileCache = new Map();
let lercReady;
let remsCache;
let remsCacheExpiresAt = 0;

function parseCoordinates(query) {
  const lat = Number(query.lat);
  const lon = Number(query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  return { lat, lon };
}

async function getDecodedTile(row, column) {
  const key = `${row}/${column}`;
  if (decodedTileCache.has(key)) {
    const cached = decodedTileCache.get(key);
    decodedTileCache.delete(key);
    decodedTileCache.set(key, cached);
    return cached;
  }

  const tilePromise = (async () => {
    lercReady ||= Lerc.load();
    await lercReady;
    const response = await fetch(`${TILE_URL}/${row}/${column}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Mars DEM tile returned HTTP ${response.status}`);
    const decoded = Lerc.decode(await response.arrayBuffer());
    if (!decoded.width || !decoded.height || !decoded.pixels?.[0]) {
      throw new Error("Mars DEM tile could not be decoded");
    }
    return decoded;
  })();

  decodedTileCache.set(key, tilePromise);
  if (decodedTileCache.size > 8) {
    const oldestKey = decodedTileCache.keys().next().value;
    if (oldestKey !== key) decodedTileCache.delete(oldestKey);
  }
  try {
    return await tilePromise;
  } catch (error) {
    decodedTileCache.delete(key);
    throw error;
  }
}

async function sampleElevation(lat, lon) {
  // The public service serves numeric elevations as LERC-compressed image
  // tiles; its REST getSamples operation is not exposed on this cached service.
  const wrappedLon = ((lon + 180) % 360 + 360) % 360 - 180;
  const pixelX = Math.floor((wrappedLon + 180) / DEGREE_RESOLUTION);
  const pixelY = Math.min(
    Math.ceil(180 / DEGREE_RESOLUTION) - 1,
    Math.max(0, Math.floor((90 - lat) / DEGREE_RESOLUTION)),
  );
  const tileColumn = Math.floor(pixelX / TILE_EDGE);
  const tileRow = Math.floor(pixelY / TILE_EDGE);
  const col = pixelX - tileColumn * TILE_EDGE;
  const row = pixelY - tileRow * TILE_EDGE;
  const tile = await getDecodedTile(tileRow, tileColumn);
  if (col >= tile.width || row >= tile.height) return null;
  const index = row * tile.width + col;
  if (tile.mask && !tile.mask[index]) return null;
  const value = Number(tile.pixels[0][index]);
  return Number.isFinite(value) ? value : null;
}

function deriveTerrain(samples, lat) {
  const { center, north, south, east, west } = samples;
  if (![center, north, south, east, west].every(Number.isFinite)) {
    return { slope: null, aspect: null, roughness: null };
  }

  // Derive approximate metrics from neighboring cells in the service grid.
  const spacing = MARS_RADIUS_METERS * (DEGREE_RESOLUTION * Math.PI / 180);
  const latRad = (lat * Math.PI) / 180;
  const dx = Math.max(1, spacing * Math.cos(latRad));
  const dzdx = (east - west) / (2 * dx);
  const dzdy = (north - south) / (2 * spacing);
  const slope = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  let aspect = (Math.atan2(dzdx, -dzdy) * 180) / Math.PI;
  if (aspect < 0) aspect += 360;
  const roughness = Math.sqrt(
    ((north - center) ** 2 + (south - center) ** 2 + (east - center) ** 2 + (west - center) ** 2) / 4,
  );
  return { slope, aspect, roughness };
}

async function queryGeologicUnit(lat, lon) {
  const url = new URL(GEOLOGY_SERVICE_URL);
  const params = {
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: MARS_SPATIAL_REFERENCE } }),
    geometryType: "esriGeometryPoint",
    inSR: String(MARS_SPATIAL_REFERENCE),
    spatialRel: "esriSpatialRelIntersects",
    outFields: "Unit,UnitDesc,SphArea_km",
    returnGeometry: "false",
    resultRecordCount: "1",
  };
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`USGS Mars geology service returned HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "USGS Mars geology query failed");
  return data.features?.[0]?.attributes || null;
}

function solarNoonContext(lat) {
  // Transparent equinox/noon proxy. This gives solar altitude on a level
  // surface; it does not account for local slope, terrain horizon, or dust.
  const obliquity = (25.19 * Math.PI) / 180;
  const solarLongitude = 0;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(solarLongitude));
  const latitude = (lat * Math.PI) / 180;
  const altitude = Math.asin(
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination),
  );
  return (altitude * 180) / Math.PI;
}

function marsDistanceKm(aLat, aLon, bLat, bLon) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = radians(bLat - aLat);
  const dLon = radians(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_METERS * Math.asin(Math.sqrt(h)) / 1000;
}

async function getLatestRemsReport() {
  if (remsCache && Date.now() < remsCacheExpiresAt) return remsCache;
  const response = await fetch(REMS_FEED_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`NASA REMS feed returned HTTP ${response.status}`);
  const payload = await response.json();
  const report = payload.soles?.[0];
  if (!report) throw new Error("NASA REMS feed did not contain a weather report");
  remsCache = report;
  remsCacheExpiresAt = Date.now() + 30 * 60 * 1000;
  return report;
}

function buildWeatherLayers(lat, lon, report, error) {
  const distanceKm = marsDistanceKm(lat, lon, GALE_CONTEXT.lat, GALE_CONTEXT.lon);
  const inGaleContext = distanceKm <= GALE_CONTEXT_RADIUS_KM;
  const unavailable = !inGaleContext || !report;
  const contextMessage = !inGaleContext
    ? `REMS is a rover weather station at Gale Crater, about ${distanceKm.toFixed(0)} km from this click; its readings are not assigned to this location.`
    : error
      ? `Gale is within the regional context radius, but the NASA REMS feed is unavailable: ${error}`
      : `Latest available Curiosity REMS regional report, Sol ${report.sol} (${report.terrestrial_date}). Station data at Gale; not a measurement at the exact clicked pixel.`;
  const source = "NASA/JPL Curiosity REMS public weather feed";
  const sourceUrl = "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json";
  const valueOrNull = (value) => {
    if (value === undefined || value === null || value === "--" || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const row = (id, name, value, units, message) => ({
    id,
    group: "Environment",
    name,
    source,
    sourceUrl,
    kind: "station observation",
    status: unavailable || value === null ? (error && inGaleContext ? "unavailable" : "no-data") : "available",
    value,
    units,
    nominalResolution: report && inGaleContext ? `Gale station context · Sol ${report.sol} · ${report.terrestrial_date}` : "Station coverage is region-limited; no interpolation is performed.",
    message: message || contextMessage,
  });
  const airMin = valueOrNull(report?.min_temp);
  const airMax = valueOrNull(report?.max_temp);
  const groundMin = valueOrNull(report?.min_gts_temp);
  const groundMax = valueOrNull(report?.max_gts_temp);
  const pressure = valueOrNull(report?.pressure);
  return [
    row("rems-air-temperature", "Air temperature range", airMin === null && airMax === null ? null : `${airMin ?? "—"} to ${airMax ?? "—"} °C`, "", contextMessage),
    row("rems-ground-temperature", "Ground temperature range", groundMin === null && groundMax === null ? null : `${groundMin ?? "—"} to ${groundMax ?? "—"} °C`, "", contextMessage),
    row("rems-pressure", "Atmospheric pressure", pressure, "Pa", contextMessage),
    row("rems-dust-opacity", "Atmospheric opacity", report?.atmo_opacity && report.atmo_opacity !== "--" ? report.atmo_opacity : null, "", contextMessage),
    row("rems-uv", "UV irradiance category", report?.local_uv_irradiance_index && report.local_uv_irradiance_index !== "--" ? report.local_uv_irradiance_index : null, "", contextMessage),
    row("rems-wind", "Wind speed", valueOrNull(report?.wind_speed), "m/s", contextMessage),
  ];
}

const plannedLayers = [
  {
    id: "thermal-inertia",
    group: "Surface properties",
    name: "TES thermal inertia",
    source: "MGS TES global map via NASA Trek WMTS",
    sourceUrl: "https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars",
    kind: "map overlay",
    status: "map-only",
    message: "Select ‘TES thermal inertia · map overlay’ in the map controls to view the global raster. NASA Trek serves rendered map tiles; this service does not return a numeric value for a clicked pixel.",
    nominalResolution: "Global regional-scale TES product; use the overlay as context, not a local footing measurement.",
  },
  {
    id: "dust-cover",
    group: "Surface properties",
    name: "TES dust cover index",
    source: "MGS TES global dust index via NASA Trek WMTS",
    sourceUrl: "https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars",
    kind: "map overlay",
    status: "map-only",
    message: "Select ‘TES dust cover index · map overlay’ to view the global raster. Rendered WMTS tiles are not numeric point samples.",
    nominalResolution: "Regional product (~3.5 km per pixel); not astronaut-scale soil strength.",
  },
  {
    id: "mola-roughness",
    group: "Surface properties",
    name: "MOLA vertical roughness context",
    source: "MGS MOLA global roughness map via NASA Trek WMTS",
    sourceUrl: "https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars",
    kind: "map overlay",
    status: "map-only",
    message: "Select ‘MOLA roughness · map overlay’ to view the global multiscale roughness map. It is a rendered regional map, not the same as the local elevation-variation value above.",
    nominalResolution: "Global roughness baselines; much coarser than CTX/HiRISE walk-scale terrain.",
  },
  {
    id: "minerals",
    group: "Geology & science",
    name: "Mineral detections",
    source: "MGS TES sheet-silicate / high-silica map via NASA Trek WMTS",
    sourceUrl: "https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars",
    kind: "map overlay",
    status: "map-only",
    message: "Select ‘TES sheet silicates · map overlay’ to view the global regional mineral map. This rendered map does not provide a numeric mineral abundance at the clicked coordinate; CRISM detections require querying individual observation products.",
    nominalResolution: "Global TES mineral map (~16 km per pixel); regional signal, not a point measurement.",
  },
  {
    id: "science-targets",
    group: "Geology & science",
    name: "Rover targets and instrument measurements",
    source: "PDS mission archives (APXS and other instruments)",
    kind: "observation",
    status: "not-configured",
    message: "No target/measurement index is connected. Point observations must be shown at their true coordinates, with distance from the selected point.",
  },
  {
    id: "radiation",
    group: "Radiation",
    name: "Radiation observations / model",
    source: "Curiosity RAD and radiation environment models",
    kind: "observation-or-model",
    status: "not-configured",
    message: "RAD is a local, time-dependent record, not a global point map; no coordinate-indexed model is connected.",
  },
  {
    id: "ice-hydrogen",
    group: "Geology & science",
    name: "Subsurface hydrogen / ice evidence",
    source: "Mars Odyssey GRS/HEND and published regional products",
    kind: "mapped",
    status: "not-configured",
    message: "No georeferenced product is connected. Broad orbital signals must not be presented as a precise deposit at this coordinate.",
  },
  {
    id: "ai4mars",
    group: "Image interpretation",
    name: "AI4MARS terrain classification",
    source: "Curiosity, Opportunity, and Spirit rover images",
    kind: "image-model",
    status: "dataset-only",
    message: "The dataset can support a future image model, but no trained model or georeferenced prediction layer is connected.",
  },
];

router.get("/", async (req, res) => {
  const coordinates = parseCoordinates(req.query);
  if (!coordinates) {
    return res.status(400).json({ error: "Provide latitude from -90 to 90 and longitude from -180 to 180." });
  }

  const { lat, lon } = coordinates;
  const gridSpacingMeters = MARS_RADIUS_METERS * (DEGREE_RESOLUTION * Math.PI / 180);
  const deltaLat = DEGREE_RESOLUTION;
  const deltaLon = DEGREE_RESOLUTION;
  const requests = [
    sampleElevation(lat, lon),
    sampleElevation(Math.min(89.999, lat + deltaLat), lon),
    sampleElevation(Math.max(-89.999, lat - deltaLat), lon),
    sampleElevation(lat, lon + deltaLon),
    sampleElevation(lat, lon - deltaLon),
  ];
  const galeDistanceKm = marsDistanceKm(lat, lon, GALE_CONTEXT.lat, GALE_CONTEXT.lon);
  const weatherPromise = galeDistanceKm <= GALE_CONTEXT_RADIUS_KM
    ? getLatestRemsReport().then((report) => ({ report, error: null }))
      .catch((error) => ({ report: null, error: error.message }))
    : Promise.resolve({ report: null, error: null });
  const [samples, geologyResult, weatherResult] = await Promise.all([
    Promise.allSettled(requests),
    queryGeologicUnit(lat, lon).then((value) => ({ status: "fulfilled", value }))
      .catch((reason) => ({ status: "rejected", reason })),
    weatherPromise,
  ]);
  const values = samples.map((result) => result.status === "fulfilled" ? result.value : null);
  const sampleErrors = samples
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "Unknown elevation tile error");
  const [center, north, south, east, west] = values;
  const terrain = deriveTerrain({ center, north, south, east, west }, lat);
  const geology = geologyResult.status === "fulfilled" ? geologyResult.value : null;
  const weatherLayers = buildWeatherLayers(lat, lon, weatherResult.report, weatherResult.error);

  const layers = [
    {
      id: "elevation",
      group: "Terrain",
      name: "Elevation",
      source: "Esri OnMars MDEM200M ImageServer",
      sourceUrl: DEM_SERVICE_URL,
      kind: "sampled-raster",
      status: center === null ? "no-data" : "available",
      value: center,
      units: "m",
      nominalResolution: `${DEGREE_RESOLUTION}° grid spacing (~${gridSpacingMeters.toFixed(0)} m per cell at the equator; service product name MDEM200M)`,
      message: center === null
        ? (sampleErrors.length ? `Elevation tile request failed: ${sampleErrors[0]}` : "No elevation pixel returned for this coordinate.")
        : "Value decoded from the numeric LERC elevation tile.",
    },
    ...[
      ["slope", "Slope", terrain.slope, "°"],
      ["aspect", "Aspect", terrain.aspect, "°"],
      ["roughness", "Local elevation variation", terrain.roughness, "m"],
    ].map(([id, name, value, units]) => ({
      id,
      group: "Terrain",
      name,
      source: "Derived from five MDEM200M point samples",
      sourceUrl: DEM_SERVICE_URL,
      kind: "derived",
      status: value === null ? "no-data" : "available",
      value,
      units,
      nominalResolution: `Adjacent cells in the ${DEGREE_RESOLUTION}° grid (~${gridSpacingMeters.toFixed(0)} m at the equator); finer local detail is not represented`,
      message: id === "roughness" ? "RMS elevation difference from the center to four neighboring samples; a simple local metric, not a standardized roughness product." : "Approximate central-difference derivative from neighboring elevation samples.",
    })),
    {
      id: "regional-geology",
      group: "Geology & science",
      name: "Mapped geologic unit",
      source: "USGS Geologic Map of Mars (SIM 3292, 1:20,000,000)",
      sourceUrl: "https://services.arcgis.com/nzS0F0zdNLvs7nc8/ArcGIS/rest/services/Mars_Geology_feature_layer/FeatureServer",
      kind: "point-in-polygon query",
      status: geology ? "available" : geologyResult.status === "rejected" ? "unavailable" : "no-data",
      value: geology ? `${geology.Unit || "Unit not named"} — ${geology.UnitDesc || "No description provided"}` : null,
      units: "",
      nominalResolution: "Global regional geologic map, scale 1:20,000,000; not a meter-scale surface classification.",
      message: geology
        ? "Unit polygon intersecting the selected coordinate. The map is a regional interpretation, not a direct sample at this point."
        : geologyResult.status === "rejected"
          ? `Geology lookup failed: ${geologyResult.reason?.message || "service unavailable"}`
          : "The geologic map has no polygon covering this coordinate.",
      attributes: geology || undefined,
    },
    ...weatherLayers,
    {
      id: "solar-altitude",
      group: "Derived context",
      name: "Solar altitude proxy",
      source: "Calculated from latitude and Mars obliquity",
      kind: "derived geometry",
      status: "available",
      value: solarNoonContext(lat),
      units: "°",
      nominalResolution: "Point calculation; equinox (solar longitude 0°), local noon, level terrain.",
      message: "Sun altitude above the local horizon at equinox noon. Does not include slope, terrain shadows, clouds, or atmospheric dust.",
    },
    ...plannedLayers,
  ];

  const failures = samples.filter((result) => result.status === "rejected").length;
  const hasAnyReturnedLayer = layers.some((layer) => layer.status === "available" || layer.status === "map-only");
  const resultStatus = center === null || failures
    ? (hasAnyReturnedLayer ? "partial" : "unavailable")
    : "available";
  res.json({
    coordinates: {
      latitude: lat,
      longitude: lon,
      spatialReference: MARS_SPATIAL_REFERENCE,
      coordinateNote: "Coordinates are passed to the image service using WKID 104971; confirm the service product metadata before scientific interpretation.",
    },
    resultStatus,
    errors: sampleErrors,
    queriedAt: new Date().toISOString(),
    layers,
    coverageNote: "Coordinate samples, regional map overlays, and station observations have different coverage and scales. Map-only products are visual context; Gale REMS values are station reports, and missing measurements are not estimated.",
  });
});

module.exports = router;
