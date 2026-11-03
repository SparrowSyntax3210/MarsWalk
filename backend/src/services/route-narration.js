// Turns a calculated route into speech-ready English.
//
// Hard rule: every number here is read from the planner's output or computed
// with the same formula the Mission Planner UI uses. Nothing is estimated,
// smoothed or inferred, so Ruby can never state a figure the screen disagrees
// with. Phrasing is templated rather than generated for the same reason.

// The planner reports total distance itself; per-cell positions are scaled to
// match it so "6 kilometres in" is always consistent with the stated total.
const MARS_RADIUS_KM = 3396.19; // matches adaptive_route_planner.py

const MODE_LABELS = { safest: "Safest", balanced: "Balanced", fastest: "Fast", custom: "Custom" };
const SNAP_WARN_KM = 0.5;

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(((bLon - aLon + 180) % 360 + 360) % 360 - 180);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Speech formatting. The TTS text frontend splits on commas, so numbers never
// carry thousands separators, and units are spelled out rather than abbreviated.
// ---------------------------------------------------------------------------

function speakDistance(km) {
  if (!isNum(km)) return null;
  if (km < 1) return `${Math.round(km * 1000)} meters`;
  // One decimal below 100 km so spoken distances match the on-screen figures.
  const rounded = km < 100 ? Number(km.toFixed(1)) : Math.round(km);
  return `${rounded} kilometers`;
}

function speakDuration(hours) {
  if (!isNum(hours) || hours <= 0) return null;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  const hourWord = whole === 1 ? "hour" : "hours";
  if (!minutes) return `${whole} ${hourWord}`;
  return `${whole} ${hourWord} ${minutes} minutes`;
}

// Gentle slopes need a decimal: rounding 0.2 degrees to "0 degrees" reads as
// though the value were missing.
function speakDegrees(deg) {
  if (!isNum(deg)) return null;
  const value = Number(deg.toFixed(deg < 10 ? 1 : 0));
  return `${value} ${value === 1 ? "degree" : "degrees"}`;
}

// Below this, slope is not worth describing cell by cell.
const FLAT_SLOPE_DEG = 1.0;

function joinList(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

/**
 * Cumulative along-route distance for each cell, rescaled so the final value
 * equals the planner's reported distance.
 */
function cumulativeDistances(cells, reportedTotalKm) {
  const cumulative = [0];
  for (let index = 1; index < cells.length; index += 1) {
    const previous = cells[index - 1];
    const current = cells[index];
    const step = haversineKm(previous.lat, previous.lon, current.lat, current.lon);
    cumulative.push(cumulative[index - 1] + (Number.isFinite(step) ? step : 0));
  }
  const measured = cumulative.at(-1) || 0;
  if (!isNum(reportedTotalKm) || reportedTotalKm <= 0 || measured <= 0) return cumulative;
  const scale = reportedTotalKm / measured;
  return cumulative.map((value) => value * scale);
}

/**
 * Groups consecutive non-safe cells into runs, so Ruby can say where the rough
 * ground actually is instead of only how many cells were flagged.
 */
function hazardRuns(cells, cumulative) {
  const runs = [];
  let current = null;
  cells.forEach((cell, index) => {
    const flagged = cell.class === "caution" || cell.class === "high";
    if (flagged) {
      const worst = cell.class === "high" ? "high" : "caution";
      if (!current) {
        current = { startKm: cumulative[index], endKm: cumulative[index], cells: 1, worst };
      } else {
        current.endKm = cumulative[index];
        current.cells += 1;
        if (worst === "high") current.worst = "high";
      }
    } else if (current) {
      runs.push(current);
      current = null;
    }
  });
  if (current) runs.push(current);
  const length = (run) => run.endKm - run.startKm;
  return runs.sort((a, b) => length(b) - length(a)); // longest first
}

/**
 * Pulls everything narratable out of a planner payload.
 *
 * @param {object} payload /api/route response (or the Mission Planner's
 *   synthetic payload for a user-drawn traverse)
 * @param {object} context UI-owned values: traverse assumptions, nearby place
 *   names, endpoint labels. All optional; narration degrades gracefully.
 */
function extractRouteFacts(payload, context = {}) {
  const metrics = payload?.metrics || {};
  const counts = payload?.terrain_assessment?.class_counts_on_route || {};
  const cells = Array.isArray(payload?.route_cell_details) ? payload.route_cell_details : [];
  const distanceKm = isNum(Number(metrics.distance_km)) ? Number(metrics.distance_km) : null;

  const classified = ["safe", "caution", "high", "unknown"].reduce(
    (total, key) => total + (Number(counts[key]) || 0),
    0,
  );

  // Mirror makeEstimate() in mission-planner.js exactly, so spoken and
  // on-screen figures cannot diverge.
  const speedKmh = Number(context.speedKmh);
  const hoursPerSol = Number(context.drivingHoursPerSol);
  const driveHours = distanceKm !== null && speedKmh > 0 ? distanceKm / speedKmh : null;
  const sols = driveHours !== null && hoursPerSol > 0 ? driveHours / hoursPerSol : null;

  const energyKwhPerKm = Number(context.energyKwhPerKm);
  const energyKwh =
    distanceKm !== null && Number.isFinite(energyKwhPerKm) && energyKwhPerKm >= 0
      ? distanceKm * energyKwhPerKm
      : null;
  const energyBudgetKwh = Number(context.energyBudgetKwh);
  const reservePct = Number(context.reservePct);
  const energyAvailableKwh =
    Number.isFinite(energyBudgetKwh) && Number.isFinite(reservePct)
      ? energyBudgetKwh * (1 - reservePct / 100)
      : null;

  const crewed = context.profile === "crewed";
  const crewSize = Number(context.crewSize);
  const oxygenRate = Number(context.oxygenKgPerPersonSol);
  const oxygenKg =
    crewed && sols !== null && crewSize > 0 && Number.isFinite(oxygenRate) && oxygenRate >= 0
      ? sols * crewSize * oxygenRate
      : null;
  const oxygenBudgetKg = Number(context.oxygenBudgetKg);

  const cumulative = cells.length ? cumulativeDistances(cells, distanceKm) : [];
  const runs = cells.length ? hazardRuns(cells, cumulative) : [];

  // Where the single steepest cell sits along the traverse.
  let steepest = null;
  cells.forEach((cell, index) => {
    const slope = Number(cell.slope_deg);
    if (!isNum(slope)) return;
    if (!steepest || slope > steepest.slopeDeg) {
      steepest = { slopeDeg: slope, atKm: cumulative[index], className: cell.class };
    }
  });

  const snapped = ["start", "end"]
    .map((key) => ({ key, km: Number(payload?.endpoints?.[key]?.snap_distance_km) }))
    .filter((entry) => isNum(entry.km) && entry.km > SNAP_WARN_KM);

  const terrain = payload?.terrain_data || {};
  const nearby = Array.isArray(context.nearbyFeatures)
    ? context.nearbyFeatures.filter((name) => typeof name === "string" && name.trim()).slice(0, 4)
    : [];

  return {
    mode: payload?.mode || context.mode || null,
    modeLabel: MODE_LABELS[payload?.mode || context.mode] || null,
    startName: context.startName || null,
    endName: context.endName || null,
    distanceKm,
    maxSlopeDeg: isNum(Number(metrics.max_slope_deg)) ? Number(metrics.max_slope_deg) : null,
    meanSlopeDeg: isNum(Number(metrics.mean_slope_deg)) ? Number(metrics.mean_slope_deg) : null,
    maxRoughnessM: isNum(Number(metrics.max_roughness_rms_m)) ? Number(metrics.max_roughness_rms_m) : null,
    meanRisk: isNum(Number(metrics.mean_terrain_risk_0_to_1)) ? Number(metrics.mean_terrain_risk_0_to_1) : null,
    counts: {
      safe: Number(counts.safe) || 0,
      caution: Number(counts.caution) || 0,
      high: Number(counts.high) || 0,
      unknown: Number(counts.unknown) || 0,
      classified,
    },
    hazardRuns: runs.slice(0, 2),
    steepest,
    snapped,
    terrainSource: {
      status: terrain.status || null,
      instrument: terrain.instrument || null,
      routeGridM: isNum(Number(terrain.route_grid_m)) ? Number(terrain.route_grid_m) : null,
      fallbackReason: terrain.fallback_reason || null,
    },
    visionRequested: Boolean(payload?.vision_model?.requested),
    visionStatus: payload?.vision_model?.status || null,
    nearby,
    // Optional mission limits. Only those supplied get checked, so the route
    // view (which has no limits) simply gets no warnings.
    limits: {
      maxSols: isNum(Number(context.maxSols)) ? Number(context.maxSols) : null,
      maxDistanceKm: isNum(Number(context.maxDistanceKm)) ? Number(context.maxDistanceKm) : null,
      maxSlopeDeg: isNum(Number(context.maxSlopeDeg)) ? Number(context.maxSlopeDeg) : null,
      roughnessLimitM: isNum(Number(context.roughnessLimitM)) ? Number(context.roughnessLimitM) : null,
    },
    estimates: {
      driveHours,
      sols,
      energyKwh,
      energyAvailableKwh,
      oxygenKg,
      oxygenBudgetKg: Number.isFinite(oxygenBudgetKg) ? oxygenBudgetKg : null,
      assumedSpeedKmh: speedKmh > 0 ? speedKmh : null,
      assumedHoursPerSol: hoursPerSol > 0 ? hoursPerSol : null,
      crewed,
    },
  };
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

// Position along the route, phrased for speech. Near the ends, a distance
// reads oddly ("about 0 meters in"), so name the endpoint instead.
function describePosition(atKm, totalKm) {
  if (!isNum(atKm)) return null;
  if (!isNum(totalKm) || totalKm <= 0) return `about ${speakDistance(atKm)} in`;
  const fraction = atKm / totalKm;
  if (fraction <= 0.02) return "right at the start";
  if (fraction >= 0.98) return "right at the destination";
  return `about ${speakDistance(atKm)} in`;
}

function describeHazardRun(run, totalKm) {
  const lengthKm = run.endKm - run.startKm;
  const where = describePosition(run.startKm, totalKm);
  // A single flagged cell has no meaningful extent; give its position only.
  if (lengthKm <= 0.05) return where ? `a short patch ${where}` : "a short patch";
  return where ? `${speakDistance(lengthKm)} ${where}` : speakDistance(lengthKm);
}

function overviewSentence(facts) {
  const where =
    facts.startName && facts.endName
      ? ` from ${facts.startName} to ${facts.endName}`
      : "";
  const label = facts.modeLabel ? `${facts.modeLabel} route` : "This route";
  const distance = speakDistance(facts.distanceKm);
  if (!distance) return `${label}${where}. The planner did not report a distance.`;
  return `${label}${where} is ${distance}.`;
}

function timeSentence(facts) {
  const { driveHours, sols, assumedSpeedKmh } = facts.estimates;
  const duration = speakDuration(driveHours);
  if (!duration) return null;
  const solPart = isNum(sols) ? `, about ${Number(sols.toFixed(1))} sols` : "";
  // Flagged as an assumption: this is arithmetic on a speed you entered, not a
  // rover performance prediction.
  return `At your assumed ${assumedSpeedKmh} kilometers per hour that is ${duration} of driving${solPart}.`;
}

function terrainSentence(facts) {
  if (!isNum(facts.maxSlopeDeg)) return null;

  // On near-level ground, naming a "steepest point" implies a feature that is
  // not really there.
  if (facts.maxSlopeDeg < FLAT_SLOPE_DEG) {
    return `The ground is essentially level, staying under ${speakDegrees(FLAT_SLOPE_DEG)} the whole way.`;
  }

  const sentences = [
    isNum(facts.meanSlopeDeg)
      ? `Slope averages ${speakDegrees(facts.meanSlopeDeg)} and peaks at ${speakDegrees(facts.maxSlopeDeg)}.`
      : `Maximum slope is ${speakDegrees(facts.maxSlopeDeg)}.`,
  ];
  if (facts.steepest && isNum(facts.distanceKm) && facts.distanceKm > 1) {
    const where = describePosition(facts.steepest.atKm, facts.distanceKm);
    if (where) sentences.push(`The steepest point is ${where}.`);
  }
  return sentences.join(" ");
}

/**
 * Limits the route breaks. Computed with the same formulas as makeEstimate()
 * in mission-planner.js, so a spoken warning always agrees with the screen.
 * Only budgets actually supplied in the context are checked.
 */
function limitWarnings(facts) {
  const { estimates, limits } = facts;
  const breaches = [];

  if (isNum(estimates.oxygenKg) && isNum(estimates.oxygenBudgetKg) && estimates.oxygenKg > estimates.oxygenBudgetKg) {
    const over = estimates.oxygenKg - estimates.oxygenBudgetKg;
    breaches.push(
      `the oxygen allowance of ${Number(estimates.oxygenKg.toFixed(1))} kilograms exceeds your ${Number(estimates.oxygenBudgetKg.toFixed(1))} kilogram budget by ${Number(over.toFixed(1))}`,
    );
  }
  if (isNum(estimates.energyKwh) && isNum(estimates.energyAvailableKwh) && estimates.energyKwh > estimates.energyAvailableKwh) {
    const over = estimates.energyKwh - estimates.energyAvailableKwh;
    breaches.push(
      `driving energy of ${Number(estimates.energyKwh.toFixed(1))} kilowatt hours exceeds the ${Number(estimates.energyAvailableKwh.toFixed(1))} available after reserve by ${Number(over.toFixed(1))}`,
    );
  }
  if (isNum(estimates.sols) && isNum(limits.maxSols) && estimates.sols > limits.maxSols) {
    breaches.push(
      `the schedule of ${Number(estimates.sols.toFixed(1))} sols exceeds your ${limits.maxSols} sol limit`,
    );
  }
  if (isNum(facts.distanceKm) && isNum(limits.maxDistanceKm) && facts.distanceKm > limits.maxDistanceKm) {
    breaches.push(`the distance exceeds your ${limits.maxDistanceKm} kilometer limit`);
  }
  if (isNum(facts.maxSlopeDeg) && isNum(limits.maxSlopeDeg) && facts.maxSlopeDeg > limits.maxSlopeDeg) {
    breaches.push(
      `the maximum slope of ${speakDegrees(facts.maxSlopeDeg)} exceeds your ${limits.maxSlopeDeg} degree limit`,
    );
  }
  if (isNum(facts.maxRoughnessM) && isNum(limits.roughnessLimitM) && facts.maxRoughnessM > limits.roughnessLimitM) {
    breaches.push(
      `roughness of ${Number(facts.maxRoughnessM.toFixed(1))} meters exceeds your ${limits.roughnessLimitM} meter review limit`,
    );
  }

  if (!breaches.length) return null;
  const lead = breaches.length === 1 ? "One thing needs attention:" : "Some things need attention:";
  return `${lead} ${joinList(breaches)}.`;
}

function hazardSentence(facts) {
  const { safe, caution, high, unknown, classified } = facts.counts;
  if (!classified) return null;

  if (!caution && !high && !unknown) {
    return `All ${safe} route cells are classed safe.`;
  }

  const flagged = [];
  if (caution) flagged.push(`${caution} are caution`);
  if (high) flagged.push(`${high} are high cost`);
  if (unknown) flagged.push(`${unknown} are unclassified`);
  const head = `Of ${classified} route cells, ${joinList(flagged)}.`;

  if (!facts.hazardRuns.length) return head;
  const [longest, second] = facts.hazardRuns;
  const label = longest.worst === "high" ? "high cost" : "caution";
  let where = `The longest ${label} stretch is ${describeHazardRun(longest, facts.distanceKm)}.`;
  if (second) {
    where += ` There is another ${describeHazardRun(second, facts.distanceKm)}.`;
  }
  return `${head} ${where}`;
}

function nearbySentence(facts) {
  if (!facts.nearby.length) return null;
  const verb = facts.nearby.length === 1 ? "feature" : "features";
  return `You pass named ${verb}: ${joinList(facts.nearby)}.`;
}

// Figures that are within budget. Anything over budget is omitted here because
// limitWarnings already states it, with the shortfall.
function consumablesSentence(facts) {
  const { energyKwh, energyAvailableKwh, oxygenKg, oxygenBudgetKg, crewed } = facts.estimates;
  const parts = [];

  const energyOver = isNum(energyKwh) && isNum(energyAvailableKwh) && energyKwh > energyAvailableKwh;
  if (isNum(energyKwh) && !energyOver) {
    const budget = isNum(energyAvailableKwh)
      ? ` of ${Number(energyAvailableKwh.toFixed(1))} available after reserve`
      : "";
    parts.push(`driving energy works out to ${Number(energyKwh.toFixed(1))} kilowatt hours${budget}`);
  }

  const oxygenOver = isNum(oxygenKg) && isNum(oxygenBudgetKg) && oxygenKg > oxygenBudgetKg;
  if (crewed && isNum(oxygenKg) && !oxygenOver) {
    const budget = isNum(oxygenBudgetKg)
      ? ` of the ${Number(oxygenBudgetKg.toFixed(1))} kilograms you budgeted`
      : "";
    parts.push(`the oxygen allowance is ${Number(oxygenKg.toFixed(1))} kilograms${budget}`);
  }

  if (!parts.length) return null;
  const sentence = joinList(parts);
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * Caveats Ruby must volunteer. These exist because the underlying numbers are
 * either user assumptions or coarse data, and a confident voice makes it very
 * easy to forget that.
 */
function cautionSentences(facts) {
  const sentences = [];

  if (facts.snapped.length) {
    const moved = facts.snapped.map(
      (entry) =>
        `the ${entry.key === "start" ? "start" : "destination"} moved ${speakDistance(entry.km)}`,
    );
    sentences.push(`Note that ${joinList(moved)} to reach passable ground.`);
  }

  if (facts.terrainSource.fallbackReason) {
    sentences.push(
      "Higher resolution terrain rejected an endpoint, so this used the coarse one kilometer grid.",
    );
  } else if (facts.terrainSource.status === "global_fallback") {
    sentences.push(
      "This route came from the global one kilometer grid, so it cannot show obstacles smaller than that.",
    );
  } else if (facts.terrainSource.instrument && isNum(facts.terrainSource.routeGridM)) {
    sentences.push(
      `Terrain came from ${facts.terrainSource.instrument} data on a ${Math.round(facts.terrainSource.routeGridM)} meter grid.`,
    );
  }

  if (facts.visionRequested && facts.visionStatus && !facts.visionStatus.startsWith("used_")) {
    sentences.push("The experimental vision hazard layer was not available for this area.");
  }

  if (isNum(facts.estimates.driveHours)) {
    sentences.push(
      "Time, energy and oxygen are arithmetic on the assumptions you entered, not predictions of how the vehicle will perform.",
    );
  }
  return sentences;
}

/**
 * Builds the spoken route briefing.
 *
 * @returns {{summary: string, detail: string, text: string}} `summary` is short
 *   enough to speak immediately; `detail` holds the rest so the caller can
 *   decide how much to read aloud.
 */
function narrateRoute(facts) {
  // A blown budget is the headline, not a footnote, so it goes in the short
  // part that always gets spoken.
  const warnings = limitWarnings(facts);
  const summary = [
    overviewSentence(facts),
    warnings,
    timeSentence(facts),
    hazardSentence(facts),
  ]
    .filter(Boolean)
    .join(" ");

  const detail = [
    terrainSentence(facts),
    nearbySentence(facts),
    consumablesSentence(facts),
    ...cautionSentences(facts),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    summary,
    detail,
    warnings: warnings || null,
    text: [summary, detail].filter(Boolean).join(" "),
  };
}

module.exports = { extractRouteFacts, narrateRoute };
