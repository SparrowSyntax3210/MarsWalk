// Shared Mars elevation sampler used by /api/elevation and the Ruby assistant.
// The ArcGIS MDEM200M service no longer exposes REST getSamples (it returns
// 404), so this delegates to the LERC tile sampler in routes/point.js.
const { sampleElevation } = require("../routes/point");

const ELEVATION_SOURCE = "Esri OnMars MDEM200M ImageServer";

function isValidCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180
  );
}

/**
 * Samples the Mars DEM at a coordinate.
 * @returns {Promise<number>} elevation in metres relative to the Mars datum
 * @throws if the tile request fails or no pixel is available
 */
async function sampleMarsElevation(lat, lon) {
  const elevation = await sampleElevation(lat, lon);
  if (!Number.isFinite(elevation)) {
    throw new Error("No elevation pixel available for this point");
  }
  return elevation;
}

module.exports = { sampleMarsElevation, isValidCoordinate, ELEVATION_SOURCE };
