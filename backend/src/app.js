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
const galeTerrainDirectory = path.resolve(
  __dirname,
  "../../../MarsWalk_data/1.0/07_WEB_EXPORT/gale",
);
const galePublicDataDirectory = path.resolve(__dirname, "../../frontend/public/data");
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

let galeScienceFeatures = [];
try {
  const sciencePath = path.join(galePublicDataDirectory, "gale-science.json");
  galeScienceFeatures = JSON.parse(fs.readFileSync(sciencePath, "utf8")).features || [];
} catch (error) {
  console.warn(`Gale APXS target features could not be loaded: ${error.message}`);
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

function sampleRaster(filename, easting, northing, directory = terrainDirectory) {
  const rasterPath = path.join(directory, filename);
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

const galeRasterFiles = {
  elevation_m: "gale_elevation_mola_463m.tif",
  slope_degrees: "gale_slope_mola_463m.tif",
  roughness_m: "gale_roughness_mola_463m.tif",
  aspect_degrees: "gale_aspect_mola_463m.tif",
};
const galeBounds = {
  xmin: 8061358.863169648,
  ymin: -474197.58018645,
  xmax: 8298457.653262872,
  ymax: -237098.790093225,
};
const galeTerrainResolutionMeters = 463.0577;

app.get("/api/gale/sample", (req, res) => {
  const easting = Number(req.query.easting);
  const northing = Number(req.query.northing);
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    return res.status(400).json({ error: "Provide numeric easting and northing coordinates in meters." });
  }
  if (easting < galeBounds.xmin || easting >= galeBounds.xmax ||
      northing <= galeBounds.ymin || northing > galeBounds.ymax) {
    return res.status(400).json({ error: "The clicked coordinate is outside the Gale map extent." });
  }

  const longitude = (easting / marsRadiusMeters) * (180 / Math.PI);
  const latitude = (northing / marsRadiusMeters) * (180 / Math.PI);
  try {
    const terrain = Object.fromEntries(
      Object.entries(galeRasterFiles).map(([field, filename]) => [
        field,
        sampleRaster(filename, easting, northing, galeTerrainDirectory),
      ]),
    );
    const nearby = galeScienceFeatures
      .map((feature) => {
        const properties = feature.properties || {};
        const dx = Number(properties.easting_m) - easting;
        const dy = Number(properties.northing_m) - northing;
        return { properties, distance_m: Math.hypot(dx, dy) };
      })
      .filter((candidate) => Number.isFinite(candidate.distance_m) && candidate.distance_m <= 150)
      .sort((a, b) => a.distance_m - b.distance_m);
    const seenTargets = new Set();
    const science = nearby
      .filter(({ properties }) => {
        const key = `${properties.target}|${properties.waypoint}`;
        if (seenTargets.has(key)) return false;
        seenTargets.add(key);
        return true;
      })
      .slice(0, 3)
      .map(({ properties, distance_m }) => ({
        id: properties.id,
        target: properties.target,
        waypoint: properties.waypoint,
        sol: properties.sol,
        stratigraphicFormation: properties.stratigraphicFormation,
        stratigraphicMember: properties.stratigraphicMember,
        chemistry: properties.chemistry,
        distance_m,
        sourceUrl: properties.sourceUrl,
      }));

    return res.json({
      region: "Gale Crater",
      coordinateSystem: "Mars 2015 Ocentric Equidistant Cylindrical, east-positive",
      coordinates: { easting_m: easting, northing_m: northing, longitude_east: longitude, latitude_north: latitude },
      terrain,
      terrainResolutionMeters: galeTerrainResolutionMeters,
      terrainResolutionText: "MOLA terrain is about 463 m per cell. Slope, aspect and 3×3 elevation-range roughness are derived from that grid; it does not resolve metre-scale hazards or establish a foot route as safe.",
      science,
      sources: {
        imagery: "Caltech Bruce Murray Laboratory Global CTX Mosaic V01, tile E136_N-08",
        terrain: "NASA MGS MOLA MEGDR PDS product megt00n090hb; regional display and derivatives at about 463 m per cell",
        science: "NASA Trek Curiosity traverse geometry and NASA PDS Geosciences APXS target summaries through sol 3712",
      },
    });
  } catch (error) {
    console.error("Gale coordinate query failed:", error.message);
    return res.status(503).json({ error: "Gale terrain sampling is unavailable. Check that the prepared MOLA rasters and GDAL are present." });
  }
});

app.get("/", (req, res) => {
  res.send("welcome to mars");
});

module.exports = app;
