const { findFeatureInText } = require("./gazetteer");

const MAX_COMMAND_LENGTH = 500;
const ROUTE_INTENT = /\b(routes?|roots?|rout|traverse|paths?|map|directions)\b|\bdraw\s+a?\s+to\b|\bfrom\b.*\bto\b/i;
const ACTION_VERB = /\b(plan|calculate|draw|drawer|create|find|show|map|navigate|guide)\b|\btake\s+me\b|\broute\s+me\b|\bgo\s+to\b|\bhead\s+to\b/i;
const ROUTE_PATTERN = /\bfrom\s+(.+?)\s+to\s+(.+?)(?=$|[,.!?])/i;
const ROUTE_MODES = new Set(["safest", "balanced", "fastest"]);
const SUPPORTED_REGIONS = [
  { name: "Jezero Crater", west: 75.58, south: 16.38, east: 79.58, north: 20.38 },
  { name: "Gale Crater", west: 135.8, south: -7.4, east: 139.8, north: -3.4 },
  { name: "Olympus Mons", west: -135.8, south: 16.65, east: -131.8, north: 20.65 },
  { name: "Valles Marineris", west: -61.2, south: -15.9, east: -57.2, north: -11.9 },
  { name: "Hellas Planitia", west: 68.5, south: -44.4, east: 72.5, north: -40.4 },
  { name: "Elysium Planitia", west: 133.9, south: 2.5, east: 137.9, north: 6.5 },
];

// Common landing sites and aliases use the same coordinates as MarsWalk's
// curated region list. Other named features resolve through the USGS gazetteer.
const PLACE_ALIASES = [
  { names: ["jezero crater", "jezero"], name: "Jezero Crater", lat: 18.44, lon: 77.45 },
  { names: ["gale crater", "gale"], name: "Gale Crater", lat: -5.4, lon: 137.8 },
  { names: ["olympus mons", "olympus"], name: "Olympus Mons", lat: 18.65, lon: -133.8 },
  { names: ["valles marineris", "valles"], name: "Valles Marineris", lat: -13.9, lon: -59.2 },
  { names: ["hellas planitia", "hellas"], name: "Hellas Planitia", lat: -42.4, lon: 70.5 },
  { names: ["elysium planitia", "elysium"], name: "Elysium Planitia", lat: 4.5, lon: 135.9 },
];

function supportedRegion(point) {
  return SUPPORTED_REGIONS.find((region) => point.lon >= region.west && point.lon <= region.east &&
    point.lat >= region.south && point.lat <= region.north);
}

function marsDistanceKm(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3389500 * Math.asin(Math.sqrt(h)) / 1000;
}

function cleanEndpoint(value) {
  return value
    .replace(/\bancient\s+lake\s+bed\b/gi, "Ancient Lakebed")
    .replace(/\blake\s+bed\b/gi, "Lakebed")
    .replace(/\bdelta\s+out\s+crop\b/gi, "Delta Outcrop")
    .replace(/\bwest\s+fan\b/gi, "Western Fan")
    .replace(/\bnorth\s+rim\s+look\s+out\b/gi, "North Rim Lookout")
    .replace(/\b(?:root|roots|rout)\b/gi, (word) => word.toLowerCase() === "roots" ? "routes" : "route")
    .replace(/^\s*(?:the\s+)?/i, "")
    .replace(/\s+(?:crater|region|area|landing site)$/i, "")
    .trim();
}

function resolvePlace(value) {
  const cleaned = cleanEndpoint(value);
  const normalized = cleaned.toLocaleLowerCase();
  for (const place of PLACE_ALIASES) {
    if (place.names.some((name) => name.toLocaleLowerCase() === normalized)) return place;
  }

  const feature = findFeatureInText(cleaned);
  if (!feature) return null;
  return {
    name: feature.name,
    lat: feature.lat,
    lon: feature.lon,
  };
}

/**
 * Deterministic command parser. Ruby's language model never supplies executable
 * actions: only an explicit route request with two resolvable endpoints can
 * produce the allow-listed plan_route action.
 */
function parseRubyAction(rawMessage) {
  if (typeof rawMessage !== "string") return { handled: false };
  const message = rawMessage.trim()
    .replace(/\bdrawer(?:\s+a)?(?=\s+(?:routes?|map|path|directions)\b)/gi, "draw a")
    .replace(/\bdrawer\b/gi, "draw a")
    .replace(/\bancient\s+lake\s+bed\b/gi, "Ancient Lakebed")
    .replace(/\blake\s+bed\b/gi, "Lakebed")
    .replace(/\bdelta\s+out\s+crop\b/gi, "Delta Outcrop")
    .replace(/\bwest\s+fan\b/gi, "Western Fan")
    .replace(/\bnorth\s+rim\s+look\s+out\b/gi, "North Rim Lookout")
    .replace(/\b(?:root|roots|rout)\b/gi, (word) => word.toLowerCase() === "roots" ? "routes" : "route");
  if (!message || message.length > MAX_COMMAND_LENGTH) return { handled: false };

  const isRouteAction = ROUTE_INTENT.test(message) && ACTION_VERB.test(message);
  if (!isRouteAction) return { handled: false };

  const match = message.match(ROUTE_PATTERN);
  if (!match) {
    return {
      handled: true,
      reply: "Tell me the start and destination, for example: “Plan a safest route from Gale Crater to Jezero Crater.”",
    };
  }

  const start = resolvePlace(match[1]);
  const end = resolvePlace(match[2]);
  if (!start || !end) {
    const missing = [!start ? "start" : null, !end ? "destination" : null].filter(Boolean).join(" and ");
    return {
      handled: true,
      reply: `I couldn't resolve the ${missing}. Try a named Mars feature from the route search, such as Gale Crater or Jezero Crater.`,
    };
  }

  if (start.lat === end.lat && start.lon === end.lon) {
    return { handled: true, reply: "Those resolve to the same place. Choose a different start or destination." };
  }

  const startRegion = supportedRegion(start);
  const endRegion = supportedRegion(end);
  if (!startRegion || startRegion !== endRegion) {
    return {
      handled: true,
      reply: "I can plan routes within one regional map area: Jezero, Gale, Olympus Mons, Valles Marineris, Hellas, or Elysium. Choose both endpoints inside the same area.",
    };
  }
  if (marsDistanceKm(start, end) > 100) {
    return { handled: true, reply: `That route is longer than the 100 km limit for the ${startRegion.name} terrain grid. Choose closer endpoints.` };
  }

  const modeMatch = message.match(/\b(safest|balanced|fastest)\b/i);
  const mode = modeMatch ? modeMatch[1].toLocaleLowerCase() : "balanced";
  if (!ROUTE_MODES.has(mode)) return { handled: true, reply: "Choose safest, balanced, or fastest route priority." };

  return {
    handled: true,
    action: {
      type: "plan_route",
      mode,
      start,
      end,
    },
  };
}

module.exports = { parseRubyAction };
