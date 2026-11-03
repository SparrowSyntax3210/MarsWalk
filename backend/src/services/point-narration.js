// Turns a selected Explore location into a spoken briefing.
//
// Same discipline as route-narration.js: every value is read from /api/point or
// /api/cell, and the plain-language bands below are copied from the thresholds
// map.js already shows on screen, so Ruby's words and the panel never disagree.
// Missing data is reported as missing, never estimated.

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const kelvinToC = (kelvin) => kelvin - 273.15;

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const compassName = (deg) =>
  COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// IAU descriptor terms are Latin. Spoken aloud, "a mons about 610 kilometers
// across" is worse than "a volcano", so the common Mars terms get plain
// English. Anything unrecognised falls through unchanged.
const FEATURE_TYPE_WORDS = {
  crater: "crater",
  mons: "volcano",
  montes: "mountain range",
  tholus: "small volcano",
  patera: "volcanic crater",
  planitia: "plain",
  planum: "plateau",
  terra: "highland region",
  vallis: "valley",
  valles: "canyon system",
  chasma: "chasm",
  chaos: "broken terrain",
  labyrinthus: "canyon network",
  fossa: "trough",
  fossae: "troughs",
  dorsum: "ridge",
  dorsa: "ridges",
  rupes: "scarp",
  mensa: "flat-topped mesa",
  colles: "hills",
  cavus: "hollow",
  unda: "dune field",
  undae: "dune fields",
  scopulus: "lobate scarp",
  sulci: "grooved terrain",
};

function featureTypeWord(type) {
  if (!type) return null;
  const first = String(type).split(",")[0].trim().toLowerCase();
  if (!first) return null;
  return FEATURE_TYPE_WORDS[first] || first;
}

/**
 * Makes a display string from /api/point safe to speak: minus signs, degree
 * symbols and unit abbreviations are all mangled by the TTS text frontend.
 */
function speakRawValue(value, units) {
  let text = `${value}`.trim();
  if (!text) return null;
  text = text
    .replace(/(^|[\s(])-(\d)/g, "$1minus $2")
    .replace(/\s*°\s*C\b/gi, " degrees Celsius")
    .replace(/\s*°\s*/g, " degrees ");
  const unitWords = {
    Pa: "pascals",
    "m/s": "meters per second",
    "°C": "degrees Celsius",
    K: "kelvin",
  };
  const unit = units ? unitWords[units] || units : "";
  return `${text}${unit ? ` ${unit}` : ""}`.replace(/\s+/g, " ").trim();
}

// --- Bands mirrored from map.js so wording matches the panel ----------------
function slopeClass(deg) {
  if (deg < 5) return "gentle";
  if (deg < 15) return "moderate";
  if (deg < 25) return "steep";
  return "very steep";
}
function thermalInertiaClass(tiu) {
  if (tiu < 150) return "dust dominated";
  if (tiu < 400) return "sand or mixed fines";
  if (tiu < 700) return "coarse, crusted or rocky";
  return "rock dominated";
}
function dustOpacityClass(tau) {
  if (tau < 0.5) return "clear sky";
  if (tau < 1) return "hazy";
  if (tau < 2) return "dusty";
  return "dust storm level";
}

// --- Speech formatting ------------------------------------------------------
// No thousands separators: the TTS frontend splits on commas.
function speakMeters(value) {
  if (!isNum(value)) return null;
  return `${Math.round(value)} meters`;
}
function speakDistanceKm(km) {
  if (!isNum(km)) return null;
  if (km < 1) return `${Math.round(km * 1000)} meters`;
  return `${Number(km.toFixed(km < 100 ? 1 : 0))} kilometers`;
}
function speakDegrees(deg) {
  if (!isNum(deg)) return null;
  const value = Number(deg.toFixed(deg < 10 ? 1 : 0));
  return `${value} ${value === 1 ? "degree" : "degrees"}`;
}
function speakCelsius(kelvin) {
  if (!isNum(kelvin)) return null;
  const celsius = Math.round(kelvinToC(kelvin));
  return `${celsius < 0 ? `minus ${Math.abs(celsius)}` : celsius} degrees Celsius`;
}
function speakLatLon(lat, lon) {
  if (!isNum(lat) || !isNum(lon)) return null;
  const latPart = `${Number(Math.abs(lat).toFixed(2))} ${lat >= 0 ? "north" : "south"}`;
  const lonPart = `${Number(Math.abs(lon).toFixed(2))} ${lon >= 0 ? "east" : "west"}`;
  return `${latPart} and ${lonPart}`;
}

function joinList(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

function sentence(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

// --- Fact extraction -------------------------------------------------------

/** Reads an available layer value from an /api/point response. */
function layerValue(point, id) {
  const layer = point?.layers?.find((entry) => entry.id === id);
  if (!layer || layer.status !== "available") return null;
  return isNum(layer.value) ? layer.value : null;
}

function layerRaw(point, id) {
  const layer = point?.layers?.find((entry) => entry.id === id);
  return layer && layer.status === "available" ? layer : null;
}

/**
 * Collects everything narratable about a selected location.
 *
 * @param {object} sources `{ point, cell }` as returned by /api/point and /api/cell
 * @param {object} context UI-owned labels: title, feature, region, nearest feature
 */
function extractPointFacts(sources = {}, context = {}) {
  const point = sources.point && !sources.point.error ? sources.point : null;
  const cellResponse = sources.cell && !sources.cell.error ? sources.cell : null;
  const cell = cellResponse?.cell || null;
  const value = (key) => (cell && isNum(Number(cell[key])) ? Number(cell[key]) : null);

  // Elevation precedence matches renderSelectionData(): the ~200 m sample
  // first, then the 1 km cell.
  const elevationFine = layerValue(point, "elevation");
  const elevationCell = value("elevation_m");

  const geologyLayer = layerRaw(point, "regional-geology");
  const geologyFromLayer = geologyLayer?.attributes
    ? {
        unit: geologyLayer.attributes.Unit || null,
        description: geologyLayer.attributes.UnitDesc || null,
      }
    : null;
  const geologyFromCell = cellResponse?.geology
    ? { unit: cellResponse.geology.code || null, description: cellResponse.geology.description || null }
    : null;
  const geology = geologyFromLayer || geologyFromCell;

  // REMS only reports within the Gale context radius.
  const weather = ["rems-air-temperature", "rems-ground-temperature", "rems-pressure", "rems-dust-opacity", "rems-wind"]
    .map((id) => layerRaw(point, id))
    .filter(Boolean)
    .map((layer) => ({ name: layer.name, value: layer.value, units: layer.units || "" }));

  return {
    lat: isNum(Number(context.lat)) ? Number(context.lat) : null,
    lon: isNum(Number(context.lon)) ? Number(context.lon) : null,
    title: context.title || null,
    featureName: context.feature?.name || null,
    featureType: context.feature?.type || null,
    featureDiameterKm: isNum(Number(context.feature?.diameterKm)) ? Number(context.feature.diameterKm) : null,
    regionName: context.region?.name || null,
    regionTagline: context.region?.tagline || null,
    nearest: context.nearest
      ? {
          name: context.nearest.name || null,
          distanceKm: isNum(Number(context.nearest.distanceKm)) ? Number(context.nearest.distanceKm) : null,
          bearingDeg: isNum(Number(context.nearest.bearingDeg)) ? Number(context.nearest.bearingDeg) : null,
          inside: Boolean(context.nearest.inside),
        }
      : null,

    elevationM: isNum(elevationFine) ? elevationFine : elevationCell,
    elevationScale: isNum(elevationFine) ? "fine" : isNum(elevationCell) ? "cell" : null,
    slopeDeg: layerValue(point, "slope"),
    slopeCellDeg: value("slope_deg"),
    slopeGradePct: value("slope_grade_pct"),
    aspectDeg: value("aspect_deg"),
    roughnessM: layerValue(point, "roughness"),
    reliefM: value("roughness_3x3_range_m"),

    thermalInertia: value("tes_ti_mean_tiu"),
    thermalInertiaDay: value("tes_ti_day_tiu"),
    thermalInertiaNight: value("tes_ti_night_tiu"),
    duneHit: cell && Number(cell.dune_hit) === 1,
    duneDistanceKm: value("dune_distance_km"),
    craterEdgeKm: value("crater_edge_distance_km"),
    craterId: cell?.nearest_crater_id || null,

    geology,
    surfaceTempK: value("mcd_tsurf"),
    airTempK: value("mcd_temp"),
    pressurePa: value("mcd_ps"),
    dustTau: value("mcd_tau_pref_gcm"),
    windSpeed: value("mcd_wind_speed"),
    windToDeg: value("mcd_wind_direction_to_deg"),
    waterVapourKgM2: value("mcd_col_h2ovapor"),
    mcdContext: cellResponse?.mcdContext || null,

    solarAltitudeDeg: layerValue(point, "solar-altitude"),
    weather,
    cellDistanceKm: isNum(Number(cellResponse?.cellDistanceKm)) ? Number(cellResponse.cellDistanceKm) : null,
    hasPoint: Boolean(point),
    hasCell: Boolean(cell),
  };
}

// --- Narration -------------------------------------------------------------

function placeSentences(facts) {
  const lines = [];

  // Where you are, named as specifically as the gazetteer allows.
  let where;
  if (facts.featureName) {
    const typeWord = featureTypeWord(facts.featureType);
    const type = typeWord ? `, a ${typeWord}` : "";
    const size = isNum(facts.featureDiameterKm) && facts.featureDiameterKm > 0
      ? ` about ${speakDistanceKm(facts.featureDiameterKm)} across`
      : "";
    where = `You are looking at ${facts.featureName}${type}${size}`;
  } else if (facts.regionName) {
    where = `You are looking at ${facts.regionName}`;
  } else if (facts.nearest?.name && isNum(facts.nearest.distanceKm)) {
    // Without a bearing the phrase needs "from", not "of".
    const direction = isNum(facts.nearest.bearingDeg)
      ? ` ${compassName(facts.nearest.bearingDeg)} of`
      : " from";
    where = facts.nearest.inside
      ? `You are inside ${facts.nearest.name}`
      : `You are ${speakDistanceKm(facts.nearest.distanceKm)}${direction} ${facts.nearest.name}`;
  } else {
    where = "You have selected an unnamed point";
  }
  const coords = speakLatLon(facts.lat, facts.lon);
  lines.push(sentence(`${where}${coords ? `, at ${coords}` : ""}`));

  if (isNum(facts.elevationM)) {
    const relation = facts.elevationM >= 0 ? "above" : "below";
    lines.push(
      sentence(
        `The ground here sits ${speakMeters(Math.abs(facts.elevationM))} ${relation} the Mars datum`,
      ),
    );
  } else {
    lines.push(sentence("No elevation value was returned for this point"));
  }

  // Say so plainly rather than delivering a briefing that describes nothing.
  if (!facts.hasPoint && !facts.hasCell) {
    lines.push(
      sentence(
        "I could not reach the terrain or climate services for this location, so there is nothing further I can tell you about it",
      ),
    );
  }
  return lines.filter(Boolean);
}

function terrainSection(facts) {
  const lines = [];
  // The fine (~200 m) slope and the cell grade come from different grids, so
  // quoting both in one breath would imply they describe the same measurement.
  const usingFineSlope = isNum(facts.slopeDeg);
  const slope = usingFineSlope ? facts.slopeDeg : facts.slopeCellDeg;
  if (isNum(slope)) {
    const grade = !usingFineSlope && isNum(facts.slopeGradePct)
      ? `, a grade of about ${Number(facts.slopeGradePct.toFixed(1))} percent`
      : "";
    lines.push(
      sentence(`The slope is ${speakDegrees(slope)}, which counts as ${slopeClass(slope)}${grade}`),
    );
  }
  if (isNum(facts.aspectDeg)) {
    lines.push(sentence(`The ground falls away toward the ${compassName(facts.aspectDeg)}`));
  }
  if (isNum(facts.reliefM)) {
    lines.push(
      sentence(
        `Across the surrounding three by three kilometers the elevation range is ${speakMeters(facts.reliefM)}`,
      ),
    );
  } else if (isNum(facts.roughnessM)) {
    lines.push(sentence(`Local elevation variation is about ${speakMeters(facts.roughnessM)}`));
  }
  return lines.filter(Boolean);
}

function surfaceSection(facts) {
  const lines = [];
  if (isNum(facts.thermalInertia)) {
    lines.push(
      sentence(
        `Thermal inertia is about ${Math.round(facts.thermalInertia)} units, which suggests a ${thermalInertiaClass(facts.thermalInertia)} surface`,
      ),
    );
    // The low end means loose dust, which matters for footing and wheels.
    if (facts.thermalInertia < 150) {
      lines.push(sentence("Values this low usually mean deep, loose dust, so expect poor footing"));
    }
  }
  if (facts.duneHit) {
    lines.push(sentence("This cell falls inside a mapped dune field"));
  } else if (isNum(facts.duneDistanceKm)) {
    lines.push(
      sentence(`The nearest mapped dunes are ${speakDistanceKm(facts.duneDistanceKm)} away`),
    );
  }
  if (isNum(facts.craterEdgeKm)) {
    lines.push(
      sentence(
        facts.craterEdgeKm === 0
          ? "You are inside a catalogued crater"
          : `The nearest catalogued crater rim is ${speakDistanceKm(facts.craterEdgeKm)} away`,
      ),
    );
  }
  return lines.filter(Boolean);
}

function geologySection(facts) {
  if (!facts.geology?.unit && !facts.geology?.description) return [];
  const lines = [];
  const label = [facts.geology.unit, facts.geology.description].filter(Boolean).join(", ");
  lines.push(sentence(`The mapped geologic unit here is ${label}`));

  // The unit names carry their epoch, which is the most interesting part.
  const eras = ["Amazonian", "Hesperian", "Noachian"].filter((era) => label.includes(era));
  if (eras.length) {
    const ages = {
      Amazonian: "less than about three billion years old",
      Hesperian: "roughly three to three point seven billion years old",
      Noachian: "more than three point seven billion years old",
    };
    lines.push(sentence(`That makes this terrain ${ages[eras[0]]}`));
  }
  return lines.filter(Boolean);
}

function climateSection(facts) {
  const lines = [];
  const surface = speakCelsius(facts.surfaceTempK);
  const air = speakCelsius(facts.airTempK);
  if (surface && air) {
    lines.push(sentence(`The model gives a surface temperature of ${surface} and an air temperature of ${air}`));
  } else if (surface) {
    lines.push(sentence(`The model gives a surface temperature of ${surface}`));
  }
  if (isNum(facts.pressurePa)) {
    lines.push(
      sentence(
        `Surface pressure is about ${Math.round(facts.pressurePa)} pascals, well under one percent of Earth's`,
      ),
    );
  }
  if (isNum(facts.dustTau)) {
    lines.push(
      sentence(
        `Dust opacity is ${Number(facts.dustTau.toFixed(2))}, which is ${dustOpacityClass(facts.dustTau)}`,
      ),
    );
  }
  if (isNum(facts.windSpeed)) {
    const toward = isNum(facts.windToDeg) ? ` toward the ${compassName(facts.windToDeg)}` : "";
    lines.push(sentence(`Wind runs at about ${Number(facts.windSpeed.toFixed(1))} meters per second${toward}`));
  }
  if (isNum(facts.waterVapourKgM2)) {
    lines.push(
      sentence(
        `The water vapour column is ${Number((facts.waterVapourKgM2 * 1000).toFixed(1))} precipitable micrometers`,
      ),
    );
  }
  return lines.filter(Boolean);
}

function sunSection(facts) {
  if (!isNum(facts.solarAltitudeDeg)) return [];
  return [
    sentence(
      `At equinox noon on level ground the sun would stand ${speakDegrees(facts.solarAltitudeDeg)} above the horizon`,
    ),
  ].filter(Boolean);
}

function weatherSection(facts) {
  if (!facts.weather.length) return [];
  const lines = [
    sentence("Curiosity's weather station is close enough to report for this area"),
  ];
  facts.weather.slice(0, 3).forEach((entry) => {
    const spoken = speakRawValue(entry.value, entry.units);
    if (spoken) lines.push(sentence(`${entry.name.toLowerCase()} is ${spoken}`));
  });
  return lines.filter(Boolean);
}

/** Caveats Ruby volunteers, because a spoken number sounds more certain than it is. */
function caveatSection(facts) {
  const lines = [];
  const scales = [];
  if (facts.elevationScale === "fine") scales.push("elevation and slope come from a roughly 200 meter grid");
  else if (facts.elevationScale === "cell") scales.push("elevation comes from the one kilometer cell grid");
  if (facts.hasCell) scales.push("surface and climate values come from one kilometer cells");
  if (scales.length) lines.push(sentence(joinList(scales)));

  if (facts.surfaceTempK || facts.dustTau || facts.windSpeed) {
    const when = facts.mcdContext?.solarLongitudeDeg !== undefined && facts.mcdContext?.solarLongitudeDeg !== null
      ? ` at solar longitude ${Math.round(Number(facts.mcdContext.solarLongitudeDeg))} degrees and ${facts.mcdContext.localTimeHours} hours local time`
      : "";
    lines.push(
      sentence(
        `Temperature, wind and dust are climate model values${when}, not a forecast or a measurement`,
      ),
    );
  }
  if (facts.geology) {
    lines.push(
      sentence(
        "The geologic unit comes from a global map at one to twenty million scale, so it is a regional interpretation rather than a sample of this spot",
      ),
    );
  }
  if (isNum(facts.duneDistanceKm) && !facts.duneHit) {
    lines.push(
      sentence("Dune mapping is incomplete, so no mapped dunes nearby does not prove there are none"),
    );
  }
  return lines.filter(Boolean);
}

/**
 * Builds the spoken place briefing.
 *
 * Returns a short `summary` plus labelled `sections`, because /speak caps one
 * utterance at 600 characters and a full description of a location runs well
 * past that. The caller decides what to read aloud.
 */
function narratePoint(facts) {
  const summary = placeSentences(facts).join(" ");

  const sections = [
    { id: "terrain", label: "Terrain", lines: terrainSection(facts) },
    { id: "surface", label: "Surface and hazards", lines: surfaceSection(facts) },
    { id: "geology", label: "Geology", lines: geologySection(facts) },
    { id: "climate", label: "Climate", lines: climateSection(facts) },
    { id: "sun", label: "Sunlight", lines: sunSection(facts) },
    { id: "weather", label: "Rover weather", lines: weatherSection(facts) },
    { id: "caveats", label: "How to read this", lines: caveatSection(facts) },
  ]
    .filter((section) => section.lines.length)
    .map(({ id, label, lines }) => ({ id, label, text: lines.join(" ") }));

  return {
    summary,
    sections,
    text: [summary, ...sections.map((section) => section.text)].filter(Boolean).join(" "),
  };
}

module.exports = { extractPointFacts, narratePoint, featureTypeWord };
