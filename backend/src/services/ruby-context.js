// Fetches the same data the Explore panel shows for any place a user asks
// about, not only the one selected on the map. This is what lets Ruby answer
// "how steep is Arsia Mons?" or "how cold is Hellas?" from real measurements.
const { buildPointResponse } = require("../routes/point");
const { lookupCell } = require("../routes/cell");
const { extractPointFacts } = require("./point-narration");

const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_LIMIT = 40;
const cache = new Map();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Terrain, surface, geology and climate for one coordinate, in the shape the
 * narration code already understands.
 *
 * @param {{lat: number, lon: number, name?: string, type?: string, diameterKm?: number}} place
 * @returns {Promise<object|null>} location facts, or null when both services failed
 */
async function fetchPlaceFacts({ lat, lon, name = null, type = null, diameterKm = null }) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.facts;

  // The two services are independent, so one failing still leaves useful data.
  const [pointResult, cellResult] = await Promise.allSettled([
    withTimeout(buildPointResponse(lat, lon), FETCH_TIMEOUT_MS),
    withTimeout(lookupCell(lat, lon), FETCH_TIMEOUT_MS),
  ]);
  const point = pointResult.status === "fulfilled" ? pointResult.value : null;
  const cell = cellResult.status === "fulfilled" ? cellResult.value : null;
  if (!point && !cell) {
    console.error(
      `Ruby could not load map data for ${name || key}: ${pointResult.reason?.message}; ${cellResult.reason?.message}`,
    );
    return null;
  }

  const facts = extractPointFacts(
    { point, cell },
    { lat, lon, title: name, feature: name ? { name, type, diameterKm } : null },
  );
  cache.set(key, { at: Date.now(), facts });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return facts;
}

module.exports = { fetchPlaceFacts };
