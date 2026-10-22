const express = require("express");

const router = express.Router();
const DEM_SAMPLE_URL =
  "https://astro.arcgis.com/arcgis/rest/services/OnMars/MDEM200M/ImageServer/getSamples";
const REQUEST_TIMEOUT_MS = 12_000;
const MARS_SPATIAL_REFERENCE = 104971;

function parseCoordinates(query) {
  if (typeof query.lat !== "string" || typeof query.lon !== "string") {
    return null;
  }

  const lat = Number(query.lat);
  const lon = Number(query.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 || lat > 90 ||
    lon < -180 || lon > 180
  ) {
    return null;
  }

  return { lat, lon };
}

router.get("/", async (req, res) => {
  const coordinates = parseCoordinates(req.query);
  if (!coordinates) {
    return res.status(400).json({
      error: "Valid latitude (-90 to 90) and longitude (-180 to 180) are required.",
    });
  }

  const { lat, lon } = coordinates;
  const params = new URLSearchParams({
    geometry: JSON.stringify({
      x: lon,
      y: lat,
      spatialReference: { wkid: MARS_SPATIAL_REFERENCE },
    }),
    geometryType: "esriGeometryPoint",
    returnFirstValueOnly: "true",
    f: "json",
  });

  try {
    const response = await fetch(`${DEM_SAMPLE_URL}?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`ArcGIS getSamples returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error.message || "ArcGIS returned an error");
    }

    const sampleValue = payload.samples?.[0]?.value;
    const elevation = Number.parseFloat(sampleValue);
    if (!Number.isFinite(elevation)) {
      throw new Error("ArcGIS returned no elevation sample for this point");
    }

    return res.json({
      elevation,
      source: "Esri OnMars MDEM200M ImageServer",
      measurementType: "sampled-raster",
      units: "m",
    });
  } catch (error) {
    console.error("Mars DEM lookup failed:", error.message);
    return res.status(502).json({
      error: "The elevation service could not return a value for this coordinate.",
      source: "Esri OnMars MDEM200M ImageServer",
    });
  }
});

module.exports = router;
