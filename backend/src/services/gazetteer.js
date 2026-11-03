// Server-side index of named Mars features (USGS/IAU gazetteer, the same file
// the map loads), used to tell whether a question is about the place the user
// has selected or about some other place.
//
// This matters for correctness: with Jezero selected, "how steep is Arsia
// Mons?" must not be answered with Jezero's slope.
const fs = require("fs");
const path = require("path");

const FILE = path.resolve(__dirname, "../../../frontend/public/data/mars-locations.json");
const MIN_NAME_LENGTH = 4; // shorter names collide with ordinary words
const MARS_RADIUS_KM = 3389.5;

let features = null;

function load() {
  if (features) return features;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const byName = new Map();
    for (const feature of data.features || []) {
      const name = typeof feature.name === "string" ? feature.name.trim() : "";
      if (name.length < MIN_NAME_LENGTH) continue;
      if (!Number.isFinite(feature.lat) || !Number.isFinite(feature.lon)) continue;
      const key = name.toLowerCase();
      const existing = byName.get(key);
      // Names are occasionally reused; the larger feature is the likelier target.
      if (!existing || (feature.diameterKm || 0) > (existing.diameterKm || 0)) {
        byName.set(key, {
          key,
          name,
          lat: feature.lat,
          lon: feature.lon,
          type: feature.type || null,
          diameterKm: Number.isFinite(feature.diameterKm) ? feature.diameterKm : null,
        });
      }
    }
    features = [...byName.values()];
  } catch (error) {
    console.error("Could not load the place-name index:", error.message);
    features = [];
  }
  return features;
}

const isLetter = (char) => Boolean(char) && /\p{L}/u.test(char);

/**
 * Longest named feature mentioned in the text, matched on word boundaries so
 * that "Gale" does not match inside "Galena".
 */
function findFeatureInText(text) {
  const lower = String(text).toLowerCase();
  let best = null;
  for (const feature of load()) {
    let from = 0;
    for (;;) {
      const index = lower.indexOf(feature.key, from);
      if (index < 0) break;
      const before = lower[index - 1];
      const after = lower[index + feature.key.length];
      // "Jezero's" should still match, so an apostrophe-s may follow.
      const afterOk = !isLetter(after) || (after === "'" ? true : false);
      if (!isLetter(before) && afterOk) {
        if (!best || feature.key.length > best.key.length) best = feature;
        break;
      }
      from = index + 1;
    }
  }
  return best;
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(((bLon - aLon + 180) % 360 + 360) % 360 - 180);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Every named feature mentioned in the text, with where it was found, so a
 * question such as "compare Jezero and Gale" can resolve both places.
 *
 * @returns {{feature: object, start: number, end: number}[]}
 */
function findFeaturesInText(text) {
  const lower = String(text).toLowerCase();
  const found = [];
  for (const feature of load()) {
    let from = 0;
    for (;;) {
      const index = lower.indexOf(feature.key, from);
      if (index < 0) break;
      const before = lower[index - 1];
      const after = lower[index + feature.key.length];
      if (!isLetter(before) && (!isLetter(after) || after === "'")) {
        found.push({ feature, start: index, end: index + feature.key.length });
        break;
      }
      from = index + 1;
    }
  }
  return found;
}

module.exports = { findFeatureInText, findFeaturesInText, distanceKm };
