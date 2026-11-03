const express = require("express");
const {
  sampleMarsElevation,
  isValidCoordinate,
  ELEVATION_SOURCE,
} = require("../services/mars-elevation");

const router = express.Router();

function parseCoordinates(query) {
  if (typeof query.lat !== "string" || typeof query.lon !== "string") {
    return null;
  }

  const lat = Number(query.lat);
  const lon = Number(query.lon);
  return isValidCoordinate(lat, lon) ? { lat, lon } : null;
}

router.get("/", async (req, res) => {
  const coordinates = parseCoordinates(req.query);
  if (!coordinates) {
    return res.status(400).json({
      error: "Valid latitude (-90 to 90) and longitude (-180 to 180) are required.",
    });
  }

  try {
    const elevation = await sampleMarsElevation(coordinates.lat, coordinates.lon);
    return res.json({
      elevation,
      source: ELEVATION_SOURCE,
      measurementType: "sampled-raster",
      units: "m",
    });
  } catch (error) {
    console.error("Mars DEM lookup failed:", error.message);
    return res.status(502).json({
      error: "The elevation service could not return a value for this coordinate.",
      source: ELEVATION_SOURCE,
    });
  }
});

module.exports = router;
