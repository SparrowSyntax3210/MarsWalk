// Ruby's brain: real data and an AI model working together.
//
// Every question goes through two stages.
//
//   RETRIEVE  Work out which places the question is about (the one selected on
//             the map, any place named in the question, or explicit
//             coordinates) and fetch the same measured data the Explore panel
//             shows for each. Add vetted Mars facts and map-term definitions
//             that match.
//
//   COMPOSE   Hand all of that to the AI model, which writes the answer. The
//             data is ground truth for measured values; the model adds context
//             from its own knowledge. Numbers with units in the reply are
//             checked against the data, and a changed number triggers one
//             retry and then an exact data-only answer instead.
//
// The data-only answer is also what Ruby gives when no AI key is configured or
// every model is down, and a built-in fallback message covers the rest, so the
// chat never goes blank.
const { sampleMarsElevation, isValidCoordinate } = require("./mars-elevation");
const { extractPointFacts, narratePoint, featureTypeWord } = require("./point-narration");
const { findFeaturesInText, distanceKm } = require("./gazetteer");
const { fetchPlaceFacts } = require("./ruby-context");
const openrouter = require("./openrouter");
const {
  describeTarget,
  buildSystemPrompt,
  sanitizeHistory,
  cleanModelText,
  findUngroundedNumbers,
  toSpeech,
} = require("./ruby-prompt");

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

// Short aliases people actually type. Anything else goes through the gazetteer.
const NAMED_PLACES = [
  { names: ["jezero"], label: "Jezero Crater", lat: 18.38, lon: 77.58 },
  { names: ["olympus mons", "olympus"], label: "Olympus Mons", lat: 18.65, lon: -133.8 },
  { names: ["gale"], label: "Gale Crater", lat: -5.4, lon: 137.8 },
  { names: ["hellas"], label: "Hellas Planitia", lat: -42.4, lon: 70.5 },
  { names: ["valles marineris", "valles"], label: "Valles Marineris", lat: -13.9, lon: -59.2 },
  { names: ["elysium"], label: "Elysium Planitia", lat: 4.5, lon: 135.9 },
  { names: ["utopia"], label: "Utopia Planitia", lat: 46.7, lon: 117.5 },
];

const MARS_FACTS = [
  { keywords: ["gravity", "weigh", "weight"], answer: "Gravity on Mars is about 3.7 meters per second squared. That is roughly 38 percent of Earth's, so a 100 kilogram load would feel like 38 kilograms." },
  { keywords: ["sol", "rotation", "how long is a day", "day length"], answer: "A Martian day is called a sol. It lasts 24 hours, 39 minutes and 35 seconds, just a little longer than an Earth day." },
  { keywords: ["year", "orbit", "season"], answer: "A year on Mars lasts about 687 Earth days. Because the orbit is tilted and elliptical, Mars has seasons, and they are uneven in length." },
  { keywords: ["temperature", "cold", "hot", "weather", "warm"], answer: "Mars is cold. The average temperature is around minus 63 degrees Celsius. It can drop below minus 120 at the poles and reach about 20 degrees at the equator on a summer afternoon." },
  { keywords: ["atmosphere", "air", "breathe", "oxygen", "pressure"], answer: "The Martian atmosphere is about 95 percent carbon dioxide, and its surface pressure is less than one percent of Earth's. You cannot breathe it, so a pressurised suit is always required." },
  { keywords: ["red", "colour", "color", "rust"], answer: "Mars looks red because its dust and rocks are rich in iron oxide, which is basically rust." },
  { keywords: ["moon", "moons", "phobos", "deimos"], answer: "Mars has two small moons, Phobos and Deimos. Phobos is slowly spiralling inward and may break apart in tens of millions of years." },
  { keywords: ["how far", "distance from the sun", "distance from earth"], answer: "Mars orbits the Sun at an average of about 228 million kilometers. Its distance from Earth ranges from about 55 to 400 million kilometers." },
  { keywords: ["signal", "delay", "communicat", "radio"], answer: "A radio signal takes between about 3 and 22 minutes to travel between Earth and Mars, depending on where the planets are. That is why surface crews need to plan with little real-time help from Earth." },
  { keywords: ["radius", "diameter", "how big"], answer: "Mars has a radius of about 3390 kilometers, a little over half the size of Earth." },
  { keywords: ["water", "ice"], answer: "Mars has water ice at its polar caps and buried under the surface at mid latitudes. Liquid water is not stable on the surface today because the pressure is so low." },
  { keywords: ["dust storm", "storm"], answer: "Mars has frequent dust storms. Some grow to cover the whole planet for weeks, which lowers solar power and visibility for surface operations." },
  { keywords: ["olympus"], answer: "Olympus Mons is the tallest volcano in the solar system. It rises roughly 22 kilometers above the Mars datum and is about 600 kilometers wide." },
  { keywords: ["valles", "canyon"], answer: "Valles Marineris is a canyon system about 4000 kilometers long and up to 7 kilometers deep." },
  { keywords: ["jezero", "perseverance", "delta"], answer: "Jezero is a crater about 45 kilometers wide that once held a lake. NASA's Perseverance rover landed there in February 2021 to study its ancient river delta." },
  { keywords: ["radiation"], answer: "Mars has no global magnetic field and a thin atmosphere, so surface radiation is much higher than on Earth. Long EVAs need radiation planning." },
];

// Terms the map shows. Wording of the bands matches the thresholds in map.js so
// the explanation and the panel never disagree. `topic` links a term to a
// section of the selected-location briefing, so the local value can be added.
const GLOSSARY = [
  { pattern: /\bslopes?\b/i, topic: "terrain", answer: "Slope is how steeply the ground tilts, in degrees. Zero is flat and ninety would be a vertical wall. Under 5 degrees counts as gentle, 5 to 15 moderate, 15 to 25 steep, and above 25 very steep." },
  { pattern: /\bthermal inertia\b|\btiu\b/i, topic: "surface", answer: "Thermal inertia measures how quickly the ground heats up and cools down. Fine dust changes temperature fast, so it scores low, while solid rock holds its heat and scores high. Orbiters use it to tell loose dust from rock. Below about 150 is dust dominated and above about 700 is rock dominated." },
  { pattern: /\bdatum\b/i, topic: null, answer: "The Mars datum is the reference level for elevation, a bit like sea level on Earth, except Mars has no ocean. Elevations are measured against it, so below the datum just means lower than that reference surface." },
  { pattern: /\baspect\b/i, topic: "terrain", answer: "Aspect is the compass direction the ground faces downhill. If the aspect is south, water would run toward the south." },
  { pattern: /\bsolar longitude\b/i, topic: null, answer: "Solar longitude marks the Martian season. Zero degrees is the start of northern spring, 90 is northern summer, 180 is northern autumn, and 270 is northern winter." },
  { pattern: /\b(tau|opacity)\b/i, topic: "climate", answer: "Dust opacity, called tau, measures how much dust blocks sunlight in the sky. Below 0.5 is a clear sky, around 1 is hazy, above 1 is dusty, and above 2 is dust storm level." },
  { pattern: /\b(relief|roughness)\b/i, topic: "terrain", answer: "Local relief is the difference between the highest and lowest ground in the surrounding few kilometers. Roughness describes how bumpy the surface is at a smaller scale. Both matter for wheels and for walking." },
  { pattern: /\bhirise\b/i, topic: null, answer: "HiRISE is a camera on NASA's Mars Reconnaissance Orbiter. It can pick out details only a few tens of centimeters across, but it covers just narrow strips of the planet." },
  { pattern: /\bctx\b/i, topic: null, answer: "CTX is the context camera on NASA's Mars Reconnaissance Orbiter. It sees about 6 meters per pixel and covers much more of Mars than HiRISE, which makes it good for the wider picture." },
  { pattern: /\b(mcd|climate database|climate model)\b/i, topic: "climate", answer: "The Mars Climate Database is a climate model built from many simulations and spacecraft observations. Its numbers describe typical conditions for a season and time of day. They are not live weather and not a forecast." },
  { pattern: /\b(noachian|hesperian|amazonian)\b/i, topic: "geology", answer: "Mars has three geologic eras. The Noachian was more than 3.7 billion years ago, the Hesperian ran from roughly 3.7 to 3 billion years ago, and the Amazonian runs from then until today." },
  { pattern: /\beva\b/i, topic: null, answer: "An EVA is an extravehicular activity, which means a crew member working outside the habitat or vehicle in a pressurized suit." },
];

const DEFINITION_CUE = /\b(what|define|definition|meaning|mean|means|explain|stand for)\b/i;

// ---------------------------------------------------------------------------
// Question analysis
// ---------------------------------------------------------------------------

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;
const firstSentence = (text) => (text.match(/^.*?[.!?](?=\s|$)/)?.[0] || text).trim();
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);
const isNum = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Whole-word match for short keywords (so "red" does not hit "reduce" and "air"
 * does not hit "fair"); prefix match for longer ones, which lets stems such as
 * "communicat" work.
 */
function keywordRegex(keyword) {
  const body = escapeRegExp(keyword);
  return new RegExp(keyword.length <= 4 ? `\\b${body}\\b` : `\\b${body}`, "i");
}

function findFacts(text, limit = 2) {
  return MARS_FACTS
    .map((fact) => ({
      fact,
      score: fact.keywords.reduce((sum, keyword) => sum + (keywordRegex(keyword).test(text) ? keyword.length : 0), 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.fact);
}

const GREETING_PATTERN = /\b(hi|hello|hey|hiya|good (morning|afternoon|evening)|greetings)\b/i;
const IDENTITY_PATTERN = /\b(who are you|what are you|your name|what can you do|help me|can you help)\b/i;
const THANKS_PATTERN = /\b(thanks|thank you|cheers)\b/i;

// Every way people ask for a vertical measurement. Missing one of these used to
// send "what is the height of Jezero" to a canned paragraph about Jezero.
const ELEVATION_PATTERN = /\b(elevations?|altitudes?|heights?|depths?|how (high|low|tall|deep)|deepest|highest|lowest|summit|(above|below) (the )?(sea level|datum|mars datum))\b/i;

// "here" / "this crater" -> the user means the selected place.
const HERE_PATTERN = /\b(here|this (place|spot|location|area|point|site|region|crater|volcano|plain|valley|mountain)|selected|where i am|around me)\b/i;
// "on Mars", "average", "in general" -> the user means the planet, not the pin.
const GENERAL_SCOPE_PATTERN = /\b(mars|martian|planet|average|in general|generally|typically|usually|earth|compared)\b/i;
const EXPLANATORY_PATTERN = /\b(why|how come|what causes|reason)\b/i;
const OVERVIEW_PATTERN = /\b(tell me about|about (this|here)|describe|overview|summar|what('s| is) (this|here)|where am i|what am i looking at)\b/i;
// Whole words only: "safely" and "landing" belong to general questions about
// how missions work, not to the pin on the map.
const SAFETY_PATTERN = /\b(safe|safety|dangerous|risky|hazards?|hazardous|walk|drive|traverse|passable)\b/i;
// Phrases that suggest the question is about the surroundings of the selection.
const LOCAL_CUE_PATTERN = /\b(nearby|around|close by|worth|interesting|special|look for|visit|explore|landing|land)\b/i;
// "Which is lower, Jezero or Gale?" asks for a measurement without naming one.
const COMPARE_PATTERN = /\b(compare|compared to|versus|vs|difference between|which (is|has|one is) (the )?(higher|lower|deeper|taller|colder|warmer|hotter|steeper|flatter|older|windier|dustier)|higher|lower|deeper|taller|colder|warmer|hotter|steeper|flatter|older|windier|dustier)\b/i;
const SHORT_QUESTION_WORDS = 8;
const LOCAL_QUESTION_WORDS = 12;

const TOPIC_PATTERNS = [
  { id: "weather", pattern: /\b(curiosity|rems|rover weather)\b/i },
  { id: "terrain", pattern: /\b(slope|steep|incline|gradient|grade|flat|level ground|rough|bumpy|relief|downhill|uphill|terrain|aspect|facing|face|faces|which way)\w*/i },
  { id: "surface", pattern: /\b(surface|footing|traction|sand|soil|dune|thermal inertia|loose|wheel|regolith|ground|crater rim)\w*/i },
  { id: "geology", pattern: /\b(geolog|rock|bedrock|how old|noachian|hesperian|amazonian|volcanic|formed)\w*/i },
  { id: "climate", pattern: /\b(temperature|cold|cool|hot|warm|freez|pressure|wind|breez|opacity|haze|humid|vapou?r|climate|weather|dust)\w*/i },
  { id: "sun", pattern: /\b(sun|sunlight|solar|daylight|sunrise|sunset|shadow)\w*/i },
];

const matchTopic = (text) => TOPIC_PATTERNS.find((topic) => topic.pattern.test(text))?.id || null;

function hasExplicitCoordinates(text) {
  return Boolean(extractCoordinates(text)) &&
    /(\d\s*°?\s*[nsew]\b)|\blat(itude)?\b|\blon(gitude)?\b|\d+\.\d+\s*[, ]\s*-?\d+\.\d+/i.test(text);
}

/**
 * Pulls a latitude/longitude pair out of free text such as
 * "18.4, 77.5", "18.4N 77.5E" or "lat -5.4 lon 137.8".
 */
function extractCoordinates(text) {
  const pattern = /(-?\d+(?:\.\d+)?)\s*°?\s*(north|south|east|west|[nsew])?\b/gi;
  const numbers = [];
  for (const match of text.matchAll(pattern)) {
    let value = Number(match[1]);
    const hemisphere = (match[2] || "").toLowerCase()[0];
    if (hemisphere === "s" || hemisphere === "w") value = -Math.abs(value);
    numbers.push(value);
    if (numbers.length === 2) break;
  }
  if (numbers.length < 2) return null;
  const [lat, lon] = numbers;
  return isValidCoordinate(lat, lon) ? { lat, lon } : null;
}

/**
 * Every place named in the text: aliases people type first, then the full
 * gazetteer. Entries within 10 km of one another are one place, so "Jezero"
 * does not appear twice.
 */
function findPlaces(text) {
  const places = [];
  const add = (place) => {
    if (places.some((existing) => distanceKm(existing.lat, existing.lon, place.lat, place.lon) < 10)) return;
    places.push(place);
  };
  const lower = text.toLowerCase();
  for (const alias of NAMED_PLACES) {
    if (alias.names.some((name) => keywordRegex(name).test(lower))) {
      add({ label: alias.label, lat: alias.lat, lon: alias.lon, type: null, diameterKm: null });
    }
  }
  for (const { feature } of findFeaturesInText(text)) {
    add({ label: feature.name, lat: feature.lat, lon: feature.lon, type: feature.type, diameterKm: feature.diameterKm });
  }
  return places.slice(0, 2);
}

/** True when a named place is, to within its own size, the one already selected. */
function isSelectedPlace(place, position) {
  if (!place || !position) return false;
  const radius = Math.max(8, (place.diameterKm || 0) / 2);
  return distanceKm(place.lat, place.lon, position.lat, position.lon) <= radius;
}

function analyse(text, selectionPosition) {
  const words = wordCount(text);
  const topic = matchTopic(text);
  const places = findPlaces(text);
  const coordinates = hasExplicitCoordinates(text) ? extractCoordinates(text) : null;
  // "Which is lower, Jezero or Gale?" is an elevation question too, but only
  // when a place is actually named ("lower my oxygen use" is not).
  const verticalCompare = /\b(higher|lower|deeper|taller)\b/i.test(text) && (places.length > 0 || Boolean(coordinates));
  const elevation = ELEVATION_PATTERN.test(text) || verticalCompare;
  const safety = SAFETY_PATTERN.test(text);
  const overviewRaw = OVERVIEW_PATTERN.test(text);
  const compare = COMPARE_PATTERN.test(text);
  return {
    text,
    words,
    topic,
    places,
    compare,
    // True when the answer should come from, or be checked against, measured data.
    measurement: elevation || Boolean(topic) || safety || overviewRaw || compare,
    selectedMentioned: places.some((place) => isSelectedPlace(place, selectionPosition)),
    otherPlaces: places.filter((place) => !isSelectedPlace(place, selectionPosition)),
    coordinates,
    elevation,
    safety,
    overviewRaw,
    aboutHere: HERE_PATTERN.test(text),
    generalScope: GENERAL_SCOPE_PATTERN.test(text),
    explanatory: EXPLANATORY_PATTERN.test(text),
    localCue: LOCAL_CUE_PATTERN.test(text),
    definitional: DEFINITION_CUE.test(text),
    glossary: GLOSSARY.find((entry) => entry.pattern.test(text)) || null,
    facts: findFacts(text),
  };
}

// ---------------------------------------------------------------------------
// Number / text formatting for speech
// ---------------------------------------------------------------------------

// No thousands separators: the TTS text frontend splits on commas.
const formatNumber = (value) => String(Math.round(value));

function describeCoordinate(lat, lon) {
  // Number(...) drops trailing zeros so TTS says "18.4", not "18.40".
  const latText = `${Number(Math.abs(lat).toFixed(2))} degrees ${lat >= 0 ? "north" : "south"}`;
  const lonText = `${Number(Math.abs(lon).toFixed(2))} degrees ${lon >= 0 ? "east" : "west"}`;
  return `${latText}, ${lonText}`;
}

function reply(source, intent, text, extra = {}) {
  return { source, intent, reply: text, speech: toSpeech(text), ...extra };
}

function suggestions(hasData) {
  return hasData
    ? "I can describe this place's terrain, surface, geology, climate and sunlight, explain map terms like thermal inertia, and answer questions about Mars."
    : "I can explain map terms like thermal inertia, look up the elevation and terrain of any named place or coordinates, and answer questions about Mars. Select a place on the map and I can describe it too.";
}

// ---------------------------------------------------------------------------
// Retrieval: which places is this question about, and what do we know of them
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Target
 * @property {"selected"|"named"|"coordinates"} kind
 * @property {string} label
 * @property {number} lat
 * @property {number} lon
 * @property {object|null} facts   measured data, or null when none could be loaded
 * @property {object} meta         what the gazetteer knows: type, diameterKm, lat, lon
 */

function selectedLabel(selection, facts) {
  return facts?.featureName || facts?.regionName || facts?.title || selection?.title || "the selected place";
}

async function resolveTargets(q, { selection, facts, hasData, aiAvailable }) {
  const wantsMeasurements = q.measurement;
  // With an AI to write the answer, every place the user names is looked up:
  // the model can use real numbers even when the question does not look
  // numeric ("which is better to land on, Jezero or Gale?"). Without one, a
  // lookup only pays off when the answer will actually quote a measurement.
  const shouldFetch = wantsMeasurements || aiAvailable;
  const targets = [];

  // Selected place: included when the question is plausibly about it.
  const namesOtherPlace = q.otherPlaces.length > 0 || Boolean(q.coordinates);
  const localQuestion =
    q.aboutHere ||
    ((wantsMeasurements || q.localCue) && q.words <= LOCAL_QUESTION_WORDS && !q.generalScope);
  if (selection && (q.selectedMentioned || (!namesOtherPlace && localQuestion))) {
    targets.push({
      kind: "selected",
      label: selectedLabel(selection, facts),
      lat: selection.lat,
      lon: selection.lon,
      facts: hasData ? facts : null,
      meta: { type: selection.feature?.type, diameterKm: selection.feature?.diameterKm, lat: selection.lat, lon: selection.lon },
    });
  }

  // Coordinates and named places: look the data up, since the browser only
  // loaded the selected place. Done in parallel; failures leave facts null.
  const lookups = [];
  if (q.coordinates) {
    lookups.push({ kind: "coordinates", label: describeCoordinate(q.coordinates.lat, q.coordinates.lon), ...q.coordinates, type: null, diameterKm: null });
  }
  for (const place of q.otherPlaces) lookups.push({ kind: "named", ...place });

  const fetched = await Promise.all(
    lookups.map((entry) =>
      shouldFetch
        ? fetchPlaceFacts({ lat: entry.lat, lon: entry.lon, name: entry.kind === "named" ? entry.label : null, type: entry.type, diameterKm: entry.diameterKm }).catch((error) => {
            console.error(`Ruby place lookup failed for ${entry.label}: ${error.message}`);
            return null;
          })
        : null,
    ),
  );
  lookups.forEach((entry, index) => {
    targets.push({
      kind: entry.kind,
      label: entry.label,
      lat: entry.lat,
      lon: entry.lon,
      facts: fetched[index],
      meta: { type: entry.type, diameterKm: entry.diameterKm, lat: entry.lat, lon: entry.lon },
    });
  });
  return targets;
}

// ---------------------------------------------------------------------------
// Exact (data-only) answers: used on their own for simple questions, and as the
// safety net whenever the AI is unavailable or fails the number check.
// ---------------------------------------------------------------------------

function whereClause(target) {
  if (target.kind === "coordinates") return target.label;
  if (target.kind === "named") return `the center of ${target.label}`;
  return target.label;
}

function elevationSentence(target, elevation) {
  const relation = elevation >= 0 ? "above" : "below";
  const base = `The elevation at ${whereClause(target)} is about ${formatNumber(Math.abs(elevation))} meters ${relation} the Mars datum.`;
  // A named feature is sampled at its catalogued center, which is not its
  // summit or floor. Say so, or "how tall is Olympus Mons" reads as a height.
  return target.kind === "named"
    ? `${base} That is the value at its catalogued center point, not necessarily its highest or lowest ground.`
    : base;
}

async function elevationFor(target) {
  if (isNum(target.facts?.elevationM)) return elevationSentence(target, target.facts.elevationM);
  if (!isNum(target.lat) || !isNum(target.lon)) return null;
  try {
    return elevationSentence(target, await sampleMarsElevation(target.lat, target.lon));
  } catch (error) {
    console.error("Ruby elevation lookup failed:", error.message);
    return null;
  }
}

// A narrower question gets just the sentence that answers it. "How windy is it"
// should say the wind speed, not recite the whole climate block.
const SUBTOPICS = [
  { topic: "climate", pattern: /\b(wind|windy|breez|gust)/i, keep: /\bwind\b/i },
  { topic: "climate", pattern: /\bpressure/i, keep: /pressure/i },
  { topic: "climate", pattern: /\b(dust|dusty|opacity|haze|hazy|sky)/i, keep: /opacity/i },
  { topic: "climate", pattern: /\b(humid|vapou?r|moist)/i, keep: /vapou?r/i },
  { topic: "climate", pattern: /\b(temperature|cold|cool|hot|warm|freez)/i, keep: /temperature/i },
  { topic: "terrain", pattern: /\b(steep|slope|gradient|incline|grade)/i, keep: /^The slope/i },
  { topic: "terrain", pattern: /\b(face|facing|aspect|downhill|which way|direction)/i, keep: /falls away/i },
  { topic: "terrain", pattern: /\b(rough|bumpy|relief|flat)/i, keep: /(elevation range|variation)/i },
  { topic: "surface", pattern: /\bdunes?\b/i, keep: /dunes/i },
  { topic: "surface", pattern: /\bcrater/i, keep: /crater/i },
  { topic: "surface", pattern: /\b(footing|traction|sandy|soft|loose|thermal inertia)/i, keep: /(thermal inertia|footing)/i },
];

// The data is climatology, not a live feed. Questions that ask for "now" need
// that said up front, otherwise a typical value sounds like a measurement.
const LIVE_PATTERN = /\b(right now|currently|current|today|tonight|live|at the moment|exact)\b/i;
const CLIMATE_CAVEAT = "These are climate model values for a typical season and time of day, not live weather.";

function narrowSection(topic, sectionText, question) {
  const sub = SUBTOPICS.find((entry) => entry.topic === topic && entry.pattern.test(question));
  if (!sub) return sectionText;
  const kept = sectionText.split(/(?<=[.!?])\s+/).filter((sentence) => sub.keep.test(sentence));
  return kept.length ? kept.join(" ") : sectionText;
}

/** Puts "At the center of X," in front, so a lookup for another place is not mistaken for the selected one. */
function attribute(target, text) {
  return target.kind === "selected" ? text : `At ${whereClause(target)}, ${lowerFirst(text)}`;
}

function answerLocationTopic(topic, target, question = "") {
  const section = narratePoint(target.facts).sections.find((entry) => entry.id === topic);
  if (section) {
    let text = narrowSection(topic, section.text, question);
    if (topic === "climate") {
      // Say it once: either as the answer to a "right now" question, or as the
      // standing caveat on any climate value.
      text = LIVE_PATTERN.test(question)
        ? `I don't have live weather for this spot, only the climate model's typical values. ${text}`
        : /\bmodel\b/i.test(text) ? text : `${text} ${CLIMATE_CAVEAT}`;
    }
    return reply("data", `location_${topic}`, attribute(target, text));
  }
  const label = { terrain: "terrain", surface: "surface", geology: "geology", climate: "climate", sun: "sunlight", weather: "rover weather" }[topic] || topic;
  const extra = topic === "weather" ? " Curiosity's weather station only reports for the area around Gale Crater." : "";
  return reply("data", `location_${topic}_missing`, `I do not have ${label} data for ${whereClause(target)}.${extra}`);
}

/** Terrain and surface facts combined, with an explicit refusal to certify. */
function answerSafety(target) {
  const sections = narratePoint(target.facts).sections;
  const pick = (id) => sections.find((section) => section.id === id)?.text;
  const factors = [pick("terrain"), pick("surface")].filter(Boolean).join(" ");
  const text = factors
    ? `${attribute(target, factors)} These are terrain estimates only, not a safety guarantee. For a real traverse, plan it in Route Planning.`
    : `I do not have terrain or surface data for ${whereClause(target)}, so I cannot say anything about how safe it is.`;
  return reply("data", "location_safety", text);
}

function answerOverview(target) {
  if (target.kind === "selected") {
    const narration = narratePoint(target.facts);
    return reply("data", "location_overview", `${narration.summary} Ask me about its terrain, surface, geology, climate or sunlight for more.`);
  }
  const typeWord = featureTypeWord(target.meta?.type);
  const size = isNum(target.meta?.diameterKm) && target.meta.diameterKm > 0
    ? ` about ${Number(target.meta.diameterKm.toFixed(target.meta.diameterKm < 100 ? 1 : 0))} kilometers across`
    : "";
  const intro = typeWord ? `${target.label} is a ${typeWord}${size}.` : `${target.label}${size ? ` is a feature${size}` : ""}.`;
  const elevation = isNum(target.facts?.elevationM) ? ` ${elevationSentence(target, target.facts.elevationM)}` : "";
  return reply("data", "place_overview", `${intro}${elevation} Ask me about its terrain, surface, geology, climate or sunlight for more.`);
}

function glossaryReply(q, primary) {
  let answer = q.glossary.answer;
  if (q.glossary.topic && primary?.kind === "selected" && primary.facts && !q.generalScope) {
    const section = narratePoint(primary.facts).sections.find((entry) => entry.id === q.glossary.topic);
    if (section) answer += ` At your selected location, ${lowerFirst(firstSentence(section.text))}`;
  }
  return reply("glossary", "glossary", answer);
}

function missingDataReply(target, selectionStatus) {
  if (target.kind === "selected") {
    return selectionStatus === "loading"
      ? reply("data", "location_loading", "The data for this location is still loading. Ask me again in a few seconds.")
      : reply("data", "location_unavailable", "I could not load data for this location, so I have nothing to tell you about it yet.");
  }
  return reply("data", "place_unavailable", `I could not load map data for ${whereClause(target)} just now. Please try again in a moment.`);
}

/**
 * Exact answer from the data alone, or null when the data cannot answer.
 * @param {ReturnType<typeof analyse>} q
 * @param {Target[]} targets
 */
async function exactAnswer(q, targets, { selectionStatus }) {
  const primary = targets[0] || null;

  // Elevation, for one place or two ("compare Jezero and Gale").
  if (q.elevation) {
    if (!primary) {
      return q.aboutHere
        ? reply("data", "elevation_needs_selection", "Select a place on the map first and I can tell you its elevation, or give me a named place or coordinates.")
        : reply("data", "elevation_needs_location", "I can check elevation for you. Tell me a latitude and longitude, like 18.4 north, 77.5 east, or name a place such as Jezero Crater.");
    }
    const sentences = (await Promise.all(targets.slice(0, 2).map(elevationFor))).filter(Boolean);
    if (sentences.length) {
      return reply("data", "elevation", sentences.join(" "), {
        data: { lat: primary.lat, lon: primary.lon, elevation: primary.facts?.elevationM ?? null, units: "m" },
      });
    }
    return missingDataReply(primary, selectionStatus);
  }

  // A definition of something the map shows.
  if (q.glossary && q.definitional && !(q.aboutHere && q.topic) && !q.explanatory) {
    return glossaryReply(q, primary);
  }

  // A measured property of a place.
  const wantsOverview = q.overviewRaw && !q.generalScope && q.words <= SHORT_QUESTION_WORDS;
  const wantsData = Boolean(q.topic) || q.safety || wantsOverview;
  if (primary && wantsData) {
    // A sentence that only mentions "this place" in passing is an open question
    // for the model, not a lookup.
    if (primary.kind === "selected" && !(q.aboutHere || q.words <= SHORT_QUESTION_WORDS)) return null;
    if (!primary.facts) return missingDataReply(primary, selectionStatus);
    if (wantsOverview && !q.topic) return answerOverview(primary);
    if (q.safety && !q.topic) return answerSafety(primary);
    const answer = answerLocationTopic(q.topic, primary, q.text);
    // The data says what the values are, not why. Say so rather than let
    // numbers pass as an explanation.
    return q.explanatory
      ? reply(answer.source, answer.intent, `I can't explain the reasons without my AI helper, but here is what the data says. ${answer.reply}`)
      : answer;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The AI model
// ---------------------------------------------------------------------------

function describeAiFailure(code) {
  switch (code) {
    case "unauthorized":
      return "My AI helper rejected its API key, so I can only use the map data right now.";
    case "no_credits":
      return "My AI helper's account is out of credits, so I can only use the map data right now.";
    case "rate_limited":
      return "I'm getting a lot of questions at once. Give me a minute and ask again.";
    default:
      return "I could not reach my AI helper just now.";
  }
}

/**
 * Has the model write the answer from the retrieved data.
 * @returns {Promise<object|null>} a reply, or null when the model's numbers could
 *   not be reconciled with the data (the caller then uses the exact answer)
 */
async function composeWithModel(q, targets, { history, selectionStatus }) {
  const places = targets.map(describeTarget).filter(Boolean);
  const references = [
    ...q.facts.map((fact) => fact.answer),
    ...(q.glossary ? [q.glossary.answer] : []),
  ];
  const measured = places.some((place) => place.hasMeasurements);
  // Figures are only policed for questions that are really about a measurement,
  // so general knowledge ("Mars has two moons") is never second-guessed.
  const checkNumbers = measured && q.measurement;

  const system = buildSystemPrompt({
    places,
    selectionStatus: places.length ? null : selectionStatus,
    references,
  });
  const turns = sanitizeHistory(history);
  // Two user turns in a row are rejected by some providers.
  if (turns.length && turns[turns.length - 1].role === "user") turns.pop();
  const messages = [...turns, { role: "user", content: q.text }];

  let result = await openrouter.chat({ system, messages });
  let answer = cleanModelText(result.text);
  if (!answer) throw new openrouter.OpenRouterError("empty", "The model returned only formatting.");

  if (checkNumbers) {
    const grounding = [...places.map((place) => place.block), ...references, q.text].join("\n");
    let offenders = findUngroundedNumbers(answer, grounding);
    if (offenders.length) {
      console.error(`Ruby model changed a figure (${offenders.join(", ")}); asking once more.`);
      try {
        result = await openrouter.chat({
          system,
          messages: [
            ...messages,
            { role: "assistant", content: answer },
            {
              role: "user",
              content: `These figures in your answer are not in the place data: ${offenders.join(", ")}. Rewrite the answer using only the numbers given in the place data, or leave the figure out.`,
            },
          ],
        });
        answer = cleanModelText(result.text);
        offenders = answer ? findUngroundedNumbers(answer, grounding) : ["(empty)"];
      } catch (error) {
        if (!(error instanceof openrouter.OpenRouterError)) throw error;
        offenders = ["(retry failed)"];
      }
      if (offenders.length) {
        console.error(`Ruby is using the exact data answer instead; still ungrounded: ${offenders.join(", ")}`);
        return null;
      }
    }
  }

  return reply(measured ? "hybrid" : "ai", measured ? "hybrid_answer" : "ai_answer", answer, {
    model: result.model,
    about: places[0]?.label || null,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Turns a user message into Ruby's reply.
 *
 * @param {string} message
 * @param {{selection?: object|null, history?: object[]}} [options]
 *   `selection` carries the /api/point and /api/cell payloads for the place the
 *   user has selected, plus its labels, exactly as the Explore panel holds them.
 * @returns {Promise<{source: string, intent: string, reply: string, speech: string,
 *                    model?: string, about?: string, data?: object, aiAvailable: boolean}>}
 */
async function askRuby(message, { selection = null, history = [] } = {}) {
  const text = message.trim();
  const aiAvailable = openrouter.status().configured;

  let facts = null;
  if (selection) {
    try {
      facts = extractPointFacts({ point: selection.point, cell: selection.cell }, selection);
    } catch (error) {
      console.error("Could not read the selected-location data:", error.message);
    }
  }
  const hasData = Boolean(facts && (facts.hasPoint || facts.hasCell));
  const selectionStatus = selection && !hasData ? (selection.status === "loading" ? "loading" : "failed") : null;

  const position = selection && isNum(selection.lat) && isNum(selection.lon) ? { lat: selection.lat, lon: selection.lon } : null;
  const q = analyse(text, position);

  const result = await decide(q, { selection, facts, hasData, selectionStatus, history, aiAvailable });
  return { ...result, aiAvailable };
}

async function decide(q, ctx) {
  const { selection, hasData, selectionStatus, history, aiAvailable } = ctx;

  // 1. Small talk, but only for short messages: "can you help me understand
  //    slope" is a question, not an introduction.
  if (q.words <= 6) {
    if (THANKS_PATTERN.test(q.text)) return reply("smalltalk", "thanks", "You're welcome. I'm here whenever you need me.");
    if (IDENTITY_PATTERN.test(q.text)) {
      const aiNote = aiAvailable
        ? " For anything beyond the map data I use an AI model, which can be wrong, so I say when an answer is general knowledge."
        : "";
      return reply("smalltalk", "identity", `I'm Ruby, your MarsWalk guide. ${suggestions(hasData)}${aiNote}`);
    }
    if (GREETING_PATTERN.test(q.text)) {
      return reply("smalltalk", "greeting", "Hello, I'm Ruby, your MarsWalk guide. Ask me about this place, a Mars term, or anything else you're curious about.");
    }
  }

  // 2. "Here" with nothing selected: nothing to retrieve, so say what is needed.
  if (q.aboutHere && !selection && !q.coordinates && q.places.length === 0 && q.measurement) {
    return reply("data", "needs_selection", "Select a place on the map first, then ask me about it.");
  }

  // 3. Retrieve.
  const targets = await resolveTargets(q, ctx);

  // 4. Compose with the model, using everything retrieved. Vetted facts and map
  //    term definitions go in as reference notes rather than being returned
  //    as canned text, so the answer is worded for the question that was asked.
  let aiError = null;
  if (aiAvailable) {
    try {
      const composed = await composeWithModel(q, targets, { history, selectionStatus });
      if (composed) return composed;
    } catch (error) {
      if (!(error instanceof openrouter.OpenRouterError)) throw error;
      aiError = error.code;
      console.error(`Ruby could not use the AI model: ${error.code}`);
    }
  }

  // 5. Exact answer from the data alone: used when there is no AI, when it is
  //    down, or when its numbers could not be reconciled with the data.
  const exact = await exactAnswer(q, targets, { selectionStatus });
  if (exact) return aiError ? { ...exact, aiError } : exact;

  // 6. A vetted fact beats a blank.
  if (q.facts.length) {
    const fact = reply("facts", "mars_fact", q.facts[0].answer);
    return aiError ? { ...fact, aiError } : fact;
  }

  // 7. Never blank.
  if (aiError) {
    return reply("fallback", "ai_unavailable", `${describeAiFailure(aiError)} ${suggestions(hasData)}`, { aiError });
  }
  return reply(
    "fallback",
    "no_answer",
    `That one isn't in the map data or my built-in answers, and my AI helper isn't connected yet. ${suggestions(hasData)}`,
  );
}

module.exports = { askRuby, extractCoordinates };
