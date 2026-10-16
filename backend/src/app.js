const express = require("express");
const app = express();
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../../frontend/public")));

const terrainDirectory = path.resolve(
  __dirname,
  "../../../MarsWalk_data/1.0/02_Processed/CTX/MARSWALK_TERRAIN_CLIPPED",
);
const rasterFiles = {
  elevation_m: "MARSWALK_ELEVATION_20m_CLIPPED.tif",
  slope_degrees: "MARSWALK_SLOPE_20m_CLIPPED.tif",
  roughness_m: "MARSWALK_ROUGHNESS_20m_CLIPPED.tif",
  aspect_degrees: "MARSWALK_ASPECT_20m_CLIPPED.tif",
};
const marsRadiusMeters = 3396190;
const rasterBounds = { xmin: 4573660, ymin: 1079440, xmax: 4605600, ymax: 1109700 };
const noDataValues = new Set([-9999, -9999.0]);
const candidateGdalInfo = [
  process.env.GDALLOCATIONINFO,
  "C:/Program Files/QGIS 3.44.15/bin/gdallocationinfo.exe",
  "C:/Program Files/QGIS 4.2.2/bin/gdallocationinfo.exe",
].filter(Boolean);
const gdalLocationInfo = candidateGdalInfo.find((candidate) => fs.existsSync(candidate)) || "gdallocationinfo";

const footprintPath = path.resolve(__dirname, "../../frontend/public/data/jezero-hirise-footprints.geojson");
let hiriseFeatures = [];
try {
  hiriseFeatures = JSON.parse(fs.readFileSync(footprintPath, "utf8")).features || [];
} catch (error) {
  console.warn(`Jezero HiRISE features could not be loaded: ${error.message}`);
}

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = ((yi > latitude) !== (yj > latitude)) &&
      (longitude < ((xj - xi) * (latitude - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(longitude, latitude, rings) {
  return rings.length > 0 && pointInRing(longitude, latitude, rings[0]) &&
    !rings.slice(1).some((ring) => pointInRing(longitude, latitude, ring));
}

function featureContains(feature, longitude, latitude) {
  const geometry = feature.geometry;
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygon(longitude, latitude, geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((polygon) => pointInPolygon(longitude, latitude, polygon));
  }
  return false;
}

function sampleRaster(filename, easting, northing) {
  const rasterPath = path.join(terrainDirectory, filename);
  const output = execFileSync(
    gdalLocationInfo,
    ["-valonly", "-geoloc", rasterPath, String(easting), String(northing)],
    { encoding: "utf8", timeout: 8000, windowsHide: true },
  ).trim();
  const value = Number(output.split(/\s+/)[0]);
  return Number.isFinite(value) && !noDataValues.has(value) ? value : null;
}

app.get("/api/jezero/sample", (req, res) => {
  const easting = Number(req.query.easting);
  const northing = Number(req.query.northing);
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    return res.status(400).json({ error: "Provide numeric easting and northing coordinates in meters." });
  }
  if (easting < rasterBounds.xmin || easting >= rasterBounds.xmax ||
      northing <= rasterBounds.ymin || northing > rasterBounds.ymax) {
    return res.status(400).json({ error: "The clicked coordinate is outside the Jezero terrain-data extent." });
  }

  const longitude = (easting / marsRadiusMeters) * (180 / Math.PI);
  const latitude = (northing / marsRadiusMeters) * (180 / Math.PI);
  try {
    const terrain = Object.fromEntries(
      Object.entries(rasterFiles).map(([field, filename]) => [field, sampleRaster(filename, easting, northing)]),
    );
    const science = hiriseFeatures
      .filter((feature) => featureContains(longitude, latitude, feature))
      .map((feature) => ({
        id: feature.properties?.id,
        type: "HiRISE observation footprint",
        coveragePercentOfAOI: feature.properties?.coverage_percent ?? null,
        url: `https://www.uahirise.org/${String(feature.properties?.id || "").replace(/_RED$/, "")}`,
      }));
    return res.json({
      region: "Jezero Crater",
      coordinateSystem: "Mars 2000 Equidistant Cylindrical",
      coordinates: { easting_m: easting, northing_m: northing, longitude_east: longitude, latitude_north: latitude },
      terrain,
      terrainResolutionMeters: 20,
      science,
      sources: {
        imagery: "MarsWalk final Jezero mosaic, exported from FInal Map.tif (1 m/pixel output grid)",
        terrain: "MarsWalk processed Jezero terrain rasters; 20 m source grid",
        science: "Selected HiRISE observation footprints; NASA/JPL/University of Arizona",
      },
    });
  } catch (error) {
    console.error("Jezero coordinate query failed:", error.message);
    return res.status(503).json({ error: "Terrain sampling is unavailable. Check that GDAL is installed and the Jezero rasters are present." });
  }
});

app.get("/", (req, res) => {
  res.send("welcome to mars");
});

module.exports = app;
